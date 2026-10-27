// Translation-check engine test (tc-core.js). Self-contained: builds a sample book, a pseudo-translation of it
// with known defects, and runs the engine against a fake model that also misbehaves on purpose.
// Run:  node tests/tc-core.test.mjs
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
const here = dirname(fileURLToPath(import.meta.url));
await import(pathToFileURL(join(here, '..', 'tc-core.js')).href);
const TC = globalThis.TC;
let pass = 0, fail = 0;
const t = (name, cond, extra = '') => { cond ? pass++ : (fail++, console.log('FAIL  ' + name + '  ' + extra)); };

// ---------- a generated 30-chapter sample book (seeded, so every run is identical) ----------
let seed = 20260101; const rnd = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296;
const W = 'the people of our city built a long road across the river and every morning the old traders met at the harbour to talk about weather prices and journeys while children ran between the market stalls carrying bread water and news from distant villages'.split(' ');
const sentence = () => { const n = 6 + Math.floor(rnd() * 12); const w = []; for (let i = 0; i < n; i++) w.push(W[Math.floor(rnd() * W.length)]); let s = w.join(' '); if (rnd() < 0.25) s += ' in ' + (1900 + Math.floor(rnd() * 120)); return s.charAt(0).toUpperCase() + s.slice(1) + '.'; };
const para = () => { const n = 2 + Math.floor(rnd() * 4); const s = []; for (let i = 0; i < n; i++) s.push(sentence()); return s.join(' '); };
const lines = ['My Sample Book', 'First Edition 2024. All rights reserved. ISBN 978-1-00000-000-0', 'Contents'];
for (let c = 1; c <= 30; c++) lines.push(String(c).padStart(2, '0') + '\tChapter title ' + c + '\t' + (8 + c * 6));        // table of contents
for (let c = 1; c <= 30; c++) { lines.push(String(c).padStart(2, '0')); lines.push('The story of chapter ' + c); const n = 10 + Math.floor(rnd() * 14); for (let k = 0; k < n; k++) lines.push(para()); }
const en = TC.parasFromText(lines.join('\n'));
const MAP = { a:'а', b:'б', c:'ц', d:'д', e:'е', f:'ф', g:'г', h:'х', i:'и', j:'ж', k:'к', l:'л', m:'м', n:'н', o:'о', p:'п', q:'к', r:'р', s:'с', t:'т', u:'у', v:'в', w:'в', x:'кс', y:'й', z:'з' };
const fwd = (s) => s.replace(/[a-zA-Z]/g, (c) => { const m = MAP[c.toLowerCase()]; return c === c.toLowerCase() ? m : m.toUpperCase(); });
const secs = TC.detectSections(en).sections;
const chapOf = (i) => { let n = 0; for (const s of secs) if (i >= s.start) n = s.num; return n; };
// target = pseudo-translation, then defects
let tgtTexts = []; const truth = new Map();               // tgt text -> source index (for the oracle)
en.forEach((p, i) => { tgtTexts.push({ text: fwd(p.text), src: i, ch: chapOf(i) }); });
const find = (ch, k) => tgtTexts.filter((x) => x.ch === ch && x.src != null)[k];                // k-th paragraph of chapter ch
const DEFECTS = {};
{ const x = find(13, 7); DEFECTS.omitted = en[x.src].text; tgtTexts = tgtTexts.filter((y) => y !== x); }            // omission in ch 13
{ const y = tgtTexts.filter((z) => z.ch === 22 && z.src != null).slice(2).find((z) => /\d{4}/.test(z.text)) || tgtTexts.filter((z) => z.ch === 22).slice(2).find((z) => /\d{2,}/.test(z.text)); const mm = /\d{2,}/.exec(y.text); DEFECTS.numChange = { src: y.src, from: mm[0] }; y.text = y.text.replace(mm[0], String(+mm[0] + 7)); }
{ const h = tgtTexts.find((z) => z.ch === 25 && z.text === '25'); h.text = '52'; DEFECTS.badHeading = true; }                 // mistyped chapter number
{ const x = find(16, 3); const at = tgtTexts.indexOf(x); tgtTexts.splice(at + 1, 0, { text: fwd('The old harbour was rebuilt twice during the second half of the century, which nobody had expected at the time.'), src: null, ch: 16 }); DEFECTS.added = true; }
{ const x = find(9, 4); DEFECTS.untranslated = x.src; x.text = en[x.src].text; }                                   // left in English
{ tgtTexts = tgtTexts.filter((y) => y.ch !== 7); }                                                                // chapter 7 missing
tgtTexts.push({ text: '31', src: null, ch: 31 }, { text: fwd('A Bonus Chapter Nobody Asked For'), src: null, ch: 31 }, { text: fwd('Once upon a time a very long story was added at the end of the book by mistake and it goes on and on.'), src: null, ch: 31 });
const tgt = tgtTexts.map((x, i) => TC.makePara(x.text, i, Math.floor(i / 4) + 1));
const srcDoc = Object.assign({ paras: en, lang: 'English' }, TC.docStats(en));
const tgtDoc = Object.assign({ paras: tgt, lang: 'Mongolian' }, TC.docStats(tgt));

