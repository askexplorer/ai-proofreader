// Offline test for the v5.4.0 fixes of the translation check (tc-core.js), found when a translator rejected most findings of a literary check:
//  1. a finding judged on a FRAGMENT of the source ("...six decades of service" without "have taught me") is double-checked against the full text and dropped when its claim is false
//  2. a proposed wording that loses meaning, is a calque or a false friend is withdrawn after the double-check (the finding stays)
//  3. a proposed wording that would repeat a word in the same or neighbouring sentence is withdrawn without any model call
//  4. an unsure claim is softened (Major -> Query), a double-check that fails changes nothing
//  5. a second look by the SAME model cannot add Minor findings by itself (it confirms nothing)
//  6. a missing sentence and a meaning finding about the same source paragraph are ONE finding
//  7. the literary-text instruction and the new rules for "fix" reach the prompts
// Run: node tests/tc-literary.test.mjs   (Node 18+). Invented text only: the repo is public, client text never goes in tests.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
new Function(readFileSync(process.env.TC_CORE || path.join(root, 'tc-core.js'), 'utf8'))();
const TC = globalThis.TC;
let pass = 0, fail = 0;
const ok = (c, n, x) => { if (c) pass++; else { fail++; console.log('FAIL  ' + n + (x ? '  ' + x : '')); } };
const doc = (txt, lang) => Object.assign({ paras: TC.parasFromText(txt), lang }, TC.docStats(TC.parasFromText(txt)));

const EN = [
  'These are words drawn from what experience, life and six decades of service have taught me.',
  'I admire your effort every day. Your persistence deserves respect.',
  'The keeper never left the rock. He never left it alone.',
  'The fleet carried tens of thousands of lamps.',
  'The sea was calm that night.',
].join('\n\n');
const ES = [
  'Estas son palabras nacidas de la experiencia, de la vida y de las lecciones de seis decadas de servicio.',
  'Admiro tu esfuerzo cada dia. Tu constancia merece respeto.',
  'El farero nunca abandono la roca. Nunca dejo la roca sola.',
  'La flota llevaba decenas de miles de lamparas.',
  'El mar estaba en calma aquella noche.',
].join('\n\n');
const src = doc(EN, 'English'), tgt = doc(ES, 'Spanish'), plan = TC.planWindows(src, tgt, {});
ok(plan.windows.length === 1 && src.paras.length === 5 && tgt.paras.length === 5, 'the story is one window of 5 + 5 paragraphs');

// ---------- fakes ----------
const log = { systems: [], recheck: [], recheckSys: [] };
let recheckFails = false;
const add = (o) => Object.assign({ type: 'Mistranslation', severity: 'Minor', fix: '', why: 'x', term_s: '', term_t: '' }, o);
async function callMain(system, user, meta) {
  log.systems.push(system);
  if (meta.kind === 'recheck') {
    if (recheckFails) throw new Error('upstream failure');
    log.recheck.push(user); log.recheckSys.push(system);
    const checks = [...user.matchAll(/^(\d+)\. \[(.*?)\] source words: "(.*?)" \| translation words: "(.*?)" \| proposed wording: "(.*?)" \| reason: (.*)$/gm)].map((m) => {
      const fix = m[5], why = m[6]; let claim = 'true', fx = fix ? 'ok' : 'none', note = '';
      if (/lecciones/.test(why) && /have taught me/.test(user)) { claim = 'false'; note = 'The source continues with "have taught me".'; }       // the fake "reads" the full source
      if (/cientos/.test(fix)) { fx = 'bad'; note = 'It changes the number.'; }
      if (/missing/.test(why) && /calm/.test(m[3])) claim = 'unsure';
      return { id: +m[1], claim, fix: fx, note };
    });
    return { text: JSON.stringify({ checks }), inTok: 100, outTok: 20 };
  }
  if (meta.kind === 'meaning') return callSecond(system, user, meta);
  if (meta.kind === 'verify') return { text: JSON.stringify({ verdicts: [] }), inTok: 10, outTok: 5 };
  const alignment = [1, 2, 3, 4, 5].map((i) => i + '|' + i);
  const issues = [
    add({ severity: 'Minor', s: [2], t: [2], source: 'Your persistence', target: 'Tu constancia', fix: 'tu esfuerzo', why: 'A slightly different word.' }),                        // B: repeats "esfuerzo"
    add({ severity: 'Major', s: [3], t: [3], source: 'He never left it alone', target: 'Nunca dejo la roca sola', fix: 'Nunca abandono la roca sola', why: 'The verb is different.' }),   // C: repeats "abandono"
    add({ severity: 'Major', s: [4], t: [4], source: 'tens of thousands of lamps', target: 'decenas de miles de lamparas', fix: 'cientos de lamparas', why: 'The quantity is wrong.' }),         // D: bad wording
    add({ severity: 'Major', s: [5], t: [5], source: 'The sea was calm', target: 'El mar estaba en calma', fix: '', why: 'The word "calm" is missing from the translation.' }),                       // E: unsure claim
  ];
  return { text: JSON.stringify({ alignment, issues }), inTok: 1000, outTok: 200 };
}
async function callSecond(system, user) {
  log.systems.push(system);
  const pairs = [...user.matchAll(/\[P(\d+)\]\nSOURCE: (.*)\nTRANSLATION: (.*)/g)].map((m) => ({ p: +m[1], s: m[2], t: m[3] }));
  const differs = [];
  pairs.forEach((pr) => {                                                                                                                  // A: the "have taught me" case (found by the second look only)
    if (pr.s.startsWith('These are words')) differs.push({ p: pr.p, type: 'Mistranslation', severity: 'Minor', source: 'experience, life and six decades of service', target: 'de la experiencia, de la vida y de las lecciones de seis decadas de servicio', fix: 'de la experiencia, de la vida y de seis decadas de servicio', why: 'The translation adds "lecciones" which is not present in the source.' });
  });
  const same = pairs.filter((pr) => !differs.some((d) => d.p === pr.p)).map((pr) => pr.p);
  return { text: JSON.stringify({ same: same.join(','), differs }), inTok: 300, outTok: 40 };
}
async function run(ctx) {
  log.systems.length = 0; log.recheck.length = 0; log.recheckSys.length = 0;
  const state = await TC.checkWindows(plan, src, tgt, Object.assign({ callModel: callMain, callModelSecond: callSecond, second: true, strict: 'all', srcLang: 'English', tgtLang: 'Spanish' }, ctx || {}));
  return { state, rep: TC.buildReport(plan, src, tgt, state, {}) };
}
const byText = (rep, re) => rep.issues.find((x) => re.test(x.srcText + ' ' + x.srcContext));

