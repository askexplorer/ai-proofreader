// Tests for the translation-check clean-up and the second look at meaning (tc-core.js).
// Everything is invented text (a small lighthouse story and a German version with planted defects).
// Run:  node tests/tc-second.test.mjs
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
const here = dirname(fileURLToPath(import.meta.url));
await import(pathToFileURL(join(here, '..', 'tc-core.js')).href);
const TC = globalThis.TC;
let pass = 0, fail = 0;
const t = (name, cond, extra = '') => { cond ? pass++ : (fail++, console.log('FAIL  ' + name + (extra ? '  ' + extra : ''))); };

// ---------- 1. numbers: German "800.000" is the same number as English "800,000" ----------
const N = (x) => [...TC.numbersIn(x)].sort().join(',');
t('800,000 (en) and 800.000 (de) are the same number', N('800,000 crates') === N('800.000 Kisten') && N('800.000 Kisten') === '800000', N('800.000 Kisten'));
t('1,000 / 1.000 and 2,500 / 2.500', N('1,000') === N('1.000') && N('2,500') === N('2.500') && N('2.500') === '2500');
t('decimals stay decimals (2.5 en, 2,5 de, 0.125)', N('2.5') === '2.5' && N('2,5') === '2.5' && N('0.125') === '0.125', N('0.125') + ' ' + N('2,5'));
t('German 1.234,56 is 1234.56 and dates are not thousands', N('1.234,56') === '1234.56' && !/2710/.test(N('am 27.10.2026')), N('am 27.10.2026'));
t('1.234.567 is read as one number', N('1.234.567') === '1234567');

// ---------- the story ----------
const EN = [
  'Lighthouse Stories',
  '01', 'The keeper',
  'The keeper of the lighthouse carries the trust of every sailor.',
  'Every evening the keeper climbs two hundred steps.',
  'Only the keeper knows how to keep watch through the longest night.',
  'The village pays him little, but it pays him in gratitude.',
  'She would report the matter to the captain for his advice.',
  'In spring the harbour held 800,000 crates of oranges.',
  '02', 'The storm',
  'Storms test every harbour. Ships return only to those who maintain the lights.',
  'Nobody remembers who owned the largest ship. They remember who saved the crew.',
  'A good light never asks who is sailing.',
  'The old sailors say that boats keep watch over their captains.',
  'Some nights the sea is quiet.',
  '03', 'The morning',
  'A good light never asks who is sailing.',
  'To keep watch is to love strangers.',
  'The sun rises and the keeper sleeps.',
  'At noon the village wakes.',
  'The lamp burns 12 hours each night.',
].join('\n\n');
const DE = [
  'Leuchtturmgeschichten',
  '01', 'Der Wächter',
  'Der Wärter des Leuchtturms genießt das Vertrauen jedes Seemanns.',
  'Jeden Abend steigt der Wärter zweihundert Stufen hinauf.',
  'Nur der Wärter weiß, wie man in der längsten Nacht Wache schiebt.',
  'Das Dorf bezahlt ihn schlecht, aber es bezahlt ihn mit Dankbarkeit.',
  'Sie meldete die Sache dem Kapitän, damit er entscheiden konnte.',
  'Im Frühling fasste der Hafen 800.000 Kisten Orangen.',
  '02', 'Der Sturm',
  'Stürme prüfen jeden Hafen. Schiffe kehren nur zu denen zurück, die die Lichter pflegen.',
  'Schiffe kehren nur zu denen zurück, die die Lichter pflegen. Sie erinnern sich an den, der die Mannschaft gerettet hat.',
  'Ein gutes Licht fragt nie, wer segelt.',
  'Die alten Seeleute sagen, dass Boote Wache schieben über ihre Kapitäne.',
  'Manche Nächte ist das Meer still.',
  '03', 'Der Morgen',
  'Ein gutes Licht fragt nie, wer segelt.',
  'Wache zu schieben heißt, Fremde zu lieben.',
  'Die Sonne geht auf, und der Wärter schläft.',
  'Am Mittag erwacht das Dorf.',
  'Die Lampe brennt jede Nacht 21 Stunden.',
].join('\n\n');
const srcDoc = Object.assign({ paras: TC.parasFromText(EN), lang: 'English' }, TC.docStats(TC.parasFromText(EN)));
const tgtDoc = Object.assign({ paras: TC.parasFromText(DE), lang: 'German' }, TC.docStats(TC.parasFromText(DE)));
const plan = TC.planWindows(srcDoc, tgtDoc, {});
t('story is planned as 4 windows (front matter + 3 chapters)', plan.how === 'number' && plan.windows.length === 4, plan.how + ' ' + plan.windows.length);

