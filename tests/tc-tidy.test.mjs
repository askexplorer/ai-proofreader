// Offline test for the v5.3.1 tidy-ups of the translation check (tc-core.js), found by reading a real 146-finding report:
//  1. numbers written out in words ("1,000" -> "mil", "the 1930s" -> "los anos treinta") are not reported as missing
//  2. words missing from a paragraph that HAS a counterpart sit on that paragraph (not "insert after the previous one")
//  3. a missing phrase and a meaning finding on the same words are ONE finding (counted once in the score)
//  4. one recurring word choice that the model words a little differently each time is ONE finding, different problems stay apart
//  5. an explanation that talks itself out of the finding ("acceptable in meaning ...", "a style choice") becomes a quiet Note
// Run: node tests/tc-tidy.test.mjs   (Node 18+). Invented text only: the repo is public, client text never goes in tests.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
new Function(readFileSync(path.join(root, 'tc-core.js'), 'utf8'))();
const TC = globalThis.TC;
let pass = 0, fail = 0;
const ok = (c, n, x) => { if (c) pass++; else { fail++; console.log('FAIL  ' + n + (x ? '  ' + x : '')); } };
const doc = (txt, lang) => Object.assign({ paras: TC.parasFromText(txt), lang }, TC.docStats(TC.parasFromText(txt)));

// ---------- the story (English -> Spanish, planted defects) ----------
const EN = [
  'The lighthouse keeper wrote to the harbour office every evening.',                                                              // 1
  'In the 1930s the village counted 1,000 boats in the bay.',                                                                      // 2  both figures written out in Spanish
  'The keeper sailed for 12 years before settling on the rock.',                                                                   // 3  12 -> 21: a real change
  'May the sea grant you success.',                                                                                                // 4  the same word choice, three times
  'May the tide grant us all success.',                                                                                            // 5
  'May the harbour grant us success.',                                                                                             // 6
  'Every sailor should know where the light stands, and what it costs the keeper to keep it burning through the longest night.',  // 7  second half missing
  'She counted her children, her boats and her savings.',                                                                          // 8  "children" missing (found twice)
  'Your children deserve the harbour.',                                                                                            // 9  two DIFFERENT problems that look alike
  'Your family deserves the harbour.',                                                                                             // 10
  'The last page of the logbook was torn out.',                                                                                    // 11 no counterpart at all
].join('\n\n');
const ES = [
  'La farera escribia a la oficina del puerto cada tarde.',
  'En los anos treinta el pueblo contaba mil barcos en la bahia.',
  'La farera navego durante 21 anos antes de instalarse en la roca.',
  'Que el mar bendiga tus esfuerzos.',
  'Que la marea bendiga nuestra labor.',
  'Que el puerto bendiga nuestros esfuerzos.',
  'Todo marinero deberia saber donde esta la luz.',
  'Conto sus barcos y sus ahorros.',
  'Vuestros hijos merecen el puerto.',
  'Vuestros familiares merecen el puerto.',
].join('\n\n');
const src = doc(EN, 'English'), tgt = doc(ES, 'Spanish'), plan = TC.planWindows(src, tgt, {});
ok(plan.windows.length === 1 && src.paras.length === 11 && tgt.paras.length === 10, 'the story is one window of 11 + 10 paragraphs', plan.windows.length + ' ' + src.paras.length + '/' + tgt.paras.length);

