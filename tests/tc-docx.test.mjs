// Offline test for TC.docxPages: page numbers read from a Word (.docx) file (tc-core.js).
// Run: node tests/tc-docx.test.mjs   (Node 18+). The .docx files are built here from invented text, no real documents.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { deflateRawSync } from 'node:zlib';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
new Function(readFileSync(path.join(root, 'tc-core.js'), 'utf8'))();
const TC = globalThis.TC;
let pass = 0, fail = 0;
const ok = (c, n, x) => { if (c) pass++; else { fail++; console.log('FAIL  ' + n + (x ? '  ' + x : '')); } };

// minimal zip writer (one or more entries; CRC is not checked by the reader)
function zip(entries, method = 8) {
  const parts = [], central = []; let off = 0;
  for (const [name, text] of entries) {
    const raw = Buffer.from(text, 'utf8'), data = method === 8 ? deflateRawSync(raw) : raw, nm = Buffer.from(name);
    const lh = Buffer.alloc(30); lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(method, 8); lh.writeUInt32LE(data.length, 18); lh.writeUInt32LE(raw.length, 22); lh.writeUInt16LE(nm.length, 26);
    parts.push(lh, nm, data);
    const ch = Buffer.alloc(46); ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(method, 10); ch.writeUInt32LE(data.length, 20); ch.writeUInt32LE(raw.length, 24); ch.writeUInt16LE(nm.length, 28); ch.writeUInt32LE(off, 42);
    central.push(ch, nm); off += 30 + nm.length + data.length;
  }
  const cd = Buffer.concat(central), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10); end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(off, 16);
  return new Uint8Array(Buffer.concat([...parts, cd, end]));
}
const docXml = (body) => '<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>' + body + '</w:body></w:document>';
const P = (t, pre = '') => '<w:p><w:pPr><w:jc w:val="left"/></w:pPr>' + pre + '<w:r><w:t xml:space="preserve">' + t + '</w:t></w:r></w:p>';
const LRB = '<w:r><w:lastRenderedPageBreak/></w:r>';

// --- Word's own layout (lastRenderedPageBreak)
{
  const xml = docXml(
    P('Page one, first paragraph.') + P('Page one, second paragraph with &amp; and &lt;tags&gt;.') +
    P('Page two starts here.', LRB) + '<w:p><w:r><w:t>Split across</w:t></w:r>' + LRB + '<w:r><w:t xml:space="preserve"> two pages.</w:t></w:r></w:p>' +
    '<w:tbl><w:tr><w:tc>' + P('Cell on page three.') + '</w:tc></w:tr></w:tbl>' +
    P('فقرة عربية على الصفحة الثالثة') + '<w:p/>' + P('Still page three.<w:tab/>'));
  const r = await TC.docxPages(zip([['[Content_Types].xml', '<x/>'], ['word/document.xml', xml]]));
  ok(r && r.how === 'layout' && r.pages === 3, 'three pages found from the saved layout', JSON.stringify(r && { how: r.how, pages: r.pages }));
  const paras = TC.parasFromPages(r.pageTexts), pg = (k) => paras[k].page;
  ok(paras.length === 7, 'every non-empty paragraph is kept (empty ones are skipped)', String(paras.length));
  ok(pg(0) === 1 && pg(1) === 1 && pg(2) === 2 && pg(3) === 2 && pg(4) === 3 && pg(5) === 3 && pg(6) === 3, 'each paragraph has the page it starts on', paras.map((p) => p.page).join());
  ok(paras[1].text.includes('with & and <tags>'), 'XML entities are decoded', paras[1].text);
  ok(paras[3].text === 'Split across two pages.' && paras[3].page === 2 && paras[4].page === 3, 'a paragraph that crosses a page break stays whole, on the page it starts');
  ok(/^فقرة/.test(paras[5].text), 'Arabic text is read correctly');
  ok(TC.docStats(paras).words > 10, 'the paragraphs work with the rest of the engine');
}
// --- no saved layout: explicit page breaks and "page break before" only
{
  const xml = docXml(P('A') + '<w:p><w:r><w:br w:type="page"/></w:r></w:p>' + P('B') + '<w:p><w:pPr><w:pageBreakBefore/></w:pPr><w:r><w:t>C</w:t></w:r></w:p>');
  const r = await TC.docxPages(zip([['word/document.xml', xml]], 0));
  ok(r && r.how === 'breaks' && r.pages === 3 && r.pageTexts.join('|') === 'A|B|C', 'explicit breaks give pages (also from a stored, uncompressed zip)', JSON.stringify(r));
}
// --- nothing usable
ok(await TC.docxPages(zip([['word/document.xml', docXml(P('Only one page of text, no breaks at all.'))]])) === null, 'a file with no page information gives null (the UI then uses paragraph numbers)');
ok(await TC.docxPages(zip([['word/other.xml', '<x/>']])) === null, 'a zip without word/document.xml gives null');
ok(await TC.docxPages(new Uint8Array([1, 2, 3, 4, 5])) === null, 'something that is not a zip gives null');
ok(await TC.docxPages(new Uint8Array(0)) === null, 'an empty file gives null');
ok((await TC.docxPages(zip([['word/document.xml', docXml(P('x', LRB) + P('y', LRB) + P('z'))]]).buffer)) !== null, 'an ArrayBuffer is accepted as well as a Uint8Array');

console.log(`${fail ? 'FAILED' : 'OK'}: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