// ---------- the fake first check ----------
const parseP = (user, tag) => { const re = new RegExp('^\\[' + tag + '(\\d+)\\] (.*)$', 'gm'); const out = []; let m; while ((m = re.exec(user))) out[+m[1] - 1] = m[2]; return out; };
const calls = { check: 0, verify: 0, meaningMain: 0, meaningSecond: 0, secondAttempts: {} };
const idxOf = (S, frag) => S.findIndex((x) => x.includes(frag)) + 1;
async function callMain(system, user, meta) {
  if (meta.kind === 'verify') {
    calls.verify++;
    const claims = [...user.matchAll(/^(\d+)\. (OMISSION|ADDITION) - /gm)];
    return { text: JSON.stringify({ verdicts: claims.map((c) => ({ id: +c[1], verdict: 'confirmed', note: 'really absent' })) }), inTok: 500, outTok: 40 };
  }
  if (meta.kind === 'meaning') { calls.meaningMain++; return callSecond(system, user, meta); }
  calls.check++;
  const S = parseP(user, 'S'), T = parseP(user, 'T');
  const alignment = S.map((_, i) => (i + 1) + '|' + (i + 1));
  const issues = [];
  const add = (o) => issues.push(Object.assign({ type: 'Mistranslation', severity: 'Minor', fix: '', why: 'x', term_s: '', term_t: '' }, o));
  const i1 = idxOf(S, 'carries the trust');
  if (i1) {
    add({ type: 'Terminology', severity: 'Query', s: [i1], t: [i1], source: 'carries the trust', target: 'genießt das Vertrauen', why: 'The meaning of T' + i1 + ' differs from S' + i1 + '.', term_s: 'carries the trust', term_t: 'genießt das Vertrauen' });
    const i2 = idxOf(S, 'Every evening');
    [['Every evening', 'Jeden Abend'], ['climbs', 'steigt'], ['two hundred steps', 'zweihundert Stufen'], ['the keeper', 'der Wärter'], ['steps', 'Stufen hinauf']]
      .forEach(([a, b]) => add({ type: 'Wording', severity: 'Note', s: [i2], t: [i2], source: a, target: b, why: 'Acceptable rewording.' }));
    const i4 = idxOf(S, 'pays him in gratitude');
    add({ type: 'Mistranslation', severity: 'Minor', s: [i4], t: [i4], source: 'pays him in gratitude', target: 'mit Dankbarkeit', why: 'Acceptable here, but the tone is slightly flatter.' });
  }
  const i3 = idxOf(S, 'keep watch through'), i10 = idxOf(S, 'boats keep watch');
  if (i3) add({ type: 'Terminology', severity: 'Minor', s: [i3], t: [i3], source: 'keep watch', target: 'Wache schiebt', why: 'Colloquial wording for keeping watch.', term_s: 'keep watch', term_t: 'Wache' });
  if (i10) add({ type: 'Terminology', severity: 'Minor', s: [i10], t: [i10], source: 'keep watch', target: 'Wache schieben', why: 'Colloquial wording for keeping watch.', term_s: 'keep watch', term_t: 'Wache' });
  const i8 = idxOf(S, 'Nobody remembers');
  if (i8) {
    add({ type: 'Omission', severity: 'Critical', s: [i8], t: [i8 - 1], source: 'Nobody remembers who owned the largest ship.', target: '', fix: 'Niemand erinnert sich, wem das größte Schiff gehörte.', why: 'The first sentence of S' + i8 + ' is missing; T' + i8 + ' repeats T' + (i8 - 1) + ' instead.' });
    add({ type: 'Addition', severity: 'Query', s: [], t: [i8], source: '', target: 'Schiffe kehren nur zu denen zurück, die die Lichter pflegen.', why: 'T' + i8 + ' repeats a sentence from the paragraph before it.' });
  }
  S.forEach((s, i) => { if (s === 'A good light never asks who is sailing.') add({ s: [i + 1], t: [i + 1], source: s, target: 'Ein gutes Licht fragt nie, wer segelt.', why: 'The image of sailing is narrowed.' }); });
  return { text: JSON.stringify({ alignment, issues }), inTok: 1000, outTok: 200 };
}