// ---------- 1. the "have taught me" case: a claim made on a fragment ----------
const a = await run();
ok(log.recheck.length === 1, 'the findings are double-checked in one extra call per part', String(log.recheck.length));
ok(/FRAGMENT/.test(log.recheckSys[0]) && /false friend/.test(log.recheckSys[0]) && /SIX DECADES|six decades of public service/i.test(log.recheckSys[0]), 'the double-check is told that quotes are fragments and to read the whole sentence');
ok(/FULL SOURCE:[^]*have taught me/.test(log.recheck[0]) && /FULL TRANSLATION:/.test(log.recheck[0]), 'the double-check gets the FULL source and translation, not only the quote');
ok(!byText(a.rep, /six decades/), 'the false "addition" is dropped: the source continues with "have taught me"', JSON.stringify(a.rep.issues.map((x) => x.srcText)));
ok(a.rep.coverage.dropped >= 1, 'it is counted among the false alarms removed', String(a.rep.coverage.dropped));

// ---------- 2. a bad wording is withdrawn, the finding stays ----------
const d = byText(a.rep, /tens of thousands/);
ok(d && d.severity === 'Major' && d.fix === '' && /withdrawn after a double-check/.test(d.why) && /changes the number/i.test(d.why), 'a wording that changes the number is withdrawn, the Major finding stays and says why', d && JSON.stringify([d.severity, d.fix, d.why]));

// ---------- 3. a wording that would repeat a word is withdrawn (no model call needed) ----------
const b = byText(a.rep, /persistence/), c = byText(a.rep, /never left it alone/);
ok(b && b.fix === '' && b.severity === 'Note' && b.was === 'Minor' && /repeat the word "esfuerzo"/.test(b.why), 'a Minor finding whose wording repeats "esfuerzo" becomes a quiet Note without the wording', b && JSON.stringify([b.severity, b.fix, b.was, b.why]));
ok(c && c.fix === '' && c.severity === 'Major' && /repeat the word "abandono"/.test(c.why), 'a Major finding keeps its place but loses a wording that repeats "abandono"', c && JSON.stringify([c.severity, c.fix, c.why]));

// ---------- 4. unsure claims soften; a failing double-check changes nothing ----------
const e = byText(a.rep, /sea was calm/);
ok(e && e.severity === 'Query' && e.verified === 'unsure', 'a claim the double-check is unsure about becomes a Query', e && JSON.stringify([e.severity, e.verified]));
recheckFails = true; const f = await run(); recheckFails = false;
ok(!!byText(f.rep, /six decades/) && byText(f.rep, /tens of thousands/).fix === 'cientos de lamparas' && byText(f.rep, /sea was calm/).severity === 'Major', 'if the double-check fails everything stays exactly as the model said (nothing is hidden)');

// ---------- 5. a second look by the same model confirms nothing ----------
recheckFails = true;
const same = await run({ secondSameModel: true }), other = await run({ secondSameModel: false });
recheckFails = false;
const sa = byText(same.rep, /six decades/), oa = byText(other.rep, /six decades/);
ok(sa && sa.severity === 'Note' && sa.unconfirmed === true && sa.was === 'Minor', 'same model twice: a Minor finding only the second look made becomes a quiet Note', sa && JSON.stringify([sa.severity, sa.unconfirmed]));
ok(oa && oa.severity === 'Minor' && !oa.unconfirmed, 'a different model for the second look: the Minor finding stays', oa && oa.severity);
ok(byText(same.rep, /tens of thousands/).severity === 'Major', 'the first check\'s own Major findings are not touched by that rule');

