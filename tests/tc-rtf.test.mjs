// RTF reader + paragraph helpers (tc-core.js). Run:  node tests/tc-rtf.test.mjs
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
await import(pathToFileURL(join(dirname(fileURLToPath(import.meta.url)), '..', 'tc-core.js')).href);
const TC = globalThis.TC;
let pass = 0, fail = 0;
const t = (name, cond, extra = '') => { cond ? pass++ : (fail++, console.log('FAIL  ' + name + '  ' + extra)); };

const rtf = '{\\rtf1\\ansi\\ansicpg1252\\deff0{\\fonttbl{\\f0 Arial;}}{\\colortbl;\\red0\\green0\\blue0;}{\\*\\generator Hidden;}' +
  '\\f0\\fs24 First paragraph with \\\'93quotes\\\'94 and an em dash\\emdash here.\\par ' +
  'Second\\tab column\\line next line \\u8364?5 and \\u233?clair.\\par {\\b Bold} and \\\\ backslash \\{brace\\}.\\par\\par Last one.}';
const txt = TC.rtfToText(rtf), paras = TC.parasFromText(txt);
t('fonts, colours and hidden destinations are not in the text', !/Arial|generator|Hidden|red0/.test(txt), txt);
t('paragraph breaks become paragraphs (empty ones are dropped)', paras.length === 4, JSON.stringify(paras.map((p) => p.text)));
t("\\'hh uses the Windows-1252 code page (curly quotes)", /\u201cquotes\u201d/.test(paras[0].text), paras[0].text);
t('named characters (em dash) work', /\u2014/.test(paras[0].text));
t('\\uN unicode escapes skip their fallback character', /\u20ac5 and \u00e9clair/.test(paras[1].text), paras[1].text);
t('tab and line break are kept as spaces inside the paragraph', /Second column next line/.test(paras[1].text), paras[1].text);
t('escaped backslash and braces', /\\ backslash \{brace\}/.test(paras[2].text), paras[2].text);
t('format sniffing', TC.sniffFormat(new TextEncoder().encode('{\\rtf1')) === 'rtf' && TC.sniffFormat(new Uint8Array([0xD0, 0xCF, 0x11, 0xE0, 0, 0, 0, 0])) === 'ole-doc' && TC.sniffFormat(new TextEncoder().encode('PK\u0003\u0004')) === 'zip' && TC.sniffFormat(new TextEncoder().encode('%PDF-1.7')) === 'pdf' && TC.sniffFormat(new TextEncoder().encode('Hello')) === 'text');
// paragraphs: blank-line separated vs one paragraph per line vs hard-wrapped
t('blank-line separated text', TC.paragraphsFromText('One\n\nTwo\n\nThree').length === 3);
t('one paragraph per line', TC.paragraphsFromText('One\nTwo\nThree\nFour').length === 4);
const wrapped = Array.from({ length: 30 }, (_, i) => 'This is line ' + i + ' of a hard wrapped paragraph that goes on and on and').join('\n') + '\nand finally ends here.\n\nNext paragraph starts here.';
t('hard-wrapped text is re-joined into paragraphs', TC.paragraphsFromText(wrapped).length === 2, String(TC.paragraphsFromText(wrapped).length));
// chapters
const book = ['Front', '01', 'First title', 'a', 'b', '2', 'x', '02', 'Second title', 'c', '03', 'Third title', 'd', '04', 'Fourth title', 'e'].map((x, i) => TC.makePara(x, i));
const sd = TC.detectSections(book);
t('chapter headings are found; a stray number is ignored', sd.structured && sd.sections.filter((s) => s.num > 0).map((s) => s.num).join() === '1,2,3,4', JSON.stringify(sd.sections.map((s) => s.num)));
t('keyword headings (Chapter N / roman numerals)', TC.detectSections(['Intro', 'Chapter 1: Start', 'x', 'Chapter 2: Middle', 'y', 'Chapter 3', 'z', 'Chapter IV - End', 'w'].map((x, i) => TC.makePara(x, i))).sections.filter((s) => s.num > 0).map((s) => s.num).join() === '1,2,3,4');
t('no headings -> one whole section', !TC.detectSections(['a', 'b', 'c'].map((x, i) => TC.makePara(x, i))).structured);
// scoring rubric
const sc = (c, w) => TC.scoreOf(Array.from({ length: c.Critical || 0 }, () => ({ severity: 'Critical' })).concat(Array.from({ length: c.Major || 0 }, () => ({ severity: 'Major' })), Array.from({ length: c.Minor || 0 }, () => ({ severity: 'Minor' })), Array.from({ length: c.Query || 0 }, () => ({ severity: 'Query' }))), w);
t('rubric: clean text scores 100 and passes', sc({}, 10000).value === 100 && sc({}, 10000).verdict === 'Pass');
t('rubric: Query issues cost nothing', sc({ Query: 50 }, 10000).value === 100);
t('rubric: 1 Critical per 10,000 words = 100 - 4 -> 96 but still "Revise"', sc({ Critical: 1 }, 10000).value === 96 && sc({ Critical: 1 }, 10000).verdict === 'Revise');
t('rubric: 5 Minor per 10,000 words = 98 -> Pass', sc({ Minor: 5 }, 10000).value === 98 && sc({ Minor: 5 }, 10000).verdict === 'Pass');
t('rubric: below 75 fails', sc({ Critical: 10 }, 10000).verdict === 'Fail' && sc({ Critical: 10 }, 10000).value === 60);
console.log(`rtf/paragraph/chapter/rubric tests: ${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