// ---------- the fake second look ----------
async function callSecond(system, user, meta) {
  calls.meaningSecond++;
  const key = meta.win.id; calls.secondAttempts[key] = (calls.secondAttempts[key] || 0) + 1;
  if (/The morning/.test(meta.win.label)) throw new Error('upstream failure');                                   // the second look fails for chapter 3
  const pairs = [...user.matchAll(/\[P(\d+)\]\nSOURCE: (.*)\nTRANSLATION: (.*)/g)].map((m) => ({ p: +m[1], s: m[2], t: m[3] }));
  const differs = [];
  pairs.forEach((pr) => {
    if (pr.s.includes('carries the trust')) differs.push({ p: pr.p, type: 'Terminology', severity: 'Minor', source: 'carries the trust', target: 'genießt das Vertrauen', fix: 'trägt das Vertrauen', why: 'Being trusted is not the same as carrying a trust.', term_s: 'carries the trust', term_t: 'genießt das Vertrauen' });
    if (pr.s.includes('for his advice')) differs.push({ p: pr.p, type: 'Mistranslation', severity: 'Critical', source: 'for his advice', target: 'damit er entscheiden konnte', fix: 'um seinen Rat einzuholen', why: 'Advising is changed into deciding.' });
  });
  let same = pairs.filter((pr) => !differs.some((d) => d.p === pr.p)).map((pr) => pr.p);
  if (/The storm/.test(meta.win.label) && meta.attempt === 0) same = same.slice(0, -1);                          // forgets one pair the first time
  return { text: JSON.stringify({ same: same.join(','), differs }), inTok: 700, outTok: 60 };
}

// ---------- run WITHOUT the second look: the clean-up alone ----------
const base = await TC.checkWindows(plan, srcDoc, tgtDoc, { callModel: callMain, srcLang: 'English', tgtLang: 'German' });
const rep0 = TC.buildReport(plan, srcDoc, tgtDoc, base, {});
t('no second look: no extra calls, no meaning coverage', calls.meaningMain + calls.meaningSecond === 0 && rep0.coverage.second === false && rep0.coverage.meaningPairs === 0);

// ---------- run WITH the second look (a separate model function) ----------
const calls0 = Object.assign({}, calls);
const state = await TC.checkWindows(plan, srcDoc, tgtDoc, { callModel: callMain, callModelSecond: callSecond, second: true, srcLang: 'English', tgtLang: 'German' });
const rep = TC.buildReport(plan, srcDoc, tgtDoc, state, {});
rep.issues.forEach((x) => console.log('  #' + x.id, x.type, x.severity, x.origin + (x.second ? '/' + x.second : ''), '|', x.tgtLoc, '|', (x.also ? 'also ' + x.also.map((a) => a.tgtLoc).join(', ') + ' | ' : '') + x.why.slice(0, 80)));
const real = rep.issues.filter((x) => x.severity !== 'Note');

// number rule
t('"800,000" vs "800.000" is no longer reported as a changed number', !rep.issues.some((x) => x.type === 'Number' && /800/.test(x.why)), JSON.stringify(rep.issues.filter((x) => x.type === 'Number').map((x) => x.why)));
t('a real change (12 -> 21) is still reported', rep.issues.some((x) => x.type === 'Number' && x.origin === 'rule' && /12/.test(x.why) && /21/.test(x.why)));

// labels
const trust = rep.issues.find((x) => x.termS === 'carries the trust');
t('"T3" / "S3" in the model\'s explanation become real paragraph numbers', trust && trust.why === 'The meaning of translation ¶1 differs from source ¶1.', trust && trust.why);
const lab = TC.relabel('T4 repeats S3, see T99.', plan.windows.find((w) => /The keeper/.test(w.label)));      // window numbering starts at the heading lines, so S3 = paragraph 1
t('relabel: window numbers become paragraph numbers, unknown numbers stay', lab === 'translation ¶2 repeats source ¶1, see T99.', lab);
t('no explanation still contains a window label like T3 or S12', !rep.issues.some((x) => /\b[ST]\d{1,3}\b/.test(x.why)), JSON.stringify(rep.issues.filter((x) => /\b[ST]\d{1,3}\b/.test(x.why)).map((x) => x.why)));

// twin
const ch2 = rep.issues.filter((x) => x.chapter === 2);
t('a missing sentence and its "addition" are one finding', ch2.filter((x) => x.type === 'Omission').length === 1 && !ch2.some((x) => x.type === 'Addition'), JSON.stringify(ch2.map((x) => x.type)));
t('the merged finding keeps Critical and says what happened', ch2.find((x) => x.type === 'Omission').severity === 'Critical' && /repeats other text here instead/.test(ch2.find((x) => x.type === 'Omission').why));

// verbatim repeat
const pq = rep.issues.filter((x) => x.srcText === 'A good light never asks who is sailing.');
t('a repeated pull-quote is one finding listing the other place', pq.length === 1 && pq[0].also && pq[0].also.length === 1 && pq[0].alsoCount === 1 && /Ch 3/.test(pq[0].also[0].tgtLoc), JSON.stringify(pq.map((x) => x.also)));