// ---------- fakes ----------
const log = { verify: [], verifySys: [] };
let verifyFails = false;
const parseP = (user, tag) => { const re = new RegExp('^\\[' + tag + '(\\d+)\\] (.*)$', 'gm'); const out = []; let m; while ((m = re.exec(user))) out[+m[1] - 1] = m[2]; return out; };
const add = (o) => Object.assign({ type: 'Mistranslation', severity: 'Minor', fix: '', why: 'x', term_s: '', term_t: '' }, o);
async function callMain(system, user, meta) {
  if (meta.kind === 'verify') {
    if (verifyFails) throw new Error('upstream failure');
    log.verify.push(user); log.verifySys.push(system);
    const T = user.split('FULL TRANSLATION:')[1].split('CLAIMS TO CHECK:')[0];
    const verdicts = [...user.matchAll(/^(\d+)\. (OMISSION|ADDITION|NUMBER) - (.*)$/gm)].map((c) => {
      if (c[2] !== 'NUMBER') return { id: +c[1], verdict: 'confirmed', note: 'really absent' };
      // this fake "reads" the translation: a figure is present when it is written out there
      const words = { 1930: /anos treinta/, 1000: /\bmil\b/ };
      const missing = [...c[3].matchAll(/\b(1930|1000|12)\b/g)].map((m) => +m[1]);
      const allThere = missing.length > 0 && missing.every((v) => words[v] && words[v].test(T));
      return { id: +c[1], verdict: allThere ? 'false_alarm' : 'confirmed', note: allThere ? 'written out in words' : 'really different' };
    });
    return { text: JSON.stringify({ verdicts }), inTok: 100, outTok: 20 };
  }
  if (meta.kind === 'meaning') return callSecond(system, user, meta);
  const S = parseP(user, 'S'), T = parseP(user, 'T');
  const alignment = S.map((_, i) => (i + 1) + '|' + (i < 10 ? i + 1 : ''));
  const issues = [
    add({ type: 'Terminology', s: [4], t: [4], source: 'grant you success', target: 'bendiga tus esfuerzos', why: 'Success is turned into effort.', term_s: 'grant you success', term_t: 'bendiga tus esfuerzos' }),
    add({ type: 'Terminology', s: [5], t: [5], source: 'grant us all success', target: 'bendiga nuestra labor', why: 'Success is turned into work.', term_s: 'grant us all success', term_t: 'bendiga nuestra labor' }),
    add({ type: 'Terminology', s: [6], t: [6], source: 'grant us success', target: 'bendiga nuestros esfuerzos', why: 'Success is turned into effort.', term_s: 'grant us success', term_t: 'bendiga nuestros esfuerzos' }),
    add({ type: 'Omission', severity: 'Minor', s: [7], t: [], source: 'and what it costs the keeper to keep it burning through the longest night', target: '', fix: 'y lo que le cuesta a la farera mantenerla encendida durante la noche mas larga', why: 'The second half of the sentence is missing.' }),
    add({ type: 'Omission', severity: 'Minor', s: [8], t: [], source: 'her children', target: '', fix: 'Conto a sus hijos, sus barcos y sus ahorros.', why: 'Her children are not counted.' }),
    add({ s: [9], t: [9], source: 'Your children', target: 'Vuestros hijos', why: 'The wording is a little different.', term_s: 'Your children', term_t: 'Vuestros hijos' }),
    add({ s: [10], t: [10], source: 'Your family', target: 'Vuestros familiares', why: 'The wording is a little different.', term_s: 'Your family', term_t: 'Vuestros familiares' }),
    add({ type: 'Omission', severity: 'Major', s: [11], t: [], source: 'The last page of the logbook was torn out.', target: '', why: 'The whole paragraph is missing.' }),
  ];
  return { text: JSON.stringify({ alignment, issues }), inTok: 1000, outTok: 200 };
}
async function callSecond(system, user, meta) {
  const pairs = [...user.matchAll(/\[P(\d+)\]\nSOURCE: (.*)\nTRANSLATION: (.*)/g)].map((m) => ({ p: +m[1], s: m[2], t: m[3] }));
  const differs = [];
  pairs.forEach((pr) => {
    if (pr.s.startsWith('She counted her children')) differs.push({ p: pr.p, type: 'Mistranslation', severity: 'Major', source: 'She counted her children, her boats and her savings.', target: 'Conto sus barcos y sus ahorros.', fix: 'Conto a sus hijos, sus barcos y sus ahorros.', why: 'The children are left out of the list.' });
  });
  const same = pairs.filter((pr) => !differs.some((d) => d.p === pr.p)).map((pr) => pr.p);
  return { text: JSON.stringify({ same: same.join(','), differs }), inTok: 300, outTok: 40 };
}
async function run(ctx) {
  log.verify.length = 0; log.verifySys.length = 0;
  const state = await TC.checkWindows(plan, src, tgt, Object.assign({ callModel: callMain, strict: 'all', srcLang: 'English', tgtLang: 'Spanish' }, ctx || {}));
  return { state, rep: TC.buildReport(plan, src, tgt, state, {}) };
}

