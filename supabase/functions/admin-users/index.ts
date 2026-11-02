// @ts-nocheck
// Edge Function "admin-users": lets a team ADMIN create, remove and reset colleague logins from the portal,
// so nobody has to open the Supabase dashboard.
//
// Security: the caller must be a signed-in admin. We ask the database (team_whoami, run AS the caller) before
// anything else; only then is the service key used, and only for the three actions below on team members.
// Deploy with verify_jwt = false (the check above replaces the gateway's JWT check, which does not understand
// every key format). Written without imports or type annotations so tests/admin-users.test.mjs can load this
// exact file in Node.

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, apikey, content-type, x-client-info',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Max-Age': '86400',
};
const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });
const DOMAIN = 'explorer.team';
const emailFor = (u) => { const s = String(u || '').trim().toLowerCase(); return s.indexOf('@') >= 0 ? s : s + '@' + DOMAIN; };
const validEmail = (e) => /^[a-z0-9._+-]{2,64}@[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,}$/.test(e);
const validUser = (u) => /^[a-z0-9._-]{2,40}$/.test(String(u || '').trim().toLowerCase()) || validEmail(String(u || '').trim().toLowerCase());
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function handle(req, env, doFetch) {
  doFetch = doFetch || fetch;
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
  if (req.method !== 'POST') return json(405, { ok: false, error: 'method' });

  const base = String((env && env.SUPABASE_URL) || '').replace(/\/+$/, ''), svc = (env && env.SUPABASE_SERVICE_ROLE_KEY) || '';
  if (!base || !svc) return json(500, { ok: false, error: 'not_configured' });
  const m = /^Bearer\s+(.+)$/i.exec(req.headers.get('authorization') || ''), tok = m ? m[1].trim() : '', anon = req.headers.get('apikey') || '';
  if (!tok || !anon) return json(401, { ok: false, error: 'signed_out' });

  // 1) The database says who is calling (membership + admin flag), run with the caller's own token.
  const asCaller = async (fn, args) => {
    const r = await doFetch(base + '/rest/v1/rpc/' + fn, { method: 'POST', headers: { apikey: anon, Authorization: 'Bearer ' + tok, 'Content-Type': 'application/json' }, body: JSON.stringify(args || {}) });
    let j = null; try { j = await r.json(); } catch (_) { /* not JSON */ }
    return { status: r.status, body: j };
  };
  let me;
  try { const r = await asCaller('team_whoami', {}); if (r.status === 401 || r.status === 403) return json(401, { ok: false, error: 'signed_out' }); me = r.body; }
  catch (_) { return json(502, { ok: false, error: 'network' }); }
  if (!me || me.ok !== true) return json(403, { ok: false, error: 'denied' });
  if (!me.admin) return json(403, { ok: false, error: 'forbidden' });

  let b = {}; try { b = await req.json(); } catch (_) { return json(400, { ok: false, error: 'bad_request' }); }
  const action = String((b && b.action) || '');

  // 2) The service key, used only after step 1.
  const admin = async (method, path, body) => {
    const headers = { apikey: svc, 'Content-Type': 'application/json' };
    if (/^eyJ/.test(svc)) headers.Authorization = 'Bearer ' + svc;          // legacy service_role JWT; sb_secret_ keys travel in apikey only
    const r = await doFetch(base + '/auth/v1/admin/' + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
    let j = null; try { j = await r.json(); } catch (_) { /* empty body */ }
    return { status: r.status, body: j };
  };
  const isMember = async (id) => {            // only people already on the team can be changed or removed here
    const r = await asCaller('team_members_list', {});
    return !!(r.body && r.body.ok && Array.isArray(r.body.members) && r.body.members.some((x) => String(x.id) === String(id)));
  };
  const okPassword = (p) => typeof p === 'string' && p.length >= 8 && p.length <= 72;

  try {
    if (action === 'create') {
      const user = String(b.username || '').trim().toLowerCase();
      if (!validUser(user)) return json(400, { ok: false, error: 'bad_username' });
      if (!okPassword(b.password)) return json(400, { ok: false, error: 'bad_password' });
      const email = emailFor(user);
      if (!validEmail(email)) return json(400, { ok: false, error: 'bad_username' });
      const c = await admin('POST', 'users', { email, password: b.password, email_confirm: true });
      if (c.status === 422 || c.status === 409 || (c.body && /already|exists|registered/i.test(String(c.body.msg || c.body.message || c.body.error_code || '')))) return json(409, { ok: false, error: 'exists' });
      if (c.status < 200 || c.status >= 300 || !c.body || !c.body.id) return json(502, { ok: false, error: 'server' });
      const add = await asCaller('team_member_add', { p_email: email, p_admin: !!b.admin });
      if (!add.body || add.body.ok !== true) {          // never leave a login that cannot be used
        await admin('DELETE', 'users/' + c.body.id);
        return json(502, { ok: false, error: 'server' });
      }
      return json(200, { ok: true, id: c.body.id, email });
    }
    if (action === 'remove') {
      const id = String(b.id || '');
      if (!UUID.test(id)) return json(400, { ok: false, error: 'bad_request' });
      if (id === String(me.id)) return json(400, { ok: false, error: 'bad_request' });     // never remove yourself
      if (!(await isMember(id))) return json(404, { ok: false, error: 'not_member' });
      const rm = await asCaller('team_member_remove', { p_user: id });
      if (!rm.body || rm.body.ok !== true) return json(502, { ok: false, error: 'server' });
      const d = await admin('DELETE', 'users/' + id);
      if (d.status >= 400 && d.status !== 404) return json(502, { ok: false, error: 'server' });
      return json(200, { ok: true });
    }
    if (action === 'reset') {
      const id = String(b.id || '');
      if (!UUID.test(id)) return json(400, { ok: false, error: 'bad_request' });
      if (!okPassword(b.password)) return json(400, { ok: false, error: 'bad_password' });
      if (!(await isMember(id))) return json(404, { ok: false, error: 'not_member' });
      const u = await admin('PUT', 'users/' + id, { password: b.password });
      if (u.status < 200 || u.status >= 300) return json(502, { ok: false, error: 'server' });
      return json(200, { ok: true });
    }
    return json(400, { ok: false, error: 'bad_request' });
  } catch (_) {
    return json(502, { ok: false, error: 'network' });
  }
}

// Supabase runs this file with Deno; tests import { handle } and skip this line.
if (typeof Deno !== 'undefined' && typeof Deno.serve === 'function') {
  const secrets = (() => { try { return JSON.parse(Deno.env.get('SUPABASE_SECRET_KEYS') || '{}'); } catch (_) { return {}; } })();
  Deno.serve((req) => handle(req, {
    SUPABASE_URL: Deno.env.get('SUPABASE_URL'),
    SUPABASE_SERVICE_ROLE_KEY: Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || secrets['default'] || Object.values(secrets)[0] || '',
  }, fetch));
}
