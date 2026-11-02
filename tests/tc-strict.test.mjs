// Offline test for the "how strict" levels and the noise rules of the translation check (tc-core.js).
// Run: node tests/tc-strict.test.mjs   (Node 18+). Invented text only: the repo is public, client text never goes in tests.
// Background: an editor reviewed an Arabic -> English book check: 188 findings, 28 of 28 reviewed ones dismissed (pull quotes shortened,
// paragraphs split differently, repeated blessings left out, non-literal wording), every location "Ch 1", no page numbers.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
new Function(readFileSync(path.join(root, 'tc-core.js'), 'utf8'))();
const TC = globalThis.TC;
let pass = 0, fail = 0;
const ok = (c, n, x) => { if (c) pass++; else { fail++; console.log('FAIL  ' + n + (x ? '  ' + x : '')); } };
const doc = (txt, lang) => Object.assign({ paras: TC.parasFromText(txt), lang }, TC.docStats(TC.parasFromText(txt)));

const EN = ['The old lighthouse stood on the northern rock above the harbour.',
  'Anna climbed 120 steps every evening to light the lamp.',
  'She wrote the weather in a small blue book and sent it to the harbour office.',
  'Fishermen trusted the light because it never failed in forty years.',
  'The keeper retired in spring and the village gave her a silver clock.',
  'Today visitors climb the same steps and read the same blue books.'].join('\n\n');
const DE = ['Der alte Leuchtturm stand auf dem noerdlichen Felsen ueber dem Hafen.',
  'Anna stieg jeden Abend 210 Stufen hinauf, um die Lampe zu entzuenden.',
  'Sie schrieb das Wetter in ein kleines blaues Buch und schickte es ans Hafenbuero.',
  'Die Fischer vertrauten dem Licht, weil es vierzig Jahre lang nie ausfiel.',
  'Die Waerterin ging im Fruehling in den Ruhestand und das Dorf schenkte ihr eine silberne Uhr.',
  'Heute steigen Besucher dieselben Stufen hinauf und lesen dieselben blauen Buecher.'].join('\n\n');

// a fake model that always says the same thing: one Major, one Minor, one model Query, all quoted verbatim
const seen = [];
const callModel = async (system, user) => {
  seen.push({ system, user });
  const n = (user.match(/\[S\d+\]/g) || []).length;
  const alignment = Array.from({ length: n }, (_, i) => (i + 1) + '|' + (i + 1));
  const issues = n >= 6 ? [
    { type: 'Mistranslation', severity: 'Major', s: [4], t: [4], source: 'it never failed in forty years', target: 'es vierzig Jahre lang nie ausfiel', fix: 'weil es in vierzig Jahren nie ausfiel', why: 'The sense changes.' },
    { type: 'Mistranslation', severity: 'Minor', s: [5], t: [5], source: 'gave her a silver clock', target: 'schenkte ihr eine silberne Uhr', fix: 'ueberreichte ihr eine silberne Uhr', why: 'Slightly different verb.' },
    { type: 'Mistranslation', severity: 'Query', s: [6], t: [6], source: 'read the same blue books', target: 'lesen dieselben blauen Buecher', fix: 'lesen die gleichen blauen Buecher', why: 'Maybe.' },
  ] : [];
  return { text: JSON.stringify({ alignment, issues }), inTok: 100, outTok: 50, truncated: false };
};
async function run(strict, e = EN, d = DE, srcLang = 'English', tgtLang = 'German') {
  const src = doc(e, srcLang), tgt = doc(d, tgtLang), plan = TC.planWindows(src, tgt, {});
  seen.length = 0;
  const state = await TC.checkWindows(plan, src, tgt, { callModel, strict, srcLang, tgtLang });
  return { rep: TC.buildReport(plan, src, tgt, state, {}), prompts: seen.slice(), state };
}
const sev = (rep, type) => rep.issues.filter((x) => x.type === type).map((x) => x.severity).sort().join(',');

// --- levels
const facts = await run(undefined), close = await run('close'), all = await run('all');
const visible = (r) => r.issues.filter((x) => x.severity !== 'Note');
ok(facts.state.strict === 'facts' && close.state.strict === 'close' && all.state.strict === 'all', 'no level given -> facts only; the level is kept in the run');
ok(facts.rep.issues.some((x) => x.severity === 'Major' && x.type === 'Mistranslation'), 'facts: a Major finding is kept');
ok(!facts.rep.issues.some((x) => x.severity === 'Minor') && facts.rep.issues.filter((x) => x.type === 'Mistranslation' && x.severity === 'Note').length === 2, 'facts: the model\'s Minor and its Query-about-wording become hidden Notes', JSON.stringify(facts.rep.issues.map((x) => x.type + '/' + x.severity)));
ok(facts.rep.issues.filter((x) => x.severity === 'Note').every((x) => x.was === 'Minor' || x.was === 'Query'), 'a demoted finding remembers what it was');
ok(facts.rep.issues.some((x) => x.type === 'Number' && x.severity === 'Query' && x.origin === 'rule'), 'facts: the automatic "number changed" check (120 -> 210) is still shown');
ok(close.rep.issues.some((x) => x.severity === 'Minor') && close.rep.issues.some((x) => x.severity === 'Query' && x.type === 'Mistranslation'), 'close: Minor and Query findings stay');
ok(sev(all.rep, 'Mistranslation') === 'Major,Minor,Query', 'everything: nothing is demoted', sev(all.rep, 'Mistranslation'));
ok(visible(facts.rep).length < visible(close.rep).length, 'facts shows fewer findings than close (' + visible(facts.rep).length + ' vs ' + visible(close.rep).length + ')');
ok(facts.rep.score.counts.Minor === 0 && close.rep.score.counts.Minor >= 1, 'facts: Minor findings no longer count in the score; close: they do');
ok(TC.strictLevel({ strict: 'nonsense' }) === 'facts' && TC.STRICT_LEVELS.join() === 'facts,close,all', 'an unknown level falls back to facts only');