// ---------- the fake model ----------
const stats = { calls: 0, verify: 0, misbehaviours: {} };
const mis = (k) => { stats.misbehaviours[k] = (stats.misbehaviours[k] || 0) + 1; };
let nthCheck = 0; let hallucNum = null; const seenWin = new Set(); let winNo = 0;
function parseP(user, tag) { const re = new RegExp('^\\[' + tag + '(\\d+)\\] (.*)$', 'gm'); const out = []; let m; while ((m = re.exec(user))) out[+m[1] - 1] = m[2]; return out; }
async function callModel(system, user, meta) {
  stats.calls++;
  const S = parseP(user, 'S'), T = parseP(user, 'T');
  if (meta.kind === 'verify') {
    stats.verify++;
    const claims = [...user.matchAll(/^(\d+)\. (OMISSION|ADDITION) - .*?: "(.*)"$/gm)];
    const verdicts = claims.map((c) => {
      const txt = c[3].replace(/\.\.\.$/, '');
      const present = c[2] === 'OMISSION' ? T.some((x) => x === fwd(txt) || x.includes(fwd(txt.slice(0, 40)))) : S.some((x) => fwd(x) === txt || txt.includes(x.slice(0, 40)) && false);
      return { id: +c[1], verdict: present ? 'false_alarm' : 'confirmed', note: present ? 'present in the translation' : 'not found' };
    });
    return { text: JSON.stringify({ verdicts }), inTok: 800, outTok: 60 };
  }
  nthCheck++; if (!seenWin.has(meta.win.id)) { seenWin.add(meta.win.id); winNo++; }
  // misbehaviours, once each, on specific windows
  if (winNo === 3 && meta.attempt === 0 && !stats.misbehaviours['invalid-json']) { mis('invalid-json'); return { text: 'Sure! Here is the answer: not json at all', inTok: 500, outTok: 20 }; }
  if (meta.win.id === 's11' && meta.attempt === 0 && !stats.misbehaviours.truncated) { mis('truncated'); return { text: '{"alignment":["1|1","2|', inTok: 900, outTok: 8000, truncated: true }; }
  // alignment by exact pseudo-translation
  const used = new Set(); const groups = []; const issues = [];
  let tj = 0;
  S.forEach((s, i) => {
    const want = fwd(s);
    let j = -1;
    for (let k = tj; k < T.length; k++) if (!used.has(k) && T[k] === want) { j = k; break; }
    if (j < 0) for (let k = tj; k < T.length; k++) if (!used.has(k) && T[k].replace(/\d+/g, '#') === want.replace(/\d+/g, '#') && /\d/.test(want)) { j = k; break; }
    if (j < 0) for (let k = tj; k < T.length; k++) if (!used.has(k) && T[k] === s) { j = k; break; }      // left untranslated
    if (j >= 0) {
      // anything skipped on the target side is an addition
      for (let k = tj; k < j; k++) if (!used.has(k)) { used.add(k); groups.push([[], [k + 1]]); issues.push({ type: 'Addition', severity: 'Critical', s: [], t: [k + 1], source: '', target: T[k].slice(0, 40), fix: '', why: 'This paragraph is not in the source.' }); }
      used.add(j); tj = j + 1; groups.push([[i + 1], [j + 1]]);
      if (T[j] === s && s.split(' ').length >= 6) issues.push({ type: 'Untranslated', severity: 'Major', s: [i + 1], t: [j + 1], source: s.slice(0, 30), target: s.slice(0, 30), fix: '', why: 'Left in English.' });
      else if (T[j] !== want) { const a = /\d+/.exec(s), b = /\d+/.exec(T[j]); issues.push({ type: 'Number', severity: 'Critical', s: [i + 1], t: [j + 1], source: a ? a[0] : '', target: b ? b[0] : '', fix: a ? a[0] : '', why: 'The number differs from the source.' }); }
    } else { groups.push([[i + 1], []]); issues.push({ type: 'Omission', severity: 'Critical', s: [i + 1], t: [Math.max(tj, 0)], source: s.slice(0, 50), target: '', fix: '(translation of: ' + s.slice(0, 30) + ')', why: 'This sentence is missing in the translation.' }); }
  });
  for (let k = tj; k < T.length; k++) if (!used.has(k)) { used.add(k); groups.push([[], [k + 1]]); issues.push({ type: 'Addition', severity: 'Critical', s: [], t: [k + 1], source: '', target: T[k].slice(0, 40), fix: '', why: 'This paragraph is not in the source.' }); }
  let alignment = groups.map(([a, b]) => a.join(',') + '|' + b.join(','));
  if (winNo === 5 && meta.attempt === 0 && !stats.misbehaviours['incomplete-alignment']) { mis('incomplete-alignment'); alignment = alignment.slice(0, -1); }          // forget the last group once
  if (winNo === 6 && meta.attempt === 0 && !stats.misbehaviours['hallucinated-quote']) { mis('hallucinated-quote'); hallucNum = meta.win.num; if (issues.length) issues[0].source = 'words that are nowhere in the text'; else issues.push({ type: 'Mistranslation', severity: 'Minor', s: [1], t: [1], source: 'invented quote', target: 'invented', fix: '', why: 'x' }); }
  if (winNo === 8 && meta.attempt === 0 && !stats.misbehaviours['false-omission']) { mis('false-omission'); issues.push({ type: 'Omission', severity: 'Critical', s: [2], t: [1], source: S[1].slice(0, 40), target: '', fix: '', why: 'Claimed missing but it is present.' }); }
  return { text: JSON.stringify({ alignment, issues }), inTok: 3000, outTok: 400 };
}