// ---------- 1. numbers written out in words ----------
const first = await run();
const numbers = first.rep.issues.filter((x) => x.type === 'Number');
ok(!numbers.some((x) => /1000|1930/.test(x.why)), '"1,000" -> "mil" and "the 1930s" -> "los anos treinta" are no longer reported', JSON.stringify(numbers.map((x) => x.why)));
const real = numbers.find((x) => /12/.test(x.why) && /21/.test(x.why));
ok(real && real.verified === 'confirmed', 'a real change (12 -> 21) is kept and marked as double-checked', JSON.stringify(numbers));
ok(real && /12 years/.test(real.srcText) && /21 anos/.test(real.tgtText), 'the number finding shows the figure in its own words (for the card and for Ctrl+F)', real && real.srcText + ' | ' + real.tgtText);
ok(first.rep.coverage.dropped >= 1, 'the false number alarm is counted among the false alarms removed', String(first.rep.coverage.dropped));
ok(log.verify.some((u) => /^\d+\. NUMBER - /m.test(u)), 'the number claims go to the model with the rest of the claims (one call)');
ok(/NUMBER claim/.test(log.verifySys[0]) && /written out in words/.test(log.verifySys[0]) && /1930s/.test(log.verifySys[0]), 'the instruction tells the model that figures can be words, decades or other numerals');
verifyFails = true; const noVerify = await run(); verifyFails = false;
ok(noVerify.rep.issues.filter((x) => x.type === 'Number').length === 2, 'if the double-check fails, the number alarms are kept (nothing is hidden)', String(noVerify.rep.issues.filter((x) => x.type === 'Number').length));
const sp = (t, v) => TC.numberSpan(t, v);
ok(sp('Sold in the 1930s and 1940s for 1,000 coins each.', 1000) === 'Sold in the 1930s and 1940s for 1,000 coins each.' || /1,000 coins/.test(sp('Sold in the 1930s and 1940s for 1,000 coins each.', 1000)), 'numberSpan finds the figure as written (1,000)');
ok(sp('Hace 2.500 anos, segun la tradicion.', 2500).includes('2.500') && sp('x', 5) === '', 'numberSpan reads a German/Spanish 2.500 and returns nothing when the number is not there');
const long = 'A very long first part of the sentence goes on and on before it reaches 4,200 words in the middle and then continues for quite some time after that.';
ok(sp(long, 4200).includes('4,200') && sp(long, 4200).length < long.length && long.includes(sp(long, 4200)), 'numberSpan cuts a long paragraph down to the words around the figure, verbatim', sp(long, 4200));

// ---------- 2. a phrase missing from a paragraph that has a counterpart ----------
const partial = first.rep.issues.find((x) => x.type === 'Omission' && /longest night/.test(x.srcContext));
ok(partial && partial.insert === false && !/^after/.test(partial.tgtLoc) && /Todo marinero/.test(partial.tgtContext), 'words missing inside a paragraph sit on the paragraph that has a counterpart, not "after" the one before', partial && partial.tgtLoc + ' | insert=' + partial.insert);
const whole = first.rep.issues.find((x) => x.type === 'Omission' && /last page/.test(x.srcContext));
ok(whole && whole.insert === true && /^after/.test(whole.tgtLoc) && whole.severity === 'Major', 'a paragraph with NO counterpart stays an insertion ("after ...")', whole && whole.tgtLoc);