// ---------- 6. repeatRisk, on its own ----------
const rr = TC.repeatRisk;
ok(rr('Admiro tu esfuerzo cada dia. Tu constancia merece respeto.', 'Tu constancia', 'tu esfuerzo') === 'esfuerzo', 'repeatRisk: the wording would repeat a word of the neighbouring sentence');
ok(rr('Admiro tu esfuerzo cada dia. Tu constancia merece respeto.', 'Tu constancia', 'tu dedicacion') === '', 'repeatRisk: a fresh word is fine');
ok(rr('Siempre confia, confia siempre en el camino.', 'en el camino', 'por el sendero') === '', 'repeatRisk: a word that was already repeated is not blamed on a wording that adds nothing');
ok(rr('El corazon late. El corazon calla. El resto es silencio.', 'El resto', 'la calma') === '' && rr('El corazon late. El corazon calla. El resto es silencio.', 'El resto', 'el corazon') === 'corazon', 'repeatRisk: a wording that adds nothing is fine, one that makes a word appear once more is flagged');
ok(rr('Una frase corta.', 'no esta', 'algo nuevo') === '' && rr('', 'a', 'b') === '' && rr('x', '', 'b') === '', 'repeatRisk: quote not found / nothing to compare gives no verdict');
ok(rr('Alpha beta gamma. Delta epsilon zeta.', 'gamma', 'ellos y epsilon') === 'epsilon' && rr('Una vez mas, la luz de la ciudad se apaga.', 'la luz', 'las luces') === '', 'repeatRisk: words under 5 letters and endings are ignored');

// ---------- 7. a missing sentence and a meaning finding on the same paragraph are ONE finding ----------
const mk = (o) => Object.assign({ type: 'Mistranslation', severity: 'Query', origin: 'ai', chapter: 12, srcLoc: 'Ch 12 ¶10', tgtLoc: 'Ch 12 ¶9', page: 40, srcText: 'Your compass is still with us: in building projects, welcoming dreamers and developing services.', srcContext: '', tgtText: '', tgtContext: '', fix: '', why: 'x', insert: false, sIdx: [420], tIdx: [422], second: null, termS: '', termT: '', partial: false }, o);
const om = mk({ type: 'Omission', severity: 'Critical', insert: true, tgtLoc: 'after Ch 12 ¶8', tIdx: [421], why: 'The entire sentence is absent from the translation.' });
const mt = mk({ origin: 'ai2', sIdx: [419, 420], tIdx: [422, 423], tgtLoc: 'Ch 12 ¶9, ¶10', tgtText: 'Tu brujula sigue con nosotros', why: 'The final sentence of the source paragraph is entirely absent.' });
const other2 = mk({ sIdx: [430], srcText: 'A different sentence altogether about harbours.', why: 'A different word.' });
const merged = TC.refineIssues([om, mt, other2], { windows: [] }, { results: [] });
ok(merged.length === 2 && merged.includes(om) && merged.includes(other2), 'omission + meaning finding on the same source paragraph: one finding left (the omission)', merged.length + '');
ok(om.severity === 'Critical' && om.second === 'agrees' && /Also seen as a meaning problem at Ch 12/.test(om.why), 'the merged finding keeps Critical, says two looks agree and points to the other place', JSON.stringify([om.severity, om.second, om.why]));
const apart = TC.refineIssues([mk({ type: 'Omission', severity: 'Critical', insert: true, sIdx: [500], tIdx: [501], srcText: 'Another missing sentence.', why: 'Absent.' }), mk({ sIdx: [510], srcText: 'Unrelated.', why: 'Different.' })], { windows: [] }, { results: [] });
ok(apart.length === 2, 'findings about different source paragraphs are never merged');

// ---------- 8. the literary instruction and the new rules reach the prompts ----------
ok(TC.calibration({ literary: true, strict: 'facts' }).includes('LITERARY TEXT') && /synonym/.test(TC.calibration({ literary: true })) && /repeated word or pronoun/.test(TC.calibration({ literary: true })), 'calibration: the literary text block names synonyms and avoided repetition as normal choices');
ok(!TC.calibration({ strict: 'facts' }).includes('LITERARY TEXT'), 'calibration: no literary block unless asked for');
await run({ literary: true });
const sysLit = log.systems.join('\n'); await run({ literary: false }); const sysPlain = log.systems.join('\n');
ok(/LITERARY TEXT/.test(sysLit) && !/LITERARY TEXT/.test(sysPlain), 'the literary block is in the prompts of the run only when chosen');
ok(/Give a fix ONLY when you are sure/.test(sysPlain) && /false friend/.test(sysPlain) && /must not repeat a word/.test(sysPlain), 'the main prompt tells the model to give a fix only when sure, no calque, no repeated word');
ok(/only when you are sure it is natural/.test(sysPlain), 'the second-look prompt carries the same rule for its fixes');
ok(TC.estimateRun(plan, {}).calls >= 2, 'the estimate counts the extra double-check call');

console.log(`${fail ? 'FAILED' : 'OK'}: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