// ---------- plan ----------
const plan = TC.planWindows(srcDoc, tgtDoc, {});
console.log('plan:', plan.how, '| windows', plan.windows.length, '| structural', plan.structural.map((s) => s.kind + ':' + s.pair.num).join(', '));
t('chapters matched by number', plan.how === 'number');
t('chapter 7 detected as missing, chapter 31 as added', plan.structural.some((s) => s.kind === 'missing-section' && s.pair.num === 7) && plan.structural.some((s) => s.kind === 'added-section' && s.pair.num === 31));
const cover = plan.windows.reduce((a, w) => ({ s: a.s + w.src.length, t: a.t + w.tgt.length }), { s: 0, t: 0 });
t('every source paragraph is in exactly one window', cover.s === en.length, cover.s + ' vs ' + en.length);
t('every translation paragraph is in exactly one window', cover.t === tgt.length, cover.t + ' vs ' + tgt.length);
console.log('window tokens: max', Math.max(...plan.windows.map((w) => w.estTokens)), '| big windows', plan.windows.filter((w) => w.estTokens > 5000).length, '| est', JSON.stringify(TC.estimateRun(plan)));

// ---------- run ----------
let progress = 0;
const state = await TC.checkWindows(plan, srcDoc, tgtDoc, { callModel, srcLang: 'English', tgtLang: 'Mongolian', onProgress: () => { progress++; } });
const rep = TC.buildReport(plan, srcDoc, tgtDoc, state, {});
console.log('calls', stats.calls, '(verify ' + stats.verify + ') | misbehaviours', JSON.stringify(stats.misbehaviours), '| splits', state.splits);
console.log('score', JSON.stringify(rep.score), '| issues', rep.issues.length);
rep.issues.forEach((x) => console.log('  #' + x.id, x.type, x.severity, x.origin, '|', x.srcLoc || '-', '->', x.tgtLoc || '-', '| p.' + x.page, '|', (x.why || '').slice(0, 70)));

