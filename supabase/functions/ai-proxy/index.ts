// @ts-nocheck
// Edge Function "ai-proxy": the team's AI keys stay on the server. A signed-in colleague sends the same request they
// would have sent to Anthropic / OpenAI; this function adds the team key and forwards it, so no key ever reaches a browser.
//
// Security: it runs AS THE CALLER. team_whoami (must be a team member) and team_keys_get (the database releases the keys
// only to members) are called with the caller's own token, so no service key is needed or used. The key is never logged
// and never part of any response. Deploy with verify_jwt = false (the member check above replaces the gateway check).
//
// Limits: Supabase free plan ends a function after 150 s, so the upstream call is cut at 140 s with a clear message.
// Written without imports or type annotations so tests/ai-proxy.test.mjs can load this exact file in Node.

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, apikey, content-type, x-client-info',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Expose-Headers': 'retry-after, request-id, x-ratelimit-reset-requests, x-ratelimit-reset-tokens, anthropic-ratelimit-requests-reset, anthropic-ratelimit-tokens-reset',
  'Access-Control-Max-Age': '86400',
};
const json = (status, body, extra) => new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json', ...(extra || {}) } });
const errBody = (type, message) => ({ type: 'error', error: { type, message } });   // same shape the providers use, so the browser reads it the same way
const MAX_BODY = 6000000, UPSTREAM_MS = 140000, MAX_TOKENS = 16000;

// Anthropic keys start sk-ant-, OpenAI keys sk- (never sk-ant-). The stored pair was once saved crossed: sort by prefix.
const kind = (k) => { k = String(k || '').trim(); return /^sk-ant-/.test(k) ? 'anthropic' : /^sk-/.test(k) ? 'openai' : ''; };
function sortKeys(a, o) {
  a = String(a || '').trim(); o = String(o || '').trim();
  const ka = kind(a), ko = kind(o);
  if (ka === 'openai' && ko === 'anthropic') return { a: o, o: a };
  if (ka === 'openai' && !o) return { a: '', o: a };
  if (ko === 'anthropic' && !a) return { a: o, o: '' };
  return { a, o };
}
const PASS = /^(content-type|retry-after|request-id|x-ratelimit-.*|anthropic-ratelimit-.*)$/i;

export async function handle(req, env, doFetch) {
  doFetch = doFetch || fetch;
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
  if (req.method !== 'POST') return json(405, errBody('method', 'Use POST.'));

  const base = String((env && env.SUPABASE_URL) || '').replace(/\/+$/, '');
  if (!base) return json(500, errBody('not_configured', 'The proxy is not configured.'));
  const m = /^Bearer\s+(.+)$/i.exec(req.headers.get('authorization') || ''), tok = m ? m[1].trim() : '', anon = req.headers.get('apikey') || '';
  if (!tok || !anon) return json(401, errBody('signed_out', 'Please sign in again.'));
  if (Number(req.headers.get('content-length') || 0) > MAX_BODY) return json(413, errBody('too_large', 'That request is too large.'));

  const asCaller = async (fn) => {
    const r = await doFetch(base + '/rest/v1/rpc/' + fn, { method: 'POST', headers: { apikey: anon, Authorization: 'Bearer ' + tok, 'Content-Type': 'application/json' }, body: '{}' });
    let j = null; try { j = await r.json(); } catch (_) { /* not JSON */ }
    return { status: r.status, body: j };
  };
  let who, kr;
  try {
    who = await asCaller('team_whoami');
    if (who.status === 401 || who.status === 403) return json(401, errBody('signed_out', 'Please sign in again.'));
    if (!who.body || who.body.ok !== true) return json(403, errBody('denied', 'Your account is not part of the team.'));
    kr = await asCaller('team_keys_get');
  } catch (_) { return json(502, errBody('network', 'Could not reach the team database.')); }
  const stored = (kr.body && kr.body.ok && kr.body.keys) || {};
  const keys = sortKeys(stored.a, stored.o);

  let b; try { b = await req.json(); } catch (_) { return json(400, errBody('bad_request', 'The request was not valid JSON.')); }
  if (b && b.ping) return json(200, { ok: true, anthropic: !!keys.a, openai: !!keys.o });

  const provider = b && b.provider, payload = b && b.payload;
  if (provider !== 'anthropic' && provider !== 'openai') return json(400, errBody('bad_request', 'Unknown provider.'));
  if (!payload || typeof payload !== 'object' || Array.isArray(payload) || typeof payload.model !== 'string') return json(400, errBody('bad_request', 'The request needs a model.'));
  if (!payload.model.startsWith(provider === 'anthropic' ? 'claude-' : 'gpt-')) return json(400, errBody('bad_request', 'That model does not belong to this provider.'));
  if (payload.stream) return json(400, errBody('bad_request', 'Streaming is not supported here.'));
  const mt = Number(payload.max_tokens || payload.max_completion_tokens || 0);
  if (mt > MAX_TOKENS) return json(400, errBody('bad_request', 'max_tokens is too large.'));
  const key = provider === 'anthropic' ? keys.a : keys.o;
  if (!key) return json(400, errBody('no_key', 'Your admin has not stored a team ' + (provider === 'anthropic' ? 'Anthropic' : 'OpenAI') + ' key yet.'));

  const url = provider === 'anthropic' ? 'https://api.anthropic.com/v1/messages' : 'https://api.openai.com/v1/chat/completions';
  const headers = provider === 'anthropic'
    ? { 'Content-Type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01', 'anthropic-beta': 'prompt-caching-2024-07-31' }
    : { 'Content-Type': 'application/json', Authorization: 'Bearer ' + key };
  const ctl = new AbortController(), timer = setTimeout(() => ctl.abort(), UPSTREAM_MS);
  try {
    const up = await doFetch(url, { method: 'POST', headers, body: JSON.stringify(payload), signal: ctl.signal });
    const text = await up.text();
    const out = {}; up.headers.forEach((v, k) => { if (PASS.test(k)) out[k] = v; });
    if (!out['content-type']) out['content-type'] = 'application/json';
    return new Response(text, { status: up.status, headers: { ...CORS, ...out } });
  } catch (e) {
    if (e && (e.name === 'AbortError' || ctl.signal.aborted)) return json(504, errBody('proxy_timeout', 'The AI took longer than 140 seconds to answer. Try a faster model (Sonnet or Haiku) or a smaller part of the document.'));
    return json(502, errBody('network', 'The server could not reach the AI provider.'));
  } finally { clearTimeout(timer); }
}

// Supabase runs this file with Deno; tests import { handle } and skip this line.
if (typeof Deno !== 'undefined' && typeof Deno.serve === 'function') {
  Deno.serve((req) => handle(req, { SUPABASE_URL: Deno.env.get('SUPABASE_URL') }, fetch));
}
