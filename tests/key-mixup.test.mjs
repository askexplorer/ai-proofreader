// Offline test for the key mix-up guard in index.html (keyKind / sortKeys / fixLocalKeys / apiProbe's early check).
// Run: node tests/key-mixup.test.mjs   (Node 18+). The code is cut out of index.html. All keys below are made-up placeholders.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const html = readFileSync(path.join(root, 'index.html'), 'utf8');
const a = html.indexOf('function keyKind'), b = html.indexOf('async function testApiConnection', a);
if (a < 0 || b < 0) throw new Error('markers not found');
const code = html.slice(a, b);

let pass = 0, fail = 0;
const ok = (c, n, x) => { if (c) pass++; else { fail++; console.log('FAIL  ' + n + (x ? '  ' + x : '')); } };

// A fake browser: a storage object, the two key boxes, and the "came from the team" marks
const make = (stored = {}) => {
  const data = { ...stored }, boxes = { 'api-key-input': { value: '' }, 'openai-key-input': { value: '' } };
  const localStorage = { getItem: (k) => (k in data ? data[k] : null), setItem: (k, v) => { data[k] = String(v); }, removeItem: (k) => { delete data[k]; } };
  const document = { getElementById: (id) => boxes[id] || null };
  let fetched = 0;
  const fetch = async () => { fetched++; return new Response('{}', { status: 200 }); };
  const srGet = (k) => localStorage.getItem(k);
  const T = new Function('localStorage', 'document', 'srGet', 'fetch', 'openaiDiagnose', code + '\nreturn { keyKind, sortKeys, fixLocalKeys, apiProbe };')(localStorage, document, srGet, fetch, async () => 'accepted');
  return { T, data, boxes, fetched: () => fetched };
};

// Placeholders shaped like the real ones: an OpenAI project key (sk-proj-..., long) and an Anthropic key (sk-ant-..., shorter)
const OAI = 'sk-proj-' + 'A1b2C3d4'.repeat(19), ANT = 'sk-ant-api03-' + 'Zy9Xw8Vu'.repeat(11);
const { T } = make();

// --- which company a key belongs to
ok(T.keyKind(ANT) === 'anthropic', 'sk-ant- is Anthropic');
ok(T.keyKind(OAI) === 'openai' && T.keyKind('sk-abc123') === 'openai', 'other sk- is OpenAI');
ok(T.keyKind('  ' + ANT + '\n') === 'anthropic', 'whitespace around a key is ignored');
ok(T.keyKind('') === '' && T.keyKind(null) === '' && T.keyKind(undefined) === '' && T.keyKind('hello') === '' && T.keyKind('sb_publishable_x') === '', 'anything else is unknown');

// --- sorting the pair (the live case: OpenAI key in the Anthropic box, Anthropic key in the OpenAI box)
let s = T.sortKeys(OAI, ANT);
ok(s.moved && s.a === ANT && s.o === OAI, 'crossed pair is put the right way round');
s = T.sortKeys(ANT, OAI);
ok(!s.moved && s.a === ANT && s.o === OAI, 'a correct pair is left alone');
s = T.sortKeys(OAI, '');
ok(s.moved && s.a === '' && s.o === OAI, 'an OpenAI key alone in the Anthropic box moves to the OpenAI box');
s = T.sortKeys('', ANT);
ok(s.moved && s.a === ANT && s.o === '', 'an Anthropic key alone in the OpenAI box moves to the Anthropic box');
s = T.sortKeys(ANT, '');
ok(!s.moved && s.a === ANT && s.o === '', 'Anthropic key in its own box: untouched');
s = T.sortKeys('', OAI);
ok(!s.moved && s.a === '' && s.o === OAI, 'OpenAI key in its own box: untouched');
s = T.sortKeys(OAI, 'sk-proj-other');
ok(!s.moved && s.a === OAI, 'two OpenAI keys are not guessed at');
s = T.sortKeys(ANT, 'sk-ant-other');
ok(!s.moved && s.o === 'sk-ant-other', 'two Anthropic keys are not guessed at');
s = T.sortKeys('some-odd-key', ANT);
ok(!s.moved, 'an unknown format is never moved');
s = T.sortKeys(null, undefined);
ok(!s.moved && s.a === '' && s.o === '', 'nothing in, nothing out');
s = T.sortKeys('  ' + OAI + ' ', ' ' + ANT + '\n');
ok(s.moved && s.a === ANT && s.o === OAI, 'spaces are trimmed while sorting');

// A key can never be lost or duplicated, whatever is pasted where
const pool = ['', ANT, OAI, 'sk-ant-second', 'sk-second', 'odd', '  '];
let lost = 0, combos = 0;
for (const x of pool) for (const y of pool) {
  combos++;
  const r = T.sortKeys(x, y), before = [x.trim(), y.trim()].filter(Boolean).sort(), after = [r.a, r.o].filter(Boolean).sort();
  if (JSON.stringify(before) !== JSON.stringify(after)) lost++;
}
ok(lost === 0, 'every combination keeps exactly the keys it was given (' + combos + ' combinations)');

// --- straightening what is saved in this browser
{
  const w = make({ proof_api_key: OAI, proof_openai_key: ANT, sr_team_a: '1', sr_team_o: '1' });
  const moved = w.T.fixLocalKeys();
  ok(moved && w.data.proof_api_key === ANT && w.data.proof_openai_key === OAI, 'saved keys are put the right way round');
  ok(w.data.sr_team_a === '1' && w.data.sr_team_o === '1', 'both "came from the team" marks stay');
  ok(w.boxes['api-key-input'].value === ANT && w.boxes['openai-key-input'].value === OAI, 'the Setup boxes show the corrected keys');
  ok(w.T.fixLocalKeys() === false && w.data.proof_api_key === ANT, 'a second pass changes nothing');
}
{
  const w = make({ proof_api_key: OAI, sr_team_a: '1' });                 // one team-supplied key alone in the wrong box
  w.T.fixLocalKeys();
  ok(!('proof_api_key' in w.data) && w.data.proof_openai_key === OAI, 'a lone OpenAI key leaves the Anthropic slot');
  ok(!('sr_team_a' in w.data) && w.data.sr_team_o === '1', 'its team mark moves with it');
}
{
  const w = make({ proof_api_key: ANT, proof_openai_key: OAI });
  ok(w.T.fixLocalKeys() === false && w.data.proof_api_key === ANT && w.data.proof_openai_key === OAI, 'a correct pair is not touched');
}
{
  const w = make({});
  ok(w.T.fixLocalKeys() === false && Object.keys(w.data).length === 0, 'no keys saved: nothing happens');
}

// --- Test connection says exactly what is wrong, and does not send the key to the wrong company
{
  const w = make();
  const r1 = await w.T.apiProbe('anthropic', OAI), r2 = await w.T.apiProbe('openai', ANT);
  ok(!r1.ok && /OpenAI key/.test(r1.text) && /OpenAI box/.test(r1.text), 'Anthropic box holding an OpenAI key: clear message');
  ok(!r2.ok && /Anthropic key/.test(r2.text) && /Anthropic box/.test(r2.text), 'OpenAI box holding an Anthropic key: clear message');
  ok(w.fetched() === 0, 'neither key was sent anywhere');
  ok(!r1.text.includes(OAI) && !r2.text.includes(ANT), 'the message never repeats the key');
}

console.log(`${fail ? 'FAILED' : 'OK'}: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
