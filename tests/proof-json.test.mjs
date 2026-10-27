// Offline test for the proofreading reply reader (parseClaudeJSON / repairJSON in index.html).
// Run: node tests/proof-json.test.mjs
// The functions are cut out of index.html itself, so this tests exactly what ships.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const html = readFileSync(path.join(root, 'index.html'), 'utf8');
const cut = (from, to) => { const a = html.indexOf(from), b = html.indexOf(to, a); if (a < 0 || b < 0) throw new Error('marker not found: ' + from); return html.slice(a, b); };
const code = cut('const JSON_FIX_NOTE', '// RTL language helpers') + '\n' + cut('function salvageErrors', 'async function proofreadChunkText');
const { parseClaudeJSON, repairJSON, salvageErrors } = new Function(code + '\nreturn { parseClaudeJSON, repairJSON, salvageErrors };')();

let pass = 0, fail = 0;
const ok = (cond, name, extra) => { if (cond) pass++; else { fail++; console.log('FAIL  ' + name + (extra ? '\n      ' + extra : '')); } };
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const throws = (fn) => { try { fn(); return null; } catch (e) { return e; } };

// 1. replies that are already fine
const good = { language: 'English', word_count: 5, errors: [{ id: 1, type: 'Spelling', original: 'teh', corrected: 'the' }] };
ok(same(parseClaudeJSON(JSON.stringify(good)), good), 'plain JSON');
ok(same(parseClaudeJSON('```json\n' + JSON.stringify(good, null, 2) + '\n```'), good), 'code fence');
ok(same(parseClaudeJSON('Here is the result:\n```json\n' + JSON.stringify(good) + '\n```\nHope it helps.'), good), 'fence inside prose');
ok(same(parseClaudeJSON('Sure! ' + JSON.stringify(good) + ' Done.'), good), 'prose around the object');
ok(same(parseClaudeJSON('```json\n' + JSON.stringify(good)), good), 'opening fence, no closing fence');

// 2. the slips that used to fail three times in a row
const E = (ctx, orig, extra = '') => `{"language":"English","word_count":9,"errors":[{"id":1,"type":"Style","severity":"Minor","page":1,"context":"${ctx}","original":"${orig}","corrected":"x","explanation":"y"${extra}}]}`;
let r = parseClaudeJSON(E('He said "go now" and left.', 'go now'));
ok(r.errors[0].context === 'He said "go now" and left.' && r.errors[0].original === 'go now', 'unescaped quotes inside a value', JSON.stringify(r));
r = parseClaudeJSON(E('Titled "Heat", then rain.', 'Heat'));
ok(r.errors[0].context === 'Titled "Heat", then rain.', 'unescaped quotes followed by a comma', JSON.stringify(r));
r = parseClaudeJSON(E('Line one\nLine two', 'one'));
ok(r.errors[0].context === 'Line one\nLine two', 'raw line break inside a value');
r = parseClaudeJSON(E('Tab\there', 'Tab'));
ok(r.errors[0].context === 'Tab\there', 'raw tab inside a value');
r = parseClaudeJSON('{"language":"English","errors":[{"id":1,"original":"a","corrected":"b",},],}');
ok(r.errors.length === 1 && r.errors[0].corrected === 'b', 'trailing commas');
r = parseClaudeJSON(E("It\\'s fine", 'It'));
ok(r.errors[0].context === "It\\'s fine", 'stray backslash keeps the text', JSON.stringify(r.errors[0].context));
r = parseClaudeJSON(E('Note: the "Cover" page: see p. 3', 'Cover'));
ok(r.errors[0].original === 'Cover' && r.errors[0].context.startsWith('Note: the "Cover" page'), 'colon next to quotes');
r = parseClaudeJSON(E('Arabic مرحبا and "Bengali" বাংলা', 'Bengali'));
ok(r.errors[0].context.includes('مرحبا') && r.errors[0].context.includes('বাংলা'), 'non-Latin text kept');
r = parseClaudeJSON(E('caf\\u00e9 and "x" y', 'x'));
ok(r.errors[0].context === 'café and "x" y', 'valid \\u escape kept next to a bad quote');
r = parseClaudeJSON('{"language":"German","errors":[{"id":1,"context":"Er sagte „hallo“ und ging.","original":"hallo","corrected":"x","explanation":"y"}]}');
ok(r.errors[0].original === 'hallo', 'typographic quotes are untouched');

// 3. a reply that is really not JSON still fails, with the reply attached for the dialog
let e = throws(() => parseClaudeJSON("I'm sorry, I can't help with that."));
ok(e && /JSON/.test(e.message) && e.raw === "I'm sorry, I can't help with that.", 'prose-only reply throws with raw', e && e.message);
e = throws(() => parseClaudeJSON(''));
ok(e && /JSON/.test(e.message) && e.raw === '', 'empty reply throws');
e = throws(() => parseClaudeJSON('{"language":"English","errors":[{"id":1,"context":"cut off here'));
ok(e && /incomplete/i.test(e.message) && /json|parse|incomplete/i.test(e.message), 'cut-off reply is reported as incomplete', e && e.message);

// 4. salvage keeps every complete error object from a damaged reply
const damaged = '{"language":"English","errors":[{"id":1,"original":"a","corrected":"b"},{"id":2,"context":"He said "x" ok","original":"x","corrected":"y"},{"id":3,"original":"c","corr';
const kept = salvageErrors(repairJSON(damaged));
ok(kept.length === 2 && kept[1].original === 'x', 'salvage after repair keeps the complete objects', JSON.stringify(kept));

// 5. valid JSON must never be changed by the repair step (random objects with awkward strings)
const rnd = (() => { let s = 12345; return () => (s = (s * 1664525 + 1013904223) >>> 0) / 4294967296; })();
const pieces = ['a', 'b', ' ', '"', '\\', '\n', '\t', ',', ':', '{', '}', '[', ']', '"x"', ', "y"', 'é', 'م', ' ', '1', 'true', "'", '/', '\u0001'];
const rs = () => { let n = Math.floor(rnd() * 12), t = ''; while (n--) t += pieces[Math.floor(rnd() * pieces.length)]; return t; };
let bad = 0;
for (let i = 0; i < 3000; i++) {
  const obj = { language: rs(), word_count: Math.floor(rnd() * 999), errors: Array.from({ length: Math.floor(rnd() * 4) }, (_, k) => ({ id: k + 1, context: rs(), original: rs(), corrected: rs(), explanation: rs() })) };
  const txt = rnd() < 0.5 ? JSON.stringify(obj) : JSON.stringify(obj, null, 2);
  let back; try { back = JSON.parse(repairJSON(txt)); } catch (_) { back = null; }
  if (!same(back, obj)) { bad++; if (bad < 3) console.log('      repair changed valid JSON: ' + txt.slice(0, 160)); }
}
ok(bad === 0, 'repair leaves 3000 valid replies unchanged', bad + ' changed');

// 6. the format reminder sent on a retry
ok(/ONE valid JSON object/.test(parseClaudeJSON.toString() + code) && /Escape every double quote/.test(code), 'retry note present');

console.log(`${fail ? 'FAILED' : 'OK'}: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
