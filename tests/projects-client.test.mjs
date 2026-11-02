// Offline test for the Projects helpers in share-core.js (packJSON / unpackJSON / saveProject / listProjects / getProject / deleteProject).
// Run: node tests/projects-client.test.mjs   (Node 18+)
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
new Function(readFileSync(path.join(root, 'share-core.js'), 'utf8'))();      // defines globalThis.SR
const SR = globalThis.SR;
let pass = 0, fail = 0;
const ok = (c, n, x) => { if (c) pass++; else { fail++; console.log('FAIL  ' + n + (x ? '  ' + x : '')); } };

// round trip, including scripts the team really uses and a big report
const small = { v: 1, kind: 'proofread', report: { errors: [{ original: 'teh', corrected: 'the', explanation: 'Typo' }], language: 'English' } };
const multi = { text: 'Сайн байна уу مرحبا 你好 স্বাগতম "quotes" \\ backslash\nnew line' };
const big = { issues: Array.from({ length: 4000 }, (_, i) => ({ id: i, srcContext: 'A sentence number ' + i + ' that repeats a lot of the same words again and again.', why: 'Because ' + i })) };
for (const [name, v] of [['small report', small], ['multi-script text', multi], ['4,000-issue report', big]]) {
  const packed = await SR.packJSON(v);
  ok(/^z:[A-Za-z0-9+/=]+$/.test(packed), name + ': packed as gzip + base64');
  ok(JSON.stringify(await SR.unpackJSON(packed)) === JSON.stringify(v), name + ': comes back identical');
}
ok((await SR.packJSON(big)).length < JSON.stringify(big).length / 5, 'a large repetitive report packs to under a fifth of its size');
ok(JSON.stringify(await SR.unpackJSON('j:' + Buffer.from(JSON.stringify(small)).toString('base64'))) === JSON.stringify(small), 'the uncompressed fallback format also reads');

// the RPC calls: right function names and arguments; the heavy payload is unpacked on open
const calls = [], realFetch = globalThis.fetch;
globalThis.fetch = async (url, init) => {
  const fn = String(url).split('/rpc/')[1], body = JSON.parse(init.body); calls.push({ fn, body, auth: init.headers.Authorization });
  if (fn === 'project_save') return new Response(JSON.stringify({ ok: true, id: body.p_id }), { status: 200 });
  if (fn === 'project_list') return new Response(JSON.stringify({ ok: true, projects: [{ id: 'p1', title: 'A', kind: 'proofread', mine: true }] }), { status: 200 });
  if (fn === 'project_get') return new Response(JSON.stringify({ ok: true, project: { id: body.p_id, title: 'A', payload: await SR.packJSON(small) } }), { status: 200 });
  if (fn === 'project_delete') return new Response(JSON.stringify({ ok: false, error: 'forbidden' }), { status: 200 });
  return new Response('{}', { status: 404 });
};
const store = new Map(); globalThis.localStorage = { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k) };
store.set('sr_session', JSON.stringify({ access_token: 'tok', refresh_token: 'r', expires_at: Date.now() + 3600000 }));
const cfg = { url: 'https://proj.supabase.co', key: 'sb_publishable_placeholder' };
let r = await SR.saveProject(cfg, { id: 'P', kind: 'translation', title: 'T', summary: { score: 91 }, payload: 'z:abc', instructions: 'Keep names.' });
ok(r.ok && calls[0].fn === 'project_save' && calls[0].body.p_kind === 'translation' && calls[0].body.p_summary.score === 91 && calls[0].body.p_instructions === 'Keep names.' && calls[0].auth === 'Bearer tok', 'saveProject sends the right arguments as the signed-in user');
r = await SR.listProjects(cfg); ok(Array.isArray(r) && r[0].id === 'p1', 'listProjects returns the list');
r = await SR.getProject(cfg, 'p1'); ok(r.data && r.data.report.language === 'English' && !('payload' in r), 'getProject unpacks the report and drops the raw payload');
let code = ''; try { await SR.deleteProject(cfg, 'p1'); } catch (e) { code = e.code; } ok(code === 'forbidden', 'a refused delete surfaces the reason');
globalThis.fetch = realFetch;

console.log(`${fail ? 'FAILED' : 'OK'}: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
