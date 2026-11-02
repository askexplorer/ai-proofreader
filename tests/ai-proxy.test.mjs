// Offline test for the ai-proxy Edge Function (supabase/functions/ai-proxy/index.ts), loaded exactly as written.
// Run: node tests/ai-proxy.test.mjs   (Node 18+). A fake Supabase and fake AI providers record every call. Placeholder keys only.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = readFileSync(path.join(root, 'supabase/functions/ai-proxy/index.ts'), 'utf8');
const { handle } = await import('data:text/javascript;base64,' + Buffer.from(src).toString('base64'));

let pass = 0, fail = 0;
const ok = (c, n, x) => { if (c) pass++; else { fail++; console.log('FAIL  ' + n + (x ? '  ' + x : '')); } };

const ENV = { SUPABASE_URL: 'https://proj.supabase.co' }, ANON = 'sb_publishable_placeholder_key';
const ANT = 'sk-ant-api03-' + 'Zy9Xw8Vu'.repeat(11), OAI = 'sk-proj-' + 'A1b2C3d4'.repeat(19);
const TOK = { member: 'tok-member', stranger: 'tok-stranger', bad: 'tok-bad' };

function fake(opts = {}) {
  const calls = [];
  const stored = opts.stored === undefined ? { a: ANT, o: OAI } : opts.stored;
  const f = async (url, init = {}) => {
    const u = new URL(url), h = init.headers || {}, body = init.body ? JSON.parse(init.body) : null;
    calls.push({ host: u.host, path: u.pathname, headers: h, body, signal: init.signal });
    if (u.host === 'proj.supabase.co') {
      const who = Object.entries(TOK).find(([, v]) => h.Authorization === 'Bearer ' + v);
      if (!who || who[0] === 'bad') return new Response(JSON.stringify({ message: 'JWT invalid' }), { status: 401 });
      if (who[0] === 'stranger') return new Response(JSON.stringify({ ok: false, error: 'denied' }), { status: 200 });
      if (u.pathname.endsWith('team_whoami')) return new Response(JSON.stringify({ ok: true, id: 'u1', name: 'Ben', admin: false }), { status: 200 });
      if (u.pathname.endsWith('team_keys_get')) return new Response(JSON.stringify(stored ? { ok: true, keys: stored } : { ok: true, keys: null }), { status: 200 });
    }
    if (opts.upstream) return opts.upstream(u, init);
    if (u.host === 'api.anthropic.com') return new Response(JSON.stringify({ id: 'm1', content: [{ type: 'text', text: 'hello' }], usage: { input_tokens: 5, output_tokens: 2 } }), { status: 200, headers: { 'content-type': 'application/json', 'request-id': 'req_1', 'anthropic-ratelimit-tokens-reset': 'soon', 'set-cookie': 'x=1', 'x-secret-thing': 'no' } });
    if (u.host === 'api.openai.com') return new Response(JSON.stringify({ choices: [{ message: { content: 'hi' }, finish_reason: 'stop' }], usage: { prompt_tokens: 4, completion_tokens: 1 } }), { status: 200, headers: { 'content-type': 'application/json' } });
    return new Response('{}', { status: 404 });
  };
  return { f, calls };
}
const call = (fk, token, body, extra = {}) => handle(new Request('https://x/functions/v1/ai-proxy', { method: 'POST', headers: { 'content-type': 'application/json', ...(token ? { authorization: 'Bearer ' + token } : {}), apikey: ANON, ...extra }, body: JSON.stringify(body) }), ENV, fk.f);
const j = async (r) => ({ s: r.status, b: await r.json().catch(() => null) });
const upstreamCalls = (fk) => fk.calls.filter((c) => c.host !== 'proj.supabase.co');
const A = { provider: 'anthropic', payload: { model: 'claude-sonnet-4-6', max_tokens: 100, system: [{ type: 'text', text: 'sys' }], messages: [{ role: 'user', content: 'hi' }] } };
const O = { provider: 'openai', payload: { model: 'gpt-4o', max_tokens: 100, messages: [{ role: 'user', content: 'hi' }] } };

