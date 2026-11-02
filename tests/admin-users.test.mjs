// Offline test for the admin-users Edge Function (supabase/functions/admin-users/index.ts), loaded exactly as written.
// Run: node tests/admin-users.test.mjs   (Node 18+). A fake Supabase records every call it receives.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = readFileSync(path.join(root, 'supabase/functions/admin-users/index.ts'), 'utf8');
const { handle } = await import('data:text/javascript;base64,' + Buffer.from(src).toString('base64'));

let pass = 0, fail = 0;
const ok = (c, n, x) => { if (c) pass++; else { fail++; console.log('FAIL  ' + n + (x ? '  ' + x : '')); } };

const SVC = 'eyJ-service-role-placeholder', ANON = 'sb_publishable_placeholder_key';
const ENV = { SUPABASE_URL: 'https://proj.supabase.co', SUPABASE_SERVICE_ROLE_KEY: SVC };
const ADMIN = { id: '11111111-1111-4111-8111-111111111111', name: 'Admin' }, BEN = '22222222-2222-4222-8222-222222222222', STRANGER = '33333333-3333-4333-8333-333333333333';
const TOK = { admin: 'tok-admin', member: 'tok-member', bad: 'tok-bad' };

// A tiny fake of the three Supabase surfaces the function touches
function fake(opts = {}) {
  const calls = [], state = { users: new Set(['admin@explorer.team', 'ben@explorer.team']), members: [{ id: ADMIN.id, email: 'admin@explorer.team' }, { id: BEN, email: 'ben@explorer.team' }] };
  const f = async (url, init = {}) => {
    const h = init.headers || {}, body = init.body ? JSON.parse(init.body) : null, u = new URL(url);
    calls.push({ method: init.method || 'GET', path: u.pathname, headers: h, body });
    const res = (status, o) => new Response(o === undefined ? null : JSON.stringify(o), { status, headers: { 'content-type': 'application/json' } });
    if (u.pathname.startsWith('/rest/v1/rpc/')) {
      const fn = u.pathname.split('/').pop(), who = Object.entries(TOK).find(([, v]) => h.Authorization === 'Bearer ' + v);
      if (!who || who[0] === 'bad') return res(401, { message: 'JWT invalid' });
      if (fn === 'team_whoami') return res(200, who[0] === 'admin' ? { ok: true, id: ADMIN.id, name: 'Admin', admin: true } : { ok: true, id: STRANGER, name: 'Member', admin: false });
      if (who[0] !== 'admin') return res(200, { ok: false, error: 'forbidden' });
      if (fn === 'team_members_list') return res(200, { ok: true, members: state.members });
      if (fn === 'team_member_add') { if (opts.addFails) return res(200, { ok: false, error: 'no_account' }); state.members.push({ id: 'new-id', email: body.p_email }); return res(200, { ok: true, id: 'new-id' }); }
      if (fn === 'team_member_remove') { state.members = state.members.filter((m) => m.id !== body.p_user); return res(200, { ok: true }); }
    }
    if (u.pathname.startsWith('/auth/v1/admin/users')) {
      if (h.apikey !== SVC) return res(401, { msg: 'no' });
      if (init.method === 'POST') { if (state.users.has(body.email)) return res(422, { error_code: 'email_exists', msg: 'A user with this email address has already been registered' }); state.users.add(body.email); return res(200, { id: 'new-id', email: body.email }); }
      if (init.method === 'PUT') return res(200, { id: u.pathname.split('/').pop() });
      if (init.method === 'DELETE') return res(200, {});
    }
    return res(404, {});
  };
  return { f, calls, state };
}
const call = (fk, token, body, extra = {}) => handle(new Request('https://x/functions/v1/admin-users', { method: 'POST', headers: { 'content-type': 'application/json', ...(token ? { authorization: 'Bearer ' + token } : {}), apikey: ANON, ...extra }, body: JSON.stringify(body) }), ENV, fk.f);
const j = async (r) => ({ s: r.status, b: await r.json() });
const usedService = (fk) => fk.calls.filter((c) => c.path.startsWith('/auth/v1/admin/'));

// --- who may call
{
  const fk = fake();
  const pre = await handle(new Request('https://x', { method: 'OPTIONS' }), ENV, fk.f);
  ok(pre.status === 204 && pre.headers.get('access-control-allow-origin') === '*' && /authorization/.test(pre.headers.get('access-control-allow-headers')), 'CORS preflight answered');
  ok((await handle(new Request('https://x', { method: 'GET' }), ENV, fk.f)).status === 405, 'only POST');
  let r = await j(await call(fk, null, { action: 'create', username: 'x', password: 'longenough1' }));
  ok(r.s === 401 && r.b.error === 'signed_out', 'no token: refused');
  r = await j(await call(fk, TOK.bad, { action: 'create', username: 'newbie', password: 'longenough1' }));
  ok(r.s === 401, 'bad token: refused');
  r = await j(await call(fk, TOK.member, { action: 'create', username: 'newbie', password: 'longenough1' }));
  ok(r.s === 403 && r.b.error === 'forbidden', 'a plain member is refused');
  ok(usedService(fk).length === 0, 'the service key is never used for someone who is not an admin');
}

