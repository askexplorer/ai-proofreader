// Offline test for aiFetch in index.html (the one place that calls an AI provider, directly or through the team server).
// Run: node tests/ai-fetch.test.mjs   (Node 18+). The code is cut out of index.html and run against a fake fetch. Placeholder keys only.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const html = readFileSync(path.join(root, 'index.html'), 'utf8');
const a = html.indexOf('async function aiFetch'), b = html.indexOf('// Is the team server proxy installed', a);
if (a < 0 || b < 0) throw new Error('markers not found');
const code = html.slice(a, b);

let pass = 0, fail = 0;
const ok = (c, n, x) => { if (c) pass++; else { fail++; console.log('FAIL  ' + n + (x ? '  ' + x : '')); } };

function world(replies) {
  const sent = [], st = { refresh: 0, lost: 0, proxyOn: true };
  const fetchFn = async (url, init) => { sent.push({ url: String(url), init }); const r = replies.shift() || [200, {}]; return new Response(JSON.stringify(r[1]), { status: r[0] }); };
  const SR = { getToken: async () => 'tok1', refreshSession: async () => { st.refresh++; return { access_token: 'tok2' }; } };
  const srCfg = () => ({ url: 'https://proj.supabase.co/', key: 'sb_publishable_placeholder' });
  const srAuthLost = () => { st.lost++; };
  const T = new Function('fetch', 'SR', 'srCfg', 'srAuthLost', 'AI_TEAM', 'st', code.replace(/PROXY_ON = false/g, 'st.proxyOn = false') + '\nreturn aiFetch;')(fetchFn, SR, srCfg, srAuthLost, '@team', st);
  return { aiFetch: T, sent, st };
}
const PAY = { model: 'claude-sonnet-4-6', max_tokens: 10, messages: [{ role: 'user', content: 'hi' }] };

// direct calls are exactly what they were before the proxy existed
{
  const w = world([[200, {}], [200, {}]]);
  await w.aiFetch('anthropic', PAY, 'sk-ant-placeholder'); await w.aiFetch('openai', { ...PAY, model: 'gpt-4o' }, 'sk-placeholder');
  const [an, oa] = w.sent;
  ok(an.url === 'https://api.anthropic.com/v1/messages' && an.init.headers['x-api-key'] === 'sk-ant-placeholder' && an.init.headers['anthropic-version'] === '2023-06-01' && an.init.headers['anthropic-dangerous-direct-browser-access'] === 'true' && an.init.headers['anthropic-beta'] === 'prompt-caching-2024-07-31', 'Anthropic direct: same URL and headers as before');
  ok(oa.url === 'https://api.openai.com/v1/chat/completions' && oa.init.headers.Authorization === 'Bearer sk-placeholder', 'OpenAI direct: same URL and header as before');
  ok(JSON.parse(an.init.body).model === 'claude-sonnet-4-6', 'the payload is sent as given');
}
// through the team server: no key anywhere, the user's token instead
{
  const w = world([[200, { content: [] }]]);
  const res = await w.aiFetch('anthropic', PAY, '@team'), s = w.sent[0], body = JSON.parse(s.init.body);
  ok(res.ok && s.url === 'https://proj.supabase.co/functions/v1/ai-proxy', 'proxy URL (no double slash)');
  ok(s.init.headers.Authorization === 'Bearer tok1' && s.init.headers.apikey === 'sb_publishable_placeholder' && !('x-api-key' in s.init.headers), 'proxy: the user token and the public key, no provider key');
  ok(body.provider === 'anthropic' && body.payload.model === 'claude-sonnet-4-6' && !JSON.stringify(body).includes('sk-'), 'proxy: provider + payload, nothing secret');
}
// a provider rejecting the team key (401 passed through) must NOT look like a lost session
{
  const w = world([[401, { type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } }]]);
  const res = await w.aiFetch('anthropic', PAY, '@team'), j = await res.json();
  ok(res.status === 401 && /invalid x-api-key/.test(j.error.message), 'the provider 401 is returned to the caller unchanged');
  ok(w.st.refresh === 0 && w.st.lost === 0 && w.sent.length === 1, 'no refresh, no sign-out, no retry for a rejected team key');
}
// the proxy saying "sign in again" refreshes once and retries
{
  const w = world([[401, { type: 'error', error: { type: 'signed_out', message: 'Please sign in again.' } }], [200, { content: [] }]]);
  const res = await w.aiFetch('anthropic', PAY, '@team');
  ok(res.ok && w.st.refresh === 1 && w.sent.length === 2 && w.sent[1].init.headers.Authorization === 'Bearer tok2', 'expired token: refreshed once, retried with the new token');
}
// still signed out after the refresh: the sign-in screen, with a clear error
{
  const w = world([[401, { error: { type: 'signed_out' } }], [401, { error: { type: 'signed_out' } }]]);
  let msg = ''; try { await w.aiFetch('anthropic', PAY, '@team'); } catch (e) { msg = e.message; }
  ok(/sign in again/i.test(msg) && w.st.lost === 1, 'a really ended session: error + sign-in screen');
}
// a bare gateway 401 (not JSON) counts as a lost session; a 404 switches the proxy off
{
  const w = world([]); let n = 0;
  const fetchFn = async () => (n++ ? new Response('{}', { status: 200 }) : new Response('Unauthorized', { status: 401 }));
  const T = new Function('fetch', 'SR', 'srCfg', 'srAuthLost', 'AI_TEAM', 'st', code.replace(/PROXY_ON = false/g, 'st.proxyOn = false') + '\nreturn aiFetch;')(fetchFn, { getToken: async () => 't', refreshSession: async () => { w.st.refresh++; return { access_token: 't2' }; } }, () => ({ url: 'https://p.supabase.co', key: 'k' }), () => { w.st.lost++; }, '@team', w.st);
  const res = await T('openai', PAY, '@team'); ok(res.ok && w.st.refresh === 1, 'a non-JSON 401 from the gateway is treated as an expired token');
  const w2 = world([[404, {}]]); await w2.aiFetch('anthropic', PAY, '@team'); ok(w2.st.proxyOn === false, 'a 404 (function removed) switches the proxy off');
}

console.log(`${fail ? 'FAILED' : 'OK'}: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