// --- what the model is told
const sys = (r) => r.prompts[0].system;
ok(/NORMAL TRANSLATION CHOICES/.test(sys(facts)) && /pull quote/i.test(sys(facts)) && /different paragraph break/.test(sys(facts)) && /near-synonyms, adjectives, blessings/.test(sys(facts)), 'the prompt lists the normal translation choices (pull quotes, paragraph splits, repeated blessings, ...)');
ok(/STRICTNESS: FACTS ONLY/.test(sys(facts)) && /do not report Minor/.test(sys(facts)), 'facts level: told to report facts only and no Minor');
ok(/STRICTNESS: CLOSE/.test(sys(close)) && !/STRICTNESS: FACTS ONLY/.test(sys(close)), 'close level has its own instruction');
ok(/STRICTNESS: EVERYTHING/.test(sys(all)), 'everything level has its own instruction');
ok(!/Arabic prose often repeats blessings/.test(sys(facts)), 'no Arabic note for an English/German pair');
const ar = await run('facts', EN, DE, 'Arabic', 'English');
ok(/Arabic prose often repeats blessings/.test(sys(ar)) && /only as a Query/.test(sys(ar)), 'an Arabic pair adds the note about blessings and formulas');
ok(/never use this for text that is simply missing/.test(sys(facts)), 'Untranslated is limited to text left in the source language');
ok(/NORMAL TRANSLATION CHOICES/.test(TC.meaningSystemPrompt({ srcLang: 'English', tgtLang: 'German' })) && /STRICTNESS/.test(TC.meaningSystemPrompt({ strict: 'close' })), 'the second look gets the same calibration');

// --- locations without chapters
ok(facts.rep.issues.every((x) => !/Ch \d/.test(x.tgtLoc + x.srcLoc)), 'a text with no chapters has no "Ch 1" in any location', JSON.stringify(facts.rep.issues.map((x) => x.tgtLoc)));
ok(facts.rep.issues.some((x) => /¶|para/i.test(x.tgtLoc) || /\d/.test(x.tgtLoc)), 'locations still say which paragraph');
const two = (t) => 'Chapter 1\n\n' + t + '\n\nChapter 2\n\n' + t + '\n\nChapter 3\n\n' + t;   // 3+ headings are needed before a text counts as having chapters
const multi = await run('all', two(EN), two(DE));
ok(multi.rep.issues.some((x) => /Ch 2/.test(x.tgtLoc)), 'a text with real chapters keeps its chapter labels');

// --- length outliers: far fewer, mild ones are only Notes
{
  const word = (n) => Array.from({ length: n }, (_, i) => 'w' + i).join(' ');
  const S = [0, 1, 2, 3, 4, 5].map((i) => 'Source paragraph ' + i + ' ' + word(90)), tl = [90, 90, 90, 90, 26, 14];
  const T = S.map((_, i) => 'Ziel ' + i + ' ' + word(tl[i]));
  const ident = async (system, user) => ({ text: JSON.stringify({ alignment: Array.from({ length: 6 }, (_, i) => (i + 1) + '|' + (i + 1)), issues: [] }), inTok: 1, outTok: 1, truncated: false });
  const src = doc(S.join('\n\n'), 'English'), tgt = doc(T.join('\n\n'), 'German'), plan = TC.planWindows(src, tgt, {});
  const st = await TC.checkWindows(plan, src, tgt, { callModel: ident, strict: 'all', srcLang: 'English', tgtLang: 'German' });
  const lens = TC.buildReport(plan, src, tgt, st, {}).issues.filter((x) => x.origin === 'rule' && /Omission|Addition/.test(x.type));
  const bySev = lens.map((x) => x.severity).sort().join(',');
  ok(lens.length === 2 && bySev === 'Note,Query', 'a mild length difference is a Note, an extreme one a Query', bySev + ' / ' + JSON.stringify(lens.map((x) => x.why.slice(0, 60))));
  const quiet = [0, 1, 2, 3, 4, 5].map((i) => 'Ziel ' + i + ' ' + word([90, 90, 90, 90, 48, 120][i]));
  const t2 = doc(quiet.join('\n\n'), 'German'), plan2 = TC.planWindows(src, t2, {});
  const st2 = await TC.checkWindows(plan2, src, t2, { callModel: ident, strict: 'all', srcLang: 'English', tgtLang: 'German' });
  ok(TC.buildReport(plan2, src, t2, st2, {}).issues.filter((x) => x.origin === 'rule' && /Omission|Addition/.test(x.type)).length === 0, 'an ordinary difference in length (a half or double) is not reported at all');
}

console.log(`${fail ? 'FAILED' : 'OK'}: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