// --- who may use it
{
  const fk = fake();
  const pre = await handle(new Request('https://x', { method: 'OPTIONS' }), ENV, fk.f);
  ok(pre.status === 204 && pre.headers.get('access-control-allow-origin') === '*' && /retry-after/.test(pre.headers.get('access-control-expose-headers')), 'CORS preflight answered, retry-after is readable by the browser');
  ok((await handle(new Request('https://x', { method: 'GET' }), ENV, fk.f)).status === 405, 'only POST');
  let r = await j(await call(fk, null, A)); ok(r.s === 401 && r.b.error.type === 'signed_out', 'no token: refused');
  r = await j(await call(fk, TOK.bad, A)); ok(r.s === 401, 'invalid token: refused');
  r = await j(await call(fk, TOK.stranger, A)); ok(r.s === 403 && r.b.error.type === 'denied', 'signed up but not on the team: refused');
  ok(upstreamCalls(fk).length === 0, 'no AI call is made for anyone who is not a team member');
  ok(!fk.calls.some((c) => c.path.endsWith('team_keys_get') && c.headers.Authorization !== 'Bearer ' + TOK.member && c.headers.Authorization !== 'Bearer ' + TOK.stranger && c.headers.Authorization !== 'Bearer ' + TOK.bad), 'the key table is only ever read with the caller\'s own token');
}

// --- Anthropic and OpenAI pass-through
{
  const fk = fake();
  let res = await call(fk, TOK.member, A), r = await j(res);
  const up = upstreamCalls(fk)[0];
  ok(r.s === 200 && r.b.content[0].text === 'hello' && r.b.usage.input_tokens === 5, 'Anthropic: the answer comes back unchanged');
  ok(up.host === 'api.anthropic.com' && up.path === '/v1/messages' && up.headers['x-api-key'] === ANT && up.headers['anthropic-version'] === '2023-06-01' && up.headers['anthropic-beta'] === 'prompt-caching-2024-07-31', 'Anthropic: team key and version headers added on the server');
  ok(up.body.model === 'claude-sonnet-4-6' && up.body.system[0].text === 'sys' && up.body.messages[0].content === 'hi', 'Anthropic: the request body is forwarded as sent (prompt caching block intact)');
  ok(res.headers.get('request-id') === 'req_1' && res.headers.get('anthropic-ratelimit-tokens-reset') === 'soon', 'rate-limit headers pass through');
  ok(!res.headers.get('set-cookie') && !res.headers.get('x-secret-thing'), 'other provider headers are not passed on');
  ok(res.headers.get('access-control-allow-origin') === '*', 'CORS on the answer');
  r = await j(await call(fk, TOK.member, O)); const upo = upstreamCalls(fk)[1];
  ok(r.s === 200 && r.b.choices[0].message.content === 'hi' && upo.host === 'api.openai.com' && upo.headers.Authorization === 'Bearer ' + OAI, 'OpenAI: forwarded with the OpenAI key');
  const all = JSON.stringify(await Promise.all([A, O].map(async (x) => (await call(fk, TOK.member, x)).text())));
  ok(!all.includes(ANT) && !all.includes(OAI), 'neither key ever appears in an answer');
}

// --- the crossed pair stored in the database still works
{
  const fk = fake({ stored: { a: OAI, o: ANT } });
  await call(fk, TOK.member, A); await call(fk, TOK.member, O);
  const [ua, uo] = upstreamCalls(fk);
  ok(ua.headers['x-api-key'] === ANT && uo.headers.Authorization === 'Bearer ' + OAI, 'keys stored in each other\'s slots are sorted by prefix before use');
}

// --- errors and rate limits reach the browser as the provider sent them
{
  const fk = fake({ upstream: async (u) => new Response(JSON.stringify({ type: 'error', error: { type: 'rate_limit_error', message: 'Number of request tokens has exceeded your per-minute rate limit' } }), { status: 429, headers: { 'content-type': 'application/json', 'retry-after': '37' } }) });
  const res = await call(fk, TOK.member, A), r = await j(res);
  ok(r.s === 429 && /rate limit/i.test(r.b.error.message) && res.headers.get('retry-after') === '37', '429 keeps its status, message and retry-after');
  const fk2 = fake({ upstream: async () => new Response(JSON.stringify({ type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } }), { status: 401 }) });
  const r2 = await j(await call(fk2, TOK.member, A));
  ok(r2.s === 401 && /invalid x-api-key/.test(r2.b.error.message), 'a rejected team key is reported as the provider reported it');
}

