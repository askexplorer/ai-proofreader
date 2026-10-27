// Offline test for the OpenAI key diagnosis in index.html (openaiDiagnose / openaiKeyError / isKeyProblem).
// Run: node tests/openai-key.test.mjs   (Node 18+). The code is cut out of index.html and run against a fake fetch.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const html = readFileSync(path.join(root, 'index.html'), 'utf8');
const a = html.indexOf('async function openaiDiagnose'), b = html.indexOf('function keyProblemHtml', a);
if (a < 0 || b < 0) throw new Error('markers not found');
const build = (fetchImpl) => new Function('fetch', html.slice(a, b) + '\nreturn { openaiDiagnose, openaiKeyError, isKeyProblem };')(fetchImpl);

let pass = 0, fail = 0;
const ok = (c, n, x) => { if (c) pass++; else { fail++; console.log('FAIL  ' + n + (x ? '  ' + x : '')); } };

let seen = null;
const withStatus = (st) => build(async (url, opts) => { seen = { url, opts }; return new Response('{}', { status: st }); });
const down = build(async () => { throw new TypeError('Failed to fetch'); });

ok(await withStatus(200).openaiDiagnose('sk-x') === 'accepted', '200 -> accepted');
ok(await withStatus(401).openaiDiagnose('sk-x') === 'rejected', '401 -> rejected');
ok(await withStatus(403).openaiDiagnose('sk-x') === 'other', '403 (restricted key) -> other, not rejected');
ok(await withStatus(429).openaiDiagnose('sk-x') === 'other', '429 -> other');
ok(await withStatus(500).openaiDiagnose('sk-x') === 'other', '500 -> other');
ok(await down.openaiDiagnose('sk-x') === 'unreachable', 'fetch throws -> unreachable');
await withStatus(200).openaiDiagnose('sk-secret');
ok(seen.url === 'https://api.openai.com/v1/models' && seen.opts.headers.Authorization === 'Bearer sk-secret' && !seen.opts.method, 'uses GET /v1/models with the key (the call that carries CORS headers)');

const T = withStatus(200);
const e1 = T.openaiKeyError('rejected'), e2 = T.openaiKeyError('other');
ok(e1.keyProblem === 'rejected' && /^KEY_PROBLEM:/.test(e1.message) && /rejected/.test(e1.message), 'rejected key error');
ok(e2.keyProblem === 'other' && /refused the request/.test(e2.message), 'recognised-but-refused error');
ok(T.isKeyProblem(e1) && T.isKeyProblem(new Error('KEY_PROBLEM: x')) && !T.isKeyProblem(new Error('NETWORK: x')) && !T.isKeyProblem(null), 'isKeyProblem');
ok(!/failed to fetch|network|json|parse|incomplete|rate limit/i.test(e1.message + e2.message), 'key-problem text cannot be mistaken for a network, JSON or rate-limit error');

console.log(`${fail ? 'FAILED' : 'OK'}: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