t('run finished', state.finished && progress >= plan.windows.length);
t('all models misbehaviours were exercised', ['invalid-json', 'truncated', 'incomplete-alignment', 'hallucinated-quote', 'false-omission'].every((k) => stats.misbehaviours[k]), JSON.stringify(stats.misbehaviours));
const has = (type, chap, pred) => rep.issues.some((x) => x.type === type && x.chapter === chap && (!pred || pred(x)));
t('omission found in chapter 13 (Critical, verified)', has('Omission', 13, (x) => x.severity === 'Critical' && x.verified === 'confirmed'));
t('number change found in chapter 22', has('Number', 22));
t('addition found in chapter 16', has('Addition', 16));
t('untranslated paragraph found in chapter 9', has('Untranslated', 9));
t('missing chapter 7 reported', has('Structure', 7, (x) => x.severity === 'Critical' && /missing in the translation/.test(x.why)));
t('extra chapter 31 reported', has('Structure', 31, (x) => /only in the translation/.test(x.why)));
t('the false omission was dropped by the second look', !rep.issues.some((x) => /Claimed missing/.test(x.why)) && rep.coverage.dropped >= 1, 'dropped ' + rep.coverage.dropped);
t('mistyped heading in chapter 25 recovered (chapter paired, no mass additions, heading difference reported once)', plan.repairs.length === 1 && plan.repairs[0].num === 25 && plan.repairs[0].found === 52 && !rep.issues.some((x) => x.chapter === 25 && /Addition|Omission/.test(x.type)) && rep.issues.filter((x) => x.chapter === 25).length === 1, JSON.stringify(rep.issues.filter((x) => x.chapter === 25).map((x) => x.type)));
t('a quote that is not in the text is kept only as a zero-point Query', rep.issues.filter((x) => x.chapter === hallucNum).every((x) => x.severity === 'Query' && x.quoteOk === false) && rep.issues.some((x) => x.chapter === hallucNum), JSON.stringify(rep.issues.filter((x) => x.chapter === hallucNum).map((x) => [x.type, x.severity, x.quoteOk])));
t('no unexpected issues (only the injected defects)', rep.issues.filter((x) => ![hallucNum, 9, 7, 13, 16, 22, 25, 31].includes(x.chapter)).length === 0, rep.issues.filter((x) => ![hallucNum, 9, 7, 13, 16, 22, 25, 31].includes(x.chapter)).map((x) => x.chapter + ':' + x.type).join(' '));
t('coverage is complete and fully accounted', rep.coverage.complete && rep.coverage.unverified.length === 0, JSON.stringify(rep.coverage.unverified));
t('coverage counts match the documents', rep.coverage.srcParas === en.length && rep.coverage.tgtParas === tgt.length);
t('rubric: verdict is Revise or Fail because Critical issues exist', rep.score.counts.Critical > 0 && rep.score.verdict !== 'Pass');
const expectScore = Math.max(0, Math.round(100 - 4 * (rep.score.penalty / (rep.scoredWords / 1000))));
t('score follows the formula 100 - 4 x penalty per 1000 words', rep.score.value === expectScore, rep.score.value + ' vs ' + expectScore);
t('per-chapter table has an entry per chapter', rep.sections.length >= 31 && rep.sections.find((s) => s.num === 13).issues >= 1 && rep.sections.find((s) => s.num === 2).issues === 0);
t('locations use chapter + paragraph numbers', rep.issues.filter((x) => x.chapter === 13)[0].srcLoc.startsWith('Ch 13 ¶'));
t('page numbers come from the translation', rep.issues.some((x) => x.chapter === 22 && x.page > 0));
t('the omission is located next to the right translation paragraph', rep.issues.filter((x) => x.chapter === 13 && x.type === 'Omission').every((x) => /^after Ch 13 \u00b6\d+/.test(x.tgtLoc) && x.page > 0), JSON.stringify(rep.issues.filter((x) => x.chapter === 13).map((x) => x.tgtLoc)));


// ---------- stop and continue ----------
{
  let n = 0; const stopAt = 10; const st2 = { done: {}, results: [], inTok: 0, outTok: 0, calls: 0, splits: 0, verifyCalls: 0 };
  let stop = false; const slow = async (sys, user, meta) => { if (meta.kind === 'check' && ++n === stopAt) stop = true; return callModel(sys, user, meta); };
  stats.misbehaviours = {}; nthCheck = 0; seenWin.clear(); winNo = 0;
  await TC.checkWindows(plan, srcDoc, tgtDoc, { callModel: slow, srcLang: 'English', tgtLang: 'Mongolian', shouldStop: () => stop }, st2);
  const partial = TC.buildReport(plan, srcDoc, tgtDoc, st2, {});
  t('stop: the run stops part-way and says so', st2.stopped && !st2.finished && !partial.coverage.complete && partial.coverage.windowsDone < plan.windows.length, JSON.stringify([st2.stopped, st2.finished, partial.coverage.windowsDone]));
  const doneBefore = Object.keys(st2.done).length; stop = false; const callsBefore = st2.calls;
  await TC.checkWindows(plan, srcDoc, tgtDoc, { callModel, srcLang: 'English', tgtLang: 'Mongolian', shouldStop: () => stop }, st2);
  const full = TC.buildReport(plan, srcDoc, tgtDoc, st2, {});
  t('continue: finishes, no longer marked stopped', st2.finished && !st2.stopped && full.coverage.complete);
  t('continue: finished windows were not run again', st2.calls - callsBefore <= plan.windows.length - doneBefore + 12, (st2.calls - callsBefore) + ' calls for ' + (plan.windows.length - doneBefore) + ' windows');
  t('continue: the final report matches a straight run', full.issues.length === rep.issues.length && full.score.value === rep.score.value, full.issues.length + ' vs ' + rep.issues.length);
}
// ---------- share payload + csv ----------
const sh = TC.toShareIssues(rep.issues, 'English');
t('share payload has the fields the reviewer page expects', sh.every((x) => x.id && x.type && x.severity && 'loc' in x && 'context' in x && 'original' in x && 'corrected' in x));
t('omissions are marked as insertions in the share payload', sh.find((x) => x.type === 'Omission') && sh.find((x) => x.type === 'Omission').insert === true);
t('csv rows match the header', TC.toCsvRows(rep.issues).every((r) => r.length === TC.CSV_HEAD.length));
console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