// recurring word choice
const kw = rep.issues.filter((x) => x.termS === 'keep watch');
t('a recurring word choice is one finding', kw.length === 1, kw.length + ' findings');
t('...listing the place the model reported AND the unreported place found by the portal', kw[0] && kw[0].alsoCount === 2 && kw[0].also.some((a) => /Ch 2/.test(a.tgtLoc)) && kw[0].also.some((a) => /Ch 3 ¶2/.test(a.tgtLoc)), JSON.stringify(kw[0] && kw[0].also));
t('...and counts once in the score', real.filter((x) => x.termS === 'keep watch').length === 1);

// notes
const ch1notes = rep.issues.filter((x) => x.chapter === 1 && x.severity === 'Note');
t('acceptable rewording is kept as quiet Notes, at most 3 from the model', ch1notes.filter((x) => x.why === 'Acceptable rewording.').length === 3, ch1notes.length + ' notes');
t('an explanation that calls itself acceptable becomes a Note', ch1notes.some((x) => /Acceptable here/.test(x.why)) && ch1notes.every((x) => x.type === 'Wording'));
const pen = real.reduce((a, x) => a + TC.SEV_WEIGHT[x.severity], 0);
t('Notes do not count towards the score', rep.score.penalty === pen && rep.score.counts.Note === rep.issues.length - real.length, rep.score.penalty + ' vs ' + pen);

// second look
t('second look: coverage says so', rep.coverage.second === true && rep.coverage.meaningPairs > 0 && rep.coverage.meaningChecked > 0, JSON.stringify(rep.coverage));
t('second look: a finding both looks made is more certain (Query -> Minor)', trust && trust.severity === 'Minor' && trust.second === 'agrees', JSON.stringify(trust && [trust.severity, trust.second]));
const adv = rep.issues.find((x) => /advice/.test(x.srcText));
t('second look: a finding only the second look made is added (capped at Major)', adv && adv.origin === 'ai2' && adv.severity === 'Major', JSON.stringify(adv && [adv.origin, adv.severity]));
const r2 = state.results.find((r) => r.win.id === 's2');
t('second look: a forgotten pair is asked for again and then judged', calls.secondAttempts.s2 === 2 && r2.meaning.checked === r2.meaning.pairs && r2.meaning.pairs > 0, JSON.stringify([calls.secondAttempts, r2.meaning]));
t('second look: a failing chapter does not fail the run', state.finished && rep.coverage.meaningFailed === 1 && rep.coverage.complete, JSON.stringify([state.finished, rep.coverage.meaningFailed, rep.coverage.complete]));
t('second look: the second model function was used for every meaning call', calls.meaningMain === 0 && calls.meaningSecond - calls0.meaningSecond >= 4);
t('second look: its tokens are tracked separately (the call that failed is not counted)', state.sCalls === calls.meaningSecond - calls0.meaningSecond - 1 && state.sInTok > 0 && state.sOutTok > 0 && state.inTok > state.sInTok, JSON.stringify([state.sCalls, state.sInTok, state.inTok]));

// estimate, share, csv
const e1 = TC.estimateRun(plan, {}), e2 = TC.estimateRun(plan, { second: true });
t('estimate: second look is reported separately and does not change the main estimate', e1.second === null && e2.second && e2.second.calls >= plan.windows.length && e2.inTok === e1.inTok, JSON.stringify([e1.second, e2.second]));
const big = { windows: Array.from({ length: 10 }, () => ({ src: new Array(30).fill(0), tgt: new Array(30).fill(0), estTokens: 5000 })) };
const eb = TC.estimateRun(big, { second: true });
t('estimate: for real-sized windows the second look reads about as much text as the first check', eb.second.inTok > eb.inTok * 0.6 && eb.second.inTok < eb.inTok * 1.1 && eb.second.outTok < eb.outTok * 0.5, JSON.stringify([eb.inTok, eb.second]));
const sh = TC.toShareIssues(rep.issues, 'English');
t('share payload leaves out Notes', sh.length === real.length && !sh.some((x) => x.severity === 'Note'));
t('share payload lists the other places in the explanation', /Also at: .*Ch 2/.test(sh.find((x) => /keep watch|Colloquial/.test(x.explanation)).explanation), sh.find((x) => /Colloquial/.test(x.explanation)).explanation);
t('csv rows match the header, with an "Also at" column', TC.CSV_HEAD.indexOf('Also at') > 0 && TC.toCsvRows(rep.issues).every((r) => r.length === TC.CSV_HEAD.length));
t('csv says which findings the second look confirmed or found', TC.toCsvRows(rep.issues).some((r) => /confirmed by a second look/.test(r[r.length - 1])) && TC.toCsvRows(rep.issues).some((r) => /AI, second look/.test(r[r.length - 1])));

console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
