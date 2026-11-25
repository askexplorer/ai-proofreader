// Offline test for docx-apply.js: apply reviewer answers to the ORIGINAL Word file (tracked changes + comments).
// Run: node tests/docx-apply.test.mjs   (Node 18+; needs `npm install` in tests/ for jszip and mammoth)
// Every .docx is built here from invented text (a lighthouse story); no real document is used.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import JSZip from 'jszip';
import mammoth from 'mammoth';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
if (!globalThis.crypto) globalThis.crypto = (await import('node:crypto')).webcrypto;
new Function(readFileSync(process.env.DA_PATH || path.join(root, 'docx-apply.js'), 'utf8'))();
const DA = globalThis.DA; DA.setZip(JSZip);
let pass = 0, fail = 0;
const ok = (c, n, x) => { if (c) pass++; else { fail++; console.log('FAIL  ' + n + (x ? '  ' + x : '')); } };
const NF = { createFolders: false };

// ------------------------------------------------------------------ building small Word files
const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const T = (s) => '<w:t xml:space="preserve">' + esc(s) + '</w:t>';
const R = (s, rpr) => '<w:r>' + (rpr ? '<w:rPr>' + rpr + '</w:rPr>' : '') + T(s) + '</w:r>';
const P = (...runs) => '<w:p><w:pPr><w:pStyle w:val="Body"/></w:pPr>' + runs.join('') + '</w:p>';
const BOLD = '<w:b/>', ARABIC = '<w:rFonts w:cs="Arial"/><w:rtl/>';
const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';
async function mkdocx(body, o = {}) {
  const z = new JSZip();
  z.file('[Content_Types].xml', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="png" ContentType="image/png"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>' + (o.comments ? '<Override PartName="/word/comments.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.comments+xml"/>' : '') + '</Types>', NF);
  z.file('_rels/.rels', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>', NF);
  z.file('word/_rels/document.xml.rels', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>' + (o.comments ? '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/comments" Target="comments.xml"/>' : '') + '</Relationships>', NF);
  z.file('word/styles.xml', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:styles ' + W + '><w:style w:type="paragraph" w:styleId="Body"><w:name w:val="Body"/></w:style></w:styles>', NF);
  z.file('word/media/image1.png', new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0, 1, 2, 3, 250, 251, 252]), NF);
  z.file('word/document.xml', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document ' + W + '><w:body>' + body + '<w:sectPr><w:pgSz w:w="11906" w:h="16838"/></w:sectPr></w:body></w:document>', NF);
  if (o.comments) z.file('word/comments.xml', o.comments, NF);
  return z.generateAsync({ type: 'uint8array', compression: 'DEFLATE' });
}
// a finding as the feedback window hands it over: d = agree | edit | disagree | none; fin = the text to use
let seq = 0;
const it = (original, d, fin, x = {}) => Object.assign({ id: ++seq, type: 'Mistranslation', severity: 'Major', loc: 'Ch 1 ¶1', page: null, context: '', original, corrected: fin, decision: d, final: d === 'agree' || d === 'edit' ? fin : null, comment: '', insert: false }, x);
async function docXml(u8) { return (await JSZip.loadAsync(u8)).file('word/document.xml').async('string'); }
const text = async (u8, which) => { const z = await JSZip.loadAsync(u8); return DA._internals.readText(await z.file('word/document.xml').async('string'), which || 'accepted'); };
const parasText = async (u8, which) => { const x = await docXml(u8), sp = DA._internals.paragraphSpans(x); return sp.map((s) => DA._internals.readText(x.slice(s.start, s.end), which).replace(/ +/g, ' ').trim()); };
const mam = async (u8) => (await mammoth.extractRawText({ buffer: Buffer.from(u8) })).value.replace(/\n\n/g, '|');
const run = (docx, items, o) => DA.run(docx, items, Object.assign({ author: 'Ana Reviewer', date: '2026-11-10T18:38:00Z' }, o || {}));
const ledgerOf = (res, id) => res.ledger.find((l) => l.id === id);

// ------------------------------------------------------------------ 1. a plain replacement, a pure insertion, a deletion
{
  const body = P(R('The keeper climbed the stairs every evening before dusk.')) + P(R('The lamp was lit by hand each night.')) + P(R('He was a very very tired man.'));
  const docx = await mkdocx(body);
  const a = it('climbed the stairs', 'agree', 'climbed the iron stairs'), b = it('lit by hand each night', 'edit', 'lit by hand every night'), c = it('very very tired', 'agree', 'very tired');
  const res = await run(docx, [a, b, c]);
  ok(res.receipt.ok, 'plain edits: every self-check passes', JSON.stringify(res.receipt.checks.filter((x) => !x.ok)));
  ok(res.totals.applied === 3 && res.totals.manual === 0, 'plain edits: 3 applied');
  ok(await text(res.files.tracked, 'accepted') === 'The keeper climbed the iron stairs every evening before dusk.The lamp was lit by hand every night.He was a very tired man.', 'plain edits: accepted text is right', await text(res.files.tracked));
  ok(await text(res.files.tracked, 'rejected') === 'The keeper climbed the stairs every evening before dusk.The lamp was lit by hand each night.He was a very very tired man.', 'plain edits: rejecting gives the original');
  const x = await docXml(res.files.tracked);
  ok(/<w:ins [^>]*w:author="Ana Reviewer"[^>]*w:date="2026-11-10T18:38:00Z"/.test(x), 'plain edits: tracked insertion carries author and date');
  ok((x.match(/<w:del /g) || []).length === 2 && (x.match(/<w:ins /g) || []).length === 2, 'plain edits: minimal changes (one insertion only, two replacements/deletion)', (x.match(/<w:del /g) || []).length + '/' + (x.match(/<w:ins /g) || []).length);
  ok(/<w:delText xml:space="preserve">each<\/w:delText>/.test(x) && /<w:t xml:space="preserve">every<\/w:t>/.test(x), 'plain edits: only the changed word is marked (each -> every)');
  ok(await text(res.files.clean, 'accepted') === await text(res.files.tracked, 'accepted') && !/<w:ins |<w:del /.test(await docXml(res.files.clean)), 'plain edits: the clean copy has the same text and no tracked changes');
  ok(await mam(res.files.tracked) === await mam(res.files.clean) && (await mam(res.files.clean)).includes('iron stairs'), 'plain edits: an independent reader (mammoth) agrees');
  ok(res.gate.ok && res.gate.found === 3, 'plain edits: the right-file check passes');
}

// ------------------------------------------------------------------ 2. a replacement across runs with different formatting keeps the formatting
{
  const body = P(R('The lamp '), R('was lit by hand', BOLD), R(' each night, never by machine.'));
  const docx = await mkdocx(body);
  const res = await run(docx, [it('lit by hand each night', 'agree', 'kindled manually every night')]);
  ok(res.receipt.ok && res.totals.applied === 1, 'across runs: applied and verified', JSON.stringify(res.receipt.checks.filter((x) => !x.ok)));
  const x = await docXml(res.files.tracked);
  ok(/<w:rPr><w:b\/><\/w:rPr><w:t xml:space="preserve">kindled/.test(x), 'across runs: the new text takes the bold of the text it replaces');
  ok(await text(res.files.tracked, 'accepted') === 'The lamp was kindled manually every night, never by machine.', 'across runs: accepted text', await text(res.files.tracked));
  ok(await text(res.files.tracked, 'rejected') === 'The lamp was lit by hand each night, never by machine.', 'across runs: rejected text');
}

// ------------------------------------------------------------------ 3. comments: on a disagreed finding, on a change, merged into an existing comments part
{
  const body = P(R('The keeper climbed the stairs every evening.')) + P(R('The sea was calm.')) + P(R('Nobody came.'));
  const docx = await mkdocx(body);
  const dis = it('The sea was calm', 'disagree', null, { comment: 'The calm sea is in the source too.' });
  const dis2 = it('Nobody came', 'disagree', null);
  const ed = it('climbed the stairs', 'agree', 'climbed the long stairs', { comment: 'Yes, but check the length.' });
  const res = await run(docx, [dis, dis2, ed]);
  ok(res.receipt.ok, 'comments: every self-check passes', JSON.stringify(res.receipt.checks.filter((x) => !x.ok)));
  ok(ledgerOf(res, dis.id).outcome === 'commented' && ledgerOf(res, dis2.id).outcome === 'kept' && ledgerOf(res, ed.id).outcome === 'applied', 'comments: disagreed+comment = comment only; disagreed without comment = left alone');
  const z = await JSZip.loadAsync(res.files.tracked), cx = await z.file('word/comments.xml').async('string'), x = await docXml(res.files.tracked);
  ok((cx.match(/<w:comment /g) || []).length === 2 && cx.includes('w:author="Ana Reviewer"') && cx.includes('w:initials="AR"'), 'comments: two comments with author and initials');
  ok(cx.includes('The calm sea is in the source too.') && cx.includes('Yes, but check the length.'), 'comments: the reviewer\'s words are in the comments');
  ok(/<w:commentRangeStart w:id="(\d+)"\/>[^]*?The sea was calm[^]*?<w:commentRangeEnd w:id="\1"\/><w:r><w:commentReference w:id="\1"\/>/.test(x), 'comments: the comment is anchored on the passage');
  ok(/(Content_Types[^]*)/.test('') || (await z.file('[Content_Types].xml').async('string')).includes('/word/comments.xml'), 'comments: content type added');
  ok((await z.file('word/_rels/document.xml.rels').async('string')).includes('Target="comments.xml"'), 'comments: relationship added');
  ok(await text(res.files.tracked, 'accepted') === 'The keeper climbed the long stairs every evening.The sea was calm.Nobody came.', 'comments: texts untouched except the agreed change');
  ok(!(await text(res.files.clean, 'accepted')).includes('undefined') && (await JSZip.loadAsync(res.files.clean)).file('word/comments.xml'), 'comments: the clean copy keeps the comments');
  // an existing comments part is extended, never replaced
  const old = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:comments ' + W + '><w:comment w:id="7" w:author="Old" w:date="2025-01-01T00:00:00Z" w:initials="O"><w:p><w:r><w:t>old note</w:t></w:r></w:p></w:comment></w:comments>';
  const docx2 = await mkdocx(body.replace('The sea was calm.', '<w:commentRangeStart w:id="7"/>The sea was calm.<w:commentRangeEnd w:id="7"/><w:r><w:commentReference w:id="7"/></w:r>'), { comments: old });
  const res2 = await run(docx2, [dis]);
  const cx2 = await (await JSZip.loadAsync(res2.files.tracked)).file('word/comments.xml').async('string');
  ok(res2.receipt.ok && cx2.includes('old note') && cx2.includes('The calm sea is in the source too.') && !/w:id="7"[^]*w:id="7"/.test(cx2.replace(/w:id="7"/, 'X')) && (cx2.match(/<w:comment /g) || []).length === 2, 'comments: an existing comments part is kept and extended', JSON.stringify(res2.receipt.checks.filter((x) => !x.ok)));
  const rels2 = await (await JSZip.loadAsync(res2.files.tracked)).file('word/_rels/document.xml.rels').async('string');
  ok((rels2.match(/Target="comments.xml"/g) || []).length === 1, 'comments: no second relationship when one exists');
}

// ------------------------------------------------------------------ 4. several places with the same words: sentence first, then page, else "needs you"
{
  const lb = '<w:r><w:lastRenderedPageBreak/></w:r>';
  const body = P(R('He waited for the boat all day.')) + P(R('He waited for the boat, again.')) + P(R('It rained.')) + P(lb + R('It rained.')) + P(lb + R('It rained.'));
  const docx = await mkdocx(body);
  const bySentence = it('waited for the boat', 'agree', 'waited for the ferry', { context: 'He waited for the boat, again.' });
  const byPage = it('It rained.', 'agree', 'It poured.', { page: 3 });
  const stuck = it('It rained.', 'agree', 'It drizzled.', { page: 0 });
  const res = await run(docx, [bySentence, byPage, stuck]);
  ok(ledgerOf(res, bySentence.id).outcome === 'applied' && ledgerOf(res, byPage.id).outcome === 'applied', 'repeats: settled by the sentence and by the page');
  ok(ledgerOf(res, stuck.id).outcome === 'manual' && /3 places|places/.test(ledgerOf(res, stuck.id).detail), 'repeats: with nothing to settle it the finding is left for the person', ledgerOf(res, stuck.id).detail);
  ok(await text(res.files.tracked, 'accepted') === 'He waited for the boat all day.He waited for the ferry, again.It rained.It rained.It poured.', 'repeats: only the right places changed', await text(res.files.tracked));
  ok(res.receipt.ok, 'repeats: self-checks pass', JSON.stringify(res.receipt.checks.filter((x) => !x.ok)));
  ok((await docXml(res.files.tracked)).includes('DO BY HAND') === false && (await (await JSZip.loadAsync(res.files.tracked)).file('word/comments.xml')) === null, 'repeats: no note is invented where the sentence is also unclear');
}

// ------------------------------------------------------------------ 5. things the engine will not touch, and says so
{
  const body = P(R('Name:'), '<w:r><w:tab/></w:r>', R('Harold')) + P('<w:hyperlink r:id="rId9">' + R('click here') + '</w:hyperlink>', R(' to read more.')) +
    P(R('Some '), '<w:ins w:id="50" w:author="Old" w:date="2025-01-01T00:00:00Z">' + R('new bit') + '</w:ins>', R(' text.')) + P(R('Keep '), '<w:del w:id="51" w:author="Old" w:date="2025-01-01T00:00:00Z"><w:r><w:delText>old </w:delText></w:r></w:del>', R('this.')) +
    P(R('The keeper climbed the stairs every evening before dusk.')) + P(R('Where the stairs end.'));
  const docx = await mkdocx(body);
  const tab = it('Name: Harold', 'agree', 'Name - Harold', { context: 'Name: Harold' });                       // the change itself crosses the tab (a tab is only a space to the checker, so changing Harold alone would be fine)
  const link = it('click here', 'agree', 'press here');
  const ins = it('new bit', 'agree', 'fresh bit');
  const del = it('Keep this.', 'agree', 'Hold that.');
  const trunc = it('The keeper climbed...', 'agree', 'The keeper ran', { context: 'The keeper climbed the stairs every evening before dusk.' });
  const none = it('', 'agree', 'whatever', { type: 'Number', context: 'Where the stairs end.' });
  const gone = it('this sentence is not in the file', 'agree', 'x');
  const res = await run(docx, [tab, link, ins, del, trunc, none, gone]);
  const why = (i) => ledgerOf(res, i.id);
  ok(why(tab).outcome === 'manual' && /tab/.test(why(tab).detail), 'left alone: a range containing a tab', why(tab).detail);
  ok(why(link).outcome === 'manual' && /link/.test(why(link).detail), 'left alone: text inside a link', why(link).detail);
  ok(why(ins).outcome === 'manual' && /tracked change|link/.test(why(ins).detail), 'left alone: text inside someone else\'s tracked insertion', why(ins).detail);
  ok(why(del).outcome === 'manual' && /tracked change/.test(why(del).detail), 'left alone: a range that crosses someone else\'s deleted text', why(del).detail);
  ok(why(trunc).outcome === 'manual' && /part of the passage/.test(why(trunc).detail), 'left alone: a quote shortened with "..."', why(trunc).detail);
  ok(why(none).outcome === 'manual' && /no exact words/.test(why(none).detail), 'left alone: no exact words given', why(none).detail);
  ok(why(gone).outcome === 'manual' && /not found/.test(why(gone).detail), 'left alone: words not in this file', why(gone).detail);
  const cx = await (await JSZip.loadAsync(res.files.tracked)).file('word/comments.xml').async('string');
  ok(/DO BY HAND \(#\d+, Agreed\): replace "The keeper climbed\.\.\." with "The keeper ran"/.test(cx) && /replace "" with "whatever"/.test(cx), 'left alone: a visible "do by hand" comment sits on the sentence where it can be found');
  ok(res.totals.manual === 7 && res.totals.applied === 0, 'left alone: nothing was changed by guessing');
  ok(res.receipt.ok, 'left alone: self-checks pass', JSON.stringify(res.receipt.checks.filter((x) => !x.ok)));
  ok(res.gate.quotes === 6 && res.gate.found === 5 && res.gate.ok === false, 'left alone: right-file check counts the words it could not find', JSON.stringify(res.gate));
  ok(await text(res.files.tracked, 'rejected') === await text(docx, 'rejected'), 'left alone: the text is exactly as before');
}

// ------------------------------------------------------------------ 6. whitespace, quotes, special characters, right-to-left
{
  const body = P(R('It’s late at Mile End, said the "keeper".')) + P(R('Salt & spray <fresh>.')) + P(R('مرحبا بالعالم الجميل', ARABIC));
  const docx = await mkdocx(body);
  const a = it("It's late at Mile End", 'agree', 'It’s early at Mile End');
  const b = it('spray', 'agree', 'spray & foam > <fresh>');
  const c = it('الجميل', 'agree', 'الكبير');
  const res = await run(docx, [a, b, c]);
  ok(res.receipt.ok && res.totals.applied === 3, 'characters: nbsp, curly quotes, & < > and Arabic all applied and verified', JSON.stringify(res.receipt.checks.filter((x) => !x.ok)) + ' ' + JSON.stringify(res.totals));
  const t = await text(res.files.tracked, 'accepted');
  ok(t.includes('It’s early at Mile End') && t.includes('Salt & spray & foam > <fresh> <fresh>.') && t.includes('مرحبا بالعالم الكبير'), 'characters: accepted text is exact', t);
  ok(/<w:rPr><w:rFonts w:cs="Arial"\/><w:rtl\/><\/w:rPr><w:t xml:space="preserve">الكبير/.test(await docXml(res.files.tracked)), 'characters: the Arabic replacement keeps the right-to-left run properties');
  ok(await mam(res.files.tracked) === await mam(res.files.clean), 'characters: mammoth reads both files the same');
}

// ------------------------------------------------------------------ 7. a paragraph missing in the translation is inserted as a new tracked paragraph
{
  const body = P(R('The storm ended at dawn.')) + P(R('Nobody spoke of it again.'));
  const docx = await mkdocx(body);
  const miss = it('', 'agree', 'The light went out.', { type: 'Omission', insert: true, context: 'The storm ended at dawn.', comment: 'Good catch.' });
  const miss2 = it('', 'disagree', null, { type: 'Omission', insert: true, context: 'Nobody spoke of it again.' });
  const res = await run(docx, [miss, miss2]);
  ok(res.receipt.ok && ledgerOf(res, miss.id).outcome === 'applied' && ledgerOf(res, miss2.id).outcome === 'kept', 'insert: new paragraph applied, disagreed omission left alone', JSON.stringify(res.receipt.checks.filter((x) => !x.ok)));
  ok(await text(res.files.tracked, 'accepted') === 'The storm ended at dawn.The light went out.Nobody spoke of it again.', 'insert: accepted text', await text(res.files.tracked));
  ok(await text(res.files.tracked, 'rejected') === 'The storm ended at dawn.Nobody spoke of it again.', 'insert: rejecting removes the new paragraph\'s text');
  const x = await docXml(res.files.tracked);
  ok(/<w:pPr><w:pStyle w:val="Body"\/><w:rPr><w:ins [^>]*\/><\/w:rPr><\/w:pPr>/.test(x), 'insert: the new paragraph copies the style and its paragraph mark is a tracked insertion');
  ok(/Good catch\./.test(await (await JSZip.loadAsync(res.files.tracked)).file('word/comments.xml').async('string')), 'insert: the reviewer comment is on the new paragraph');
  ok((await mam(res.files.clean)) === 'The storm ended at dawn.|The light went out.|Nobody spoke of it again.|', 'insert: the clean copy has the paragraph');
}

// ------------------------------------------------------------------ 8. two findings on the same words
{
  const body = P(R('Chapter 7 begins here.'));
  const docx = await mkdocx(body);
  const a = it('Chapter 7', 'agree', 'Chapter 17', { type: 'Structure' }), b = it('Chapter 7', 'agree', 'Chapter 17', { type: 'Number' });
  const res = await run(docx, [a, b]);
  ok(res.counts.edits === 1 && res.totals.applied === 2 && /same change as #/.test(ledgerOf(res, b.id).detail) && res.receipt.ok, 'overlap: the same change asked twice is made once and both are accounted for', JSON.stringify(res.totals));
  const c = it('Chapter 7 begins', 'agree', 'Chapter 17 starts'), d = it('7 begins here', 'agree', '7 starts here');
  const res2 = await run(docx, [c, d]);
  ok(res2.totals.applied === 1 && res2.totals.manual === 1 && /overlaps/.test(ledgerOf(res2, d.id).detail) && res2.receipt.ok, 'overlap: two different changes to the same words never both go in', JSON.stringify(res2.totals));
}

// ------------------------------------------------------------------ 9. the checks catch damage (the output is corrupted on purpose)
{
  const body = P(R('The keeper climbed the stairs.')) + P(R('The sea was calm.')) + P(R('Nobody came.'));
  const docx = await mkdocx(body), f = it('climbed the stairs', 'agree', 'climbed the steps');
  const base = await run(docx, [f]); ok(base.receipt.ok, 'damage: undamaged output passes');
  const bad = async (mut, label, mz) => { const r = await run(docx, [f], { _mutate: mut, _mutateZip: mz }); ok(!r.receipt.ok, 'damage: ' + label + ' is detected', JSON.stringify(r.receipt.checks.filter((x) => !x.ok).map((x) => x.name))); };
  await bad((x) => x.replace('The sea was calm.', 'The sea was rough.'), 'a changed word in an untouched paragraph');
  await bad((x) => x.replace('<w:ins ', '<w:xxx ').replace('</w:ins>', '</w:xxx>'), 'a lost insertion');
  await bad((x, w) => w === 'tracked' ? x.replace('<w:delText xml:space="preserve">', '<w:delText xml:space="preserve">X') : x, 'a deleted text that no longer matches the original');
  await bad((x) => x.replace('<w:p>', '<w:p></w:p><w:p>'), 'an extra paragraph');
  await bad((x) => x.replace('<w:pgSz w:w="11906"', '<w:pgSz w:w="11900"'), 'a changed page setup');
  await bad((x) => x.replace('</w:body>', '<w:p></w:body>'), 'broken XML');
  await bad(null, 'a changed style file', async (z) => z.file('word/styles.xml', '<x/>', NF));
  await bad(null, 'a changed picture', async (z) => z.file('word/media/image1.png', new Uint8Array([1, 2, 3]), NF));
  await bad(null, 'an added file', async (z) => z.file('word/extra.xml', '<x/>', NF));
}

// ------------------------------------------------------------------ 10. the package and the fingerprint
{
  const body = P(R('The keeper climbed the stairs.')) + P(R('Nobody came.')) + '<w:p/>' + P(R('The end.'));
  const docx = await mkdocx(body), res = await run(docx, [it('climbed the stairs', 'agree', 'climbed the iron stairs')]);
  const z0 = await JSZip.loadAsync(docx), z1 = await JSZip.loadAsync(res.files.tracked);
  ok(Object.keys(z1.files).sort().join() === Object.keys(z0.files).sort().join(), 'package: same file list (no folder entries added)', Object.keys(z1.files).join());
  const same = async (n) => (await z0.file(n).async('string')) === (await z1.file(n).async('string'));
  ok(await same('word/styles.xml') && await same('_rels/.rels') && await same('word/_rels/document.xml.rels') && await same('[Content_Types].xml'), 'package: styles and lists untouched when there are no comments');
  ok((await z0.file('word/media/image1.png').async('uint8array')).join() === (await z1.file('word/media/image1.png').async('uint8array')).join(), 'package: pictures byte-identical');
  ok((await docXml(res.files.tracked)).includes('<w:p/>'), 'package: empty paragraphs are kept');
  const f1 = await DA.fingerprint(docx), f2 = await DA.fingerprint(docx), f3 = await DA.fingerprint(res.files.clean);
  ok(f1.n === 3 && f1.words === 9 && /^[0-9a-f]{64}$/.test(f1.sha) && f1.sha === f2.sha && f1.sha !== f3.sha, 'fingerprint: stable for the same file, different once the text changed', JSON.stringify(f1));
  ok(DA.compareFingerprint(f1, f2).level === 'exact' && DA.compareFingerprint(f1, f3).same === false, 'fingerprint: compares exact / differs');
  ok(DA.compareFingerprint(null, f1, 9).level === 'rough' && DA.compareFingerprint(null, f1, 100).same === false && DA.compareFingerprint(null, f1).level === 'unknown', 'fingerprint: old reviews fall back to the word count');
  const none = await run(docx, [it('Nobody came.', 'disagree', null)]);
  ok(none.files.tracked === null && none.totals.kept === 1 && none.receipt.ok, 'package: nothing to change = no file is produced');
  let msg = ''; try { await run(new Uint8Array([1, 2, 3]), []); } catch (e) { msg = e.message; }
  ok(/could not be opened as a Word document/.test(msg), 'package: a file that is not a .docx gives a plain message', msg);
  const z = new JSZip(); z.file('hello.txt', 'hi'); msg = ''; try { await run(await z.generateAsync({ type: 'uint8array' }), []); } catch (e) { msg = e.message; }
  ok(/not a Word document/.test(msg), 'package: a zip that is not a Word file gives a plain message', msg);
}

// ------------------------------------------------------------------ 11. the report: every finding exactly one outcome, and the CSV says so
{
  const body = P(R('One two three four.')) + P(R('Five six.'));
  const docx = await mkdocx(body);
  const items = [it('two three', 'agree', '2 3'), it('Five', 'disagree', null, { comment: 'keep' }), it('six', 'none', null), it('seven', 'edit', 'sieben'), it('One', 'edit', 'One')];
  const res = await run(docx, items);
  const t = res.totals;
  ok(t.sent === 5 && t.applied + t.already + t.commented + t.kept + t.manual === 5, 'report: the outcomes add up to the findings sent', JSON.stringify(t));
  ok(t.applied === 1 && t.commented === 1 && t.kept === 1 && t.manual === 1 && t.already === 1, 'report: applied / comment / kept / needs you / already', JSON.stringify(t));
  ok(res.toApply === 3 && t.applied + t.already + res.ledger.filter((l) => l.outcome === 'manual' && l.use !== '').length === res.toApply, 'report: everything to apply is applied, already so, or listed for the person');
  ok(res.csv.split('\r\n').length === 6 && /NEEDS YOU/.test(res.csv) && /Applied in Word/.test(res.csv), 'report: the CSV has one line per finding');
}

// ------------------------------------------------------------------ 11b. "Agree" on a finding with no wording never deletes text
{
  const body = P(R('The keeper climbed the stairs every evening.')) + P(R('Nobody came.'));
  const docx = await mkdocx(body);
  const noFix = it('climbed the stairs', 'agree', null, { corrected: '', comment: 'yes, this is wrong' });                  // agreed, but the finding had no wording
  const noFix2 = it('', 'agree', null, { corrected: '', type: 'Omission', insert: true, context: 'Nobody came.' });
  const res = await run(docx, [noFix, noFix2]);
  ok(res.totals.manual === 2 && res.totals.applied === 0 && res.counts.edits === 0, 'agree without wording: nothing is changed, both are listed for the person', JSON.stringify(res.totals));
  ok(/no wording was suggested/.test(ledgerOf(res, noFix.id).detail), 'agree without wording: the reason is stated', ledgerOf(res, noFix.id).detail);
  const cx = await (await JSZip.loadAsync(res.files.tracked)).file('word/comments.xml').async('string');
  ok(/DO BY HAND \(#\d+, Agreed\)/.test(cx) && /yes, this is wrong/.test(cx), 'agree without wording: a "do by hand" comment carries the reviewer\'s words', cx.slice(0, 200));
  ok(await text(res.files.tracked, 'accepted') === 'The keeper climbed the stairs every evening.Nobody came.' && res.receipt.ok, 'agree without wording: the text is untouched and the checks pass', await text(res.files.tracked, 'accepted'));
}

// ------------------------------------------------------------------ 11c. the sentence's full stop is never doubled (seen in real Word: "estar bien..")
{
  const body = P(R('Every child walks to school safe, calm and without fear.')) + P(R('He came home late, tired.')) + P(R('She waited.')) + P(R('It ended late.'));
  const docx = await mkdocx(body);
  const a = it('safe, calm and without fear', 'edit', 'safe, calm, fearless and with all they need to be well.');         // the reviewer typed the final full stop; the document already has one after the quote
  const b = it('home late', 'edit', 'back early,');                                                                       // a comma that is already there
  const c = it('waited', 'edit', 'waited.');                                                                              // nothing to change once the stop is not doubled
  const d = it('ended late.', 'edit', 'ended early.');                                                                     // the quote itself includes the stop: no change of behaviour
  const res = await run(docx, [a, b, c, d]);
  const t = await text(res.files.tracked, 'accepted');
  ok(t === 'Every child walks to school safe, calm, fearless and with all they need to be well.He came back early, tired.She waited.It ended early.', 'full stop: never doubled, never lost', t);
  ok(res.receipt.ok && /full stop that already follows/.test(ledgerOf(res, a.id).detail) && ledgerOf(res, c.id).outcome === 'already', 'full stop: the report says what happened and a no-op is "already as suggested"', JSON.stringify([ledgerOf(res, a.id).detail, ledgerOf(res, c.id).outcome]));
  ok(await text(res.files.tracked, 'rejected') === 'Every child walks to school safe, calm and without fear.He came home late, tired.She waited.It ended late.', 'full stop: rejecting gives the original');
}

// ------------------------------------------------------------------ 11d. the checker's form of the text: NFC and no zero-width marks (found with a real Hindi file: 242 characters differ under NFC)
{
  const E = 'é', EC = 'é';                                               // "e" + combining acute vs the composed e-acute (NFC)
  const NN = 'ऩ', NNC = 'ऩ';                                             // Devanagari NA + nukta vs the composed letter (NFC)
  const body = P(R('The Caf' + E + ' au lait is nice.')) + P(R('Start ' + NN + 'ab and the rest of this line.')) + P(R('A w​o​rd hidden inside.')) + P(R('Caf' + E + ' noir.'));
  const docx = await mkdocx(body);
  const a = it('Caf' + EC + ' au lait', 'edit', 'Caf' + EC + ' noir');                    // the finding is in NFC, the file is not
  const b = it('Start ' + NNC + 'ab and', 'agree', 'Start ' + NNC + 'xy and');
  const c = it('word hidden', 'edit', 'term hidden');                                     // zero-width marks inside the word
  const d = it('Caf' + EC + ' noir.', 'edit', 'Caf' + EC + ' noir.');                      // differs from the file only in the form of one letter: nothing to change
  const res = await run(docx, [a, b, c, d]);
  const t = await text(res.files.tracked, 'accepted');
  ok(res.receipt.ok && res.totals.applied === 3 && ledgerOf(res, d.id).outcome === 'already', 'NFC: findings written in NFC are found in a file that stores the letters decomposed', JSON.stringify(res.totals) + JSON.stringify(res.receipt.checks.filter((x) => !x.ok)));
  ok(t.includes('The Caf' + E + ' noir is nice.') && t.includes('Start ' + NNC + 'xy and the rest') && t.includes('A term hidden inside.') && t.includes('Caf' + E + ' noir.'), 'NFC: only the words that change are touched (a replaced word carries the reviewer\'s characters); the file keeps its own characters elsewhere', JSON.stringify(t));
  ok(res.gate.found === 4 && res.gate.ok, 'NFC: the right-file check counts them as found', JSON.stringify(res.gate));
  // the reviewer's own characters (a zero-width non-joiner) go into the file untouched
  const z = await run(await mkdocx(P(R('Say old now.'))), [it('old', 'edit', 'ne‌w')]);
  ok((await text(z.files.tracked, 'accepted')) === 'Say ne‌w now.', 'NFC: zero-width marks the reviewer typed are kept in the new words');
  // fingerprints of reviews made before the fix must still match
  const fp = await DA.fingerprint(docx), oldFold = (s) => { let o = '', sp = false; for (const ch of s) { if (/[​‌‍⁠﻿­]/.test(ch)) continue; if (/\s/.test(ch)) { if (!sp) o += ' '; sp = true; continue; } sp = false; o += ch; } return o; };
  const texts = ['The Caf' + E + ' au lait is nice.', 'Start ' + NN + 'ab and the rest of this line.', 'A word hidden inside.', 'Caf' + E + ' noir.'].map(oldFold);
  const want = Array.from(new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(texts.join('\n'))))).map((x) => x.toString(16).padStart(2, '0')).join('');
  ok(fp.sha === want && fp.n === 4, 'fingerprint: unchanged by the NFC fix, so fingerprints stored by v5.4.0 still match', fp.sha + ' vs ' + want);
}

// ------------------------------------------------------------------ 11e. changes that deserve a second look still go in, with a CHECK comment
{
  const body = P(R('The keeper climbed the old stone stairs every single evening before dusk.')) + P(R('The storm ended at dawn and the light went out slowly.')) + P(R('Signed, Harold.')) + P(R('Some text.')) + P(R('Signed, Harold.')) + P(R('More text.')) + P(R('Signed, Harold.')) + P(R('The sea was calm and the keeper slept well.'));
  const docx = await mkdocx(body);
  const big = it('The keeper climbed the old stone stairs every single evening before dusk.', 'agree', 'Nobody ever visited the harbour during winter months at all.');
  const dup = it('', 'agree', 'The light went out slowly after the storm.', { type: 'Omission', insert: true, context: 'The storm ended at dawn and the light went out slowly.' });
  const sig = it('', 'agree', 'A completely different missing paragraph about the harbour.', { type: 'Omission', insert: true, context: 'Signed, Harold.', page: null });
  const fine = it('calm', 'agree', 'quiet');
  const res = await run(docx, [big, dup, sig, fine]);
  ok(res.receipt.ok && ledgerOf(res, big.id).outcome === 'applied' && /almost none of its words/.test(ledgerOf(res, big.id).flag), 'check: a change that shares almost no words with the passage is applied AND flagged', JSON.stringify(res.ledger.map((l) => [l.id, l.outcome, l.flag])));
  ok(/already appears in the paragraph it follows/.test(ledgerOf(res, dup.id).flag), 'check: an inserted paragraph whose sentences already stand next to it is flagged as a possible duplicate', ledgerOf(res, dup.id).flag);
  ok(ledgerOf(res, sig.id).outcome === 'manual' || /occurs 3 times/.test(ledgerOf(res, sig.id).flag), 'check: an insertion after a short line that repeats is flagged (or left alone when the place cannot be settled)', JSON.stringify(ledgerOf(res, sig.id)));
  ok(ledgerOf(res, fine.id).outcome === 'applied' && !ledgerOf(res, fine.id).flag, 'check: an ordinary change carries no flag');
  const cx = await (await JSZip.loadAsync(res.files.tracked)).file('word/comments.xml').async('string');
  ok(/CHECK \(#\d+, Agreed\): it replaces this passage/.test(cx) && /CHECK \(#\d+, Agreed\): part of this text already appears/.test(cx), 'check: the CHECK comments are in the Word file', cx.slice(0, 160));
  ok(res.csv.split('\r\n')[0].includes('Check this') && /shares almost none/.test(res.csv), 'check: the report CSV has a "Check this" column');
}

// ------------------------------------------------------------------ 11f. the new words take the format that most of the replaced words had
{
  const body = P(R('The ', BOLD), R('quick brown fox jumps over', '<w:i/>'), R(' the dog.'));
  const docx = await mkdocx(body);
  const res = await run(docx, [it('The quick brown fox', 'agree', 'A slow gray fox')]);
  const x = await docXml(res.files.tracked);
  ok(res.receipt.ok && /<w:ins [^>]*><w:r><w:rPr><w:i\/><\/w:rPr><w:t xml:space="preserve">A slow gray fox/.test(x) || /<w:ins [^>]*><w:r><w:rPr><w:i\/><\/w:rPr><w:t xml:space="preserve">[^<]*slow/.test(x), 'format: the new words are italic like most of the replaced words, not bold like the first fragment', x.slice(x.indexOf('<w:ins'), x.indexOf('<w:ins') + 220));
}

// ------------------------------------------------------------------ 12. random paragraphs: random run splits, bookmarks, page markers, edits and comments, checked against plain string replacement
{
  let s = 12345; const rnd = () => { s |= 0; s = (s + 0x6D2B79F5) | 0; let t = Math.imul(s ^ (s >>> 15), 1 | s); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  const pick = (a) => a[Math.floor(rnd() * a.length)], RP = ['', BOLD, '<w:i/>', '<w:b/><w:i/>'];
  let rounds = 0, good = 0, edits = 0, comms = 0; const bad = [];
  for (let r = 0; r < 150; r++) {
    const nP = 1 + Math.floor(rnd() * 3), paras = [], wordsOf = []; let n = 0;
    for (let p = 0; p < nP; p++) { const k = 4 + Math.floor(rnd() * 9), w = []; for (let i = 0; i < k; i++) w.push('w' + (n++) + pick(['', ',', '.', '', ''])); wordsOf.push(w); paras.push(w.join(' ')); }
    // items: disjoint word spans, each with a unique quote
    const items = [], exp = paras.slice();
    wordsOf.forEach((w, pi) => {
      let i = 0; const spans = [];
      while (i < w.length) { if (rnd() < 0.45) { const len = 1 + Math.floor(rnd() * 3), e = Math.min(w.length, i + len); spans.push([i, e]); i = e + 1; } else i++; }
      const parts = []; let cur = 0;
      spans.forEach(([a, b]) => {
        const quote = w.slice(a, b).join(' '), kind = pick(['agree', 'edit', 'disagree', 'disagree-c', 'agree-c', 'delete']);
        let fin = null, comment = '';
        if (kind === 'agree' || kind === 'edit' || kind === 'agree-c') fin = 'n' + Math.floor(rnd() * 99) + ' $& $1 <x> & ' + quote.split(' ').slice(0, 1 + Math.floor(rnd() * 2)).join(' ');
        if (kind === 'delete') fin = '';
        if (kind === 'disagree-c' || kind === 'agree-c') comment = 'note ' + r + '.' + a;
        const d = kind.startsWith('disagree') ? 'disagree' : (kind === 'edit' || kind === 'delete') ? 'edit' : 'agree';          // a deletion is a reviewer editing the text to nothing; "agree" with no wording deletes nothing
        items.push(it(quote, d, fin == null ? null : fin, { comment, context: paras[pi] }));
        parts.push([a, b, fin]); if (fin != null) edits++; if (comment) comms++;
      });
      let t = ''; cur = 0; const out = [];
      parts.forEach(([a, b, fin]) => { out.push(...w.slice(cur, a)); if (fin !== null) { if (fin !== '') out.push(fin); } else out.push(...w.slice(a, b)); cur = b; });
      out.push(...w.slice(cur)); exp[pi] = out.join(' ').replace(/ +/g, ' ');
    });
    // the same paragraphs as random runs
    const body = paras.map((txt) => {
      let pos = 0, x = ''; const L = txt.length;
      while (pos < L) { const len = 1 + Math.floor(rnd() * 14), seg = txt.slice(pos, pos + len); pos += len; if (rnd() < 0.15) x += '<w:bookmarkStart w:id="' + (900 + pos) + '" w:name="b' + pos + '"/><w:bookmarkEnd w:id="' + (900 + pos) + '"/>'; if (rnd() < 0.1) x += '<w:proofErr w:type="spellStart"/>'; x += '<w:r>' + (pick(RP) ? '<w:rPr>' + pick(RP) + '</w:rPr>' : '') + (rnd() < 0.1 ? '<w:lastRenderedPageBreak/>' : '') + T(seg) + '</w:r>'; }
      return '<w:p><w:pPr><w:pStyle w:val="Body"/></w:pPr>' + x + '</w:p>';
    }).join('');
    const docx = await mkdocx(body); rounds++;
    let res; try { res = await run(docx, items); } catch (e) { bad.push('round ' + r + ' threw ' + e.message); continue; }
    const src = res.files.tracked || docx, norm = (a) => a.map((x) => x.replace(/ +/g, ' ').trim());
    const accA = await parasText(src, 'accepted'), rejA = await parasText(src, 'rejected'), cleA = res.files.clean ? await parasText(res.files.clean, 'accepted') : accA;
    const want = norm(exp), orig = norm(paras), same = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);
    const accNorm = accA.join('|'), wantJ = want.join('|');
    const allOk = res.receipt.ok && same(accA, want) && same(rejA, orig) && same(cleA, want) && res.totals.manual === 0 && res.ledger.length === items.length;
    if (allOk) good++; else bad.push('round ' + r + ' ' + (() => { let i = 0; while (i < wantJ.length && wantJ[i] === accNorm[i]) i++; return 'first difference at ' + i + ' want [' + wantJ.slice(Math.max(0, i - 30), i + 40) + '] got [' + accNorm.slice(Math.max(0, i - 30), i + 40) + ']'; })() + ': receipt ' + res.receipt.ok + ' | acc ' + same(accA, want) + ' | rej ' + same(rejA, orig) + ' | clean ' + same(cleA, want) + ' | manual ' + res.totals.manual + ' ' + JSON.stringify(res.receipt.checks.filter((x) => !x.ok).map((x) => x.name + ' ' + x.detail)).slice(0, 300));
  }
  ok(good === rounds && rounds === 150, 'random: ' + good + ' of ' + rounds + ' random documents came out exactly right (' + edits + ' edits, ' + comms + ' comments)', bad.slice(0, 3).join(' || '));
}

console.log(`${fail ? 'FAILED' : 'OK'}: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