// ---------- 3. one problem, one finding ----------
const second = await run({ callModelSecond: callSecond, second: true });
const kids = second.rep.issues.filter((x) => /her children/.test(x.srcContext));
ok(kids.length === 1, 'a missing phrase and the meaning finding on the same words are ONE finding', JSON.stringify(kids.map((x) => x.type + '/' + x.severity + '/' + x.origin)));
ok(kids[0] && kids[0].severity === 'Major' && kids[0].second === 'agrees' && kids[0].fix, 'the merged finding keeps the higher severity, the fix, and says two looks agreed', JSON.stringify(kids[0] && [kids[0].severity, kids[0].second, kids[0].fix]));
ok(second.rep.score.counts.Major === 2 && second.rep.score.counts.Minor <= 4, 'it counts once in the score (2 Major: the merged one and the lost paragraph)', JSON.stringify(second.rep.score.counts));
const kidsFirstOnly = first.rep.issues.filter((x) => /her children/.test(x.srcContext));
ok(kidsFirstOnly.length === 1 && kidsFirstOnly[0].type === 'Omission' && kidsFirstOnly[0].insert === false, 'without the second look the omission is still one finding, located on its paragraph');

// ---------- 4. one recurring word choice ----------
const bless = first.rep.issues.filter((x) => /bendiga/.test(x.tgtContext));
ok(bless.length === 1 && bless[0].alsoCount === 2, '"grant you success" / "grant us all success" / "grant us success" are one finding listing all three places', JSON.stringify(bless.map((x) => [x.srcLoc, x.alsoCount])));
const lookAlike = first.rep.issues.filter((x) => /Vuestros/.test(x.tgtContext) && x.type !== 'Omission');
ok(lookAlike.length === 2, '"your children" and "your family" (shared word "your" only) stay two findings', String(lookAlike.length));
ok(!first.rep.issues.some((x) => x.alsoCount && /Vuestros/.test(x.tgtContext)), 'nothing is listed "also at" for the look-alikes');

// ---------- 5. an explanation that talks itself out of it ----------
const win = plan.windows[0];
const read = (severity, why, type = 'Mistranslation') => TC.readAnswer(win, { alignment: '1|1,2|2,3|3,4|4,5|5,6|6,7|7,8|8,9|9,10|10,11|', issues: [{ type, severity, s: [4], t: [4], source: 'grant you success', target: 'bendiga tus esfuerzos', why }] }).issues[0];
let r = read('Minor', 'The rendering is acceptable in meaning but loses the nuance. Flagged as Minor since the factual meaning is preserved.');
ok(r.type === 'Wording' && r.severity === 'Note', 'Minor + "acceptable in meaning but ..." -> quiet Note', r.type + '/' + r.severity);
r = read('Minor', 'Success becomes effort; however this is a style choice.');
ok(r.severity === 'Note', '"a style choice" -> quiet Note');
r = read('Query', 'The word is slightly narrower, though borderline.');
ok(r.severity === 'Note', '"borderline" on a Query -> quiet Note');
r = read('Minor', 'It says the sea is calm, which the nearby lines contradict. This rendering is not acceptable.');
ok(r.type === 'Mistranslation' && r.severity === 'Minor', '"is not acceptable" is a finding, not an excuse', r.type + '/' + r.severity);
r = read('Minor', 'The duty is reversed; a translator could not defend this as an acceptable choice here? No.', 'Mistranslation');
ok(r.severity === 'Minor' || r.severity === 'Note', 'sanity: the reader never crashes on odd text');
r = read('Major', 'The meaning changes, though one could call the wording acceptable.');
ok(r.type === 'Mistranslation' && r.severity === 'Major', 'a Major finding is never demoted by a hedge in its explanation');
r = read('Minor', 'Acceptable rewording.');
ok(r.severity === 'Note', 'the old rule still works: "Acceptable ..." at the start');
const pairs = [{ p: 1, s: [4], t: [4], sText: 'May the sea grant you success.', tText: 'Que el mar bendiga tus esfuerzos.' }];
const mm = TC.readMeaning(pairs, { same: '', differs: [{ p: 1, type: 'Mistranslation', severity: 'Minor', source: 'grant you success', target: 'bendiga tus esfuerzos', why: 'Wording differs; the meaning is preserved overall.' }] });
ok(mm.raws.length === 1 && mm.raws[0].severity === 'Note', 'the second look is held to the same rule');

console.log(`${fail ? 'FAILED' : 'OK'}: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