// --- create
{
  const fk = fake();
  let r = await j(await call(fk, TOK.admin, { action: 'create', username: 'Newbie', password: 'correct-horse-12', admin: false }));
  ok(r.s === 200 && r.b.ok && r.b.email === 'newbie@explorer.team', 'create: username becomes name@explorer.team (lower-case)');
  const made = usedService(fk).find((c) => c.method === 'POST');
  ok(made && made.body.email === 'newbie@explorer.team' && made.body.password === 'correct-horse-12' && made.body.email_confirm === true, 'create: auto-confirmed login with the given password');
  const add = fk.calls.find((c) => c.path.endsWith('team_member_add'));
  ok(add && add.body.p_email === 'newbie@explorer.team' && add.headers.Authorization === 'Bearer ' + TOK.admin, 'create: added to the team AS the admin (database rules apply)');
  ok(!JSON.stringify(r.b).includes(SVC) && !JSON.stringify(r.b).includes('correct-horse'), 'create: response contains neither the service key nor the password');
  r = await j(await call(fk, TOK.admin, { action: 'create', username: 'ben', password: 'correct-horse-12' }));
  ok(r.s === 409 && r.b.error === 'exists', 'create: existing login -> exists');
  for (const [u, p, e] of [['a', 'correct-horse-12', 'bad_username'], ['bad name', 'correct-horse-12', 'bad_username'], ['', 'correct-horse-12', 'bad_username'], ['ok-name', 'short', 'bad_password'], ['ok-name', 'x'.repeat(73), 'bad_password'], ['ok-name', null, 'bad_password']]) {
    const t = await j(await call(fake(), TOK.admin, { action: 'create', username: u, password: p }));
    ok(t.s === 400 && t.b.error === e, 'create: rejects ' + JSON.stringify([u.slice(0, 12), p && String(p).slice(0, 6)]) + ' as ' + e);
  }
  const ex = await j(await call(fake(), TOK.admin, { action: 'create', username: 'anna@other.org', password: 'correct-horse-12' }));
  ok(ex.s === 200 && ex.b.email === 'anna@other.org', 'create: a full email is accepted as given');
}
{
  const fk = fake({ addFails: true });
  const r = await j(await call(fk, TOK.admin, { action: 'create', username: 'orphan', password: 'correct-horse-12' }));
  ok(r.s === 502, 'create: team step fails -> error');
  ok(usedService(fk).some((c) => c.method === 'DELETE'), 'create: the half-made login is deleted again (no orphan)');
}

// --- remove
{
  const fk = fake();
  let r = await j(await call(fk, TOK.admin, { action: 'remove', id: BEN }));
  ok(r.s === 200 && r.b.ok, 'remove: a team member is removed');
  ok(fk.calls.some((c) => c.path.endsWith('team_member_remove') && c.body.p_user === BEN) && usedService(fk).some((c) => c.method === 'DELETE' && c.path.endsWith('/' + BEN)), 'remove: team rows removed, then the login deleted');
  r = await j(await call(fake(), TOK.admin, { action: 'remove', id: ADMIN.id }));
  ok(r.s === 400, 'remove: an admin cannot remove themselves');
  const fk2 = fake();
  r = await j(await call(fk2, TOK.admin, { action: 'remove', id: STRANGER }));
  ok(r.s === 404 && r.b.error === 'not_member' && usedService(fk2).length === 0, 'remove: someone who is not on the team is never touched');
  r = await j(await call(fake(), TOK.admin, { action: 'remove', id: 'not-a-uuid' }));
  ok(r.s === 400, 'remove: malformed id refused');
}

// --- reset
{
  const fk = fake();
  let r = await j(await call(fk, TOK.admin, { action: 'reset', id: BEN, password: 'brand-new-pass-7' }));
  const put = usedService(fk).find((c) => c.method === 'PUT');
  ok(r.s === 200 && put && put.body.password === 'brand-new-pass-7' && put.path.endsWith('/' + BEN), 'reset: sets the new password for a member');
  r = await j(await call(fake(), TOK.admin, { action: 'reset', id: BEN, password: 'short' }));
  ok(r.s === 400 && r.b.error === 'bad_password', 'reset: short password refused');
  const fk3 = fake();
  r = await j(await call(fk3, TOK.admin, { action: 'reset', id: STRANGER, password: 'brand-new-pass-7' }));
  ok(r.s === 404 && usedService(fk3).length === 0, 'reset: a non-member is never touched');
  r = await j(await call(fake(), TOK.admin, { action: 'nonsense' }));
  ok(r.s === 400, 'unknown action refused');
}

// --- configuration and key style
{
  const r = await handle(new Request('https://x', { method: 'POST', headers: { authorization: 'Bearer t', apikey: 'k' }, body: '{}' }), {}, async () => new Response('{}'));
  ok(r.status === 500, 'missing service key -> not_configured, nothing attempted');
  const fk = fake();
  const secretEnv = { SUPABASE_URL: ENV.SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY: 'sb_secret_placeholder' };
  const seen = [];
  const f2 = async (url, init) => { seen.push({ url, init }); if (String(url).includes('/rest/v1/rpc/team_whoami')) return new Response(JSON.stringify({ ok: true, id: ADMIN.id, admin: true }), { status: 200 }); if (String(url).includes('team_member_add')) return new Response(JSON.stringify({ ok: true }), { status: 200 }); return new Response(JSON.stringify({ id: 'n1' }), { status: 200 }); };
  await handle(new Request('https://x', { method: 'POST', headers: { authorization: 'Bearer ' + TOK.admin, apikey: ANON }, body: JSON.stringify({ action: 'create', username: 'newbie', password: 'correct-horse-12' }) }), secretEnv, f2);
  const adm = seen.find((c) => String(c.url).includes('/auth/v1/admin/users'));
  ok(adm && adm.init.headers.apikey === 'sb_secret_placeholder' && !adm.init.headers.Authorization, 'an sb_secret_ key is sent in apikey only, never as a Bearer token');
  void fk;
}

console.log(`${fail ? 'FAILED' : 'OK'}: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