// --- missing key, ping, validation
{
  const none = fake({ stored: null });
  let r = await j(await call(none, TOK.member, A)); ok(r.s === 400 && r.b.error.type === 'no_key' && /Anthropic/.test(r.b.error.message), 'no team key stored: a clear message');
  r = await j(await call(none, TOK.member, { ping: true })); ok(r.s === 200 && r.b.ok && r.b.anthropic === false && r.b.openai === false, 'ping reports which keys exist');
  const onlyA = fake({ stored: { a: ANT, o: null } });
  r = await j(await call(onlyA, TOK.member, { ping: true })); ok(r.b.anthropic === true && r.b.openai === false, 'ping: Anthropic only');
  r = await j(await call(onlyA, TOK.member, O)); ok(r.b.error.type === 'no_key' && /OpenAI/.test(r.b.error.message), 'asking for the provider without a key says which one');
  ok(upstreamCalls(onlyA).length === 0, 'nothing is sent to a provider without a key');
  const fk = fake();
  r = await j(await call(fk, TOK.member, { ping: true })); ok(r.b.anthropic && r.b.openai && !JSON.stringify(r.b).includes(ANT), 'ping never contains a key');
  for (const [body, why] of [
    [{ provider: 'google', payload: A.payload }, 'unknown provider'],
    [{ provider: 'anthropic', payload: { ...A.payload, model: 'gpt-4o' } }, 'model from the wrong company'],
    [{ provider: 'openai', payload: { ...O.payload, model: 'claude-sonnet-4-6' } }, 'model from the wrong company (OpenAI)'],
    [{ provider: 'anthropic', payload: { ...A.payload, stream: true } }, 'streaming'],
    [{ provider: 'anthropic', payload: { ...A.payload, max_tokens: 64000 } }, 'huge max_tokens'],
    [{ provider: 'anthropic', payload: 'nope' }, 'payload not an object'],
    [{ provider: 'anthropic', payload: { messages: [] } }, 'no model'],
  ]) { const x = await j(await call(fk, TOK.member, body)); ok(x.s === 400 && x.b.error.type === 'bad_request', 'refused: ' + why); }
  ok(upstreamCalls(fk).length === 0, 'refused requests never reach a provider');
  const big = await j(await call(fk, TOK.member, A, { 'content-length': '7000000' })); ok(big.s === 413, 'oversized request refused');
  const bad = await handle(new Request('https://x', { method: 'POST', headers: { authorization: 'Bearer ' + TOK.member, apikey: ANON }, body: 'not json' }), ENV, fk.f);
  ok(bad.status === 400, 'invalid JSON refused');
}

// --- time limit and failures
{
  let signal = null;
  const slow = fake({ upstream: (u, init) => new Promise((_, reject) => { signal = init.signal; init.signal.addEventListener('abort', () => { const e = new Error('aborted'); e.name = 'AbortError'; reject(e); }); }) });
  const realSet = globalThis.setTimeout; globalThis.setTimeout = (fn, ms, ...a) => realSet(fn, ms >= 100000 ? 5 : ms, ...a);
  const r = await j(await call(slow, TOK.member, A));
  globalThis.setTimeout = realSet;
  ok(r.s === 504 && r.b.error.type === 'proxy_timeout' && /140 seconds/.test(r.b.error.message), 'a call that runs too long ends with a clear 504 message');
  ok(signal && signal.aborted, 'the provider request is cancelled');
  const down = fake({ upstream: async () => { throw new TypeError('fetch failed'); } });
  const d = await j(await call(down, TOK.member, A)); ok(d.s === 502 && d.b.error.type === 'network', 'provider unreachable: 502 with a message');
  const noEnv = await handle(new Request('https://x', { method: 'POST', headers: { authorization: 'Bearer t', apikey: 'k' }, body: '{}' }), {}, async () => new Response('{}'));
  ok(noEnv.status === 500, 'missing configuration: refused');
}

console.log(`${fail ? 'FAILED' : 'OK'}: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
