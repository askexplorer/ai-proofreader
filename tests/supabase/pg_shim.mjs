// Local stand-in for Supabase (for tests only; never ships): PostgREST RPC + a small slice of Supabase Auth, on real PostgreSQL (PGlite).
//   POST /rest/v1/rpc/<fn>                     -> function call, role anon or authenticated (from the JWT)
//   POST /auth/v1/token?grant_type=password    -> { email, password }   -> session
//   POST /auth/v1/token?grant_type=refresh_token
//   POST /auth/v1/logout
// Test-only extras: POST /__sql (superuser), POST /__mkuser, GET /__ping.
import { PGlite } from '@electric-sql/pglite';
import http from 'node:http';
import crypto from 'node:crypto';
import { readFileSync } from 'node:fs';

const PORT = +(process.env.PORT || 54321);
const ANON_KEY = process.env.ANON_KEY || 'sb_publishable_testkey_1234567890';
const TOKEN_TTL = +(process.env.TOKEN_TTL || 3600);
const JWT_SECRET = 'shim-only-secret';
const SQL = readFileSync(new URL('../../supabase/setup.sql', import.meta.url), 'utf8');
const db = new PGlite();

// What a real Supabase project already provides
await db.exec(`
  create role anon nologin; create role authenticated nologin;
  create schema auth;
  create table auth.users (
    id uuid primary key default gen_random_uuid(), email text unique, encrypted_password text,
    banned_until timestamptz, deleted_at timestamptz, raw_user_meta_data jsonb default '{}'::jsonb);
  create function auth.uid() returns uuid language sql stable as $$
    select nullif(coalesce(current_setting('request.jwt.claim.sub', true),
                           (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')), '')::uuid $$;
  alter default privileges in schema public grant all on functions to anon, authenticated;
  alter default privileges in schema public grant all on tables to anon, authenticated;
  grant usage on schema auth to anon, authenticated;
  grant execute on function auth.uid() to anon, authenticated;
`);
await db.exec(SQL);

// parameter name -> SQL type (what PostgREST learns from the function signature)
const SIG = {
  share_info:     { p_id: 'uuid' },
  share_open:     { p_id: 'uuid', p_auth: 'text' },
  share_save:     { p_id: 'uuid', p_auth: 'text', p_decisions: 'text', p_submit: 'boolean', p_expected: 'int' },
  team_whoami:    {},
  team_keys_get:  {},
  team_keys_put:  { p_a: 'text', p_o: 'text' },
  team_keys_clear: {},
  share_create:   { p_id: 'uuid', p_salt: 'text', p_iter: 'int', p_auth: 'text', p_payload: 'text', p_days: 'int', p_title: 'text', p_password: 'text', p_issues: 'int' },
  share_list:     {},
  share_manage:   { p_id: 'uuid', p_action: 'text', p_days: 'int' },
  share_applied:  { p_id: 'uuid', p_issue: 'text', p_done: 'boolean' },
  team_members_list: {},
  team_member_add: { p_email: 'text', p_admin: 'boolean' },
  team_member_remove: { p_user: 'uuid' },
  team_member_admin: { p_user: 'uuid', p_admin: 'boolean' },
};
const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'apikey, authorization, content-type, x-client-info', 'Access-Control-Allow-Methods': 'POST, GET, OPTIONS' };
const send = (res, code, body) => { res.writeHead(code, { ...CORS, 'Content-Type': 'application/json' }); res.end(body === undefined ? '' : typeof body === 'string' ? body : JSON.stringify(body)); };
const sha = (s) => crypto.createHash('sha256').update(s, 'utf8').digest('hex');
const b64u = (x) => Buffer.from(x).toString('base64url');
const sign = (p) => { const h = b64u(JSON.stringify({ alg: 'HS256', typ: 'JWT' })), b = b64u(JSON.stringify(p)); return h + '.' + b + '.' + crypto.createHmac('sha256', JWT_SECRET).update(h + '.' + b).digest('base64url'); };
const verify = (tok) => {
  const [h, b, s] = String(tok).split('.'); if (!h || !b || !s) return { err: 'JWT invalid' };
  if (crypto.createHmac('sha256', JWT_SECRET).update(h + '.' + b).digest('base64url') !== s) return { err: 'JWT invalid' };
  const p = JSON.parse(Buffer.from(b, 'base64url').toString()); if (p.exp < Date.now() / 1000) return { err: 'JWT expired' };
  return { p };
};
const refresh = new Map();                           // refresh token -> user id
let chain = Promise.resolve();                       // serialise DB access

async function session(u) {
  const now = Math.floor(Date.now() / 1000), exp = now + TOKEN_TTL, rt = crypto.randomBytes(8).toString('hex');
  refresh.set(rt, u.id);
  return { access_token: sign({ sub: u.id, email: u.email, role: 'authenticated', aud: 'authenticated', iat: now, exp }), token_type: 'bearer',
           expires_in: TOKEN_TTL, expires_at: exp, refresh_token: rt, user: { id: u.id, email: u.email, user_metadata: u.raw_user_meta_data } };
}
const findUser = async (where, v) => (await db.query(`select * from auth.users where ${where}`, [v])).rows[0];
const isBanned = (u) => u.banned_until && new Date(u.banned_until) > new Date();

http.createServer((req, res) => {
  if (req.method === 'OPTIONS') { res.writeHead(204, CORS); return res.end(); }
  let raw = ''; req.on('data', (c) => (raw += c));
  req.on('end', () => {
    chain = chain.then(async () => {
      try {
        const url = new URL(req.url, 'http://x');
        if (url.pathname === '/__ping') return send(res, 200, { ok: true });
        if (url.pathname === '/__sql') { const r = await db.query(raw); return send(res, 200, { rows: r.rows }); }
        if (url.pathname === '/__mkuser') {
          const { email, password, name, admin, nomember } = JSON.parse(raw);
          const r = await db.query(`insert into auth.users(email, encrypted_password, raw_user_meta_data) values (lower($1), $2, $3::jsonb) returning id`,
            [email, sha(password), JSON.stringify(name ? { name } : {})]);
          if (admin) await db.query('insert into public.team_admins(user_id) values ($1)', [r.rows[0].id]);
          else if (!nomember) await db.query('insert into public.team_members(user_id, added_by) values ($1, $2)', [r.rows[0].id, 'test']);
          return send(res, 200, { id: r.rows[0].id });
        }
        if (req.headers.apikey !== ANON_KEY) return send(res, 401, { message: 'Invalid API key' });

        // ── Supabase Auth ──
        if (url.pathname === '/auth/v1/token') {
          const body = raw ? JSON.parse(raw) : {}, gt = url.searchParams.get('grant_type');
          if (gt === 'password') {
            const u = body.email ? await findUser('lower(email) = lower($1) and deleted_at is null', body.email) : null;
            if (!u || u.encrypted_password !== sha(body.password || '')) return send(res, 400, { code: 400, error_code: 'invalid_credentials', msg: 'Invalid login credentials' });
            if (isBanned(u)) return send(res, 400, { code: 400, error_code: 'user_banned', msg: 'User is banned' });
            return send(res, 200, await session(u));
          }
          if (gt === 'refresh_token') {
            const id = refresh.get(body.refresh_token); const u = id && await findUser('id = $1 and deleted_at is null', id);
            if (!u) return send(res, 400, { code: 400, error_code: 'refresh_token_not_found', msg: 'Invalid Refresh Token: Refresh Token Not Found' });
            if (isBanned(u)) return send(res, 400, { code: 400, error_code: 'user_banned', msg: 'User is banned' });
            refresh.delete(body.refresh_token);
            return send(res, 200, await session(u));
          }
          return send(res, 400, { msg: 'unsupported grant_type' });
        }
        if (url.pathname === '/auth/v1/settings') return send(res, 200, { disable_signup: process.env.SIGNUP_OPEN ? false : true, external: { email: true } });
        if (url.pathname === '/auth/v1/logout') { res.writeHead(204, CORS); return res.end(); }

        // ── PostgREST RPC ──
        const m = /^\/rest\/v1\/rpc\/([a-z_]+)$/.exec(url.pathname);
        if (!m || !SIG[m[1]]) return send(res, 404, { code: 'PGRST202', message: 'Could not find the function public.' + (m ? m[1] : '?') });
        let role = 'anon', claims = null;
        const bearer = /^Bearer (.+)$/.exec(req.headers.authorization || '');
        if (bearer && bearer[1] !== ANON_KEY) {
          const v = verify(bearer[1]);
          if (v.err) return send(res, 401, { code: v.err === 'JWT expired' ? 'PGRST303' : 'PGRST301', message: v.err });
          role = v.p.role || 'authenticated'; claims = v.p;
        }
        const args = raw ? JSON.parse(raw) : {};
        const sig = SIG[m[1]]; const names = Object.keys(sig).filter((k) => k in args);
        const sql = 'select public.' + m[1] + '(' + names.map((k, i) => `${k} => $${i + 1}::${sig[k]}`).join(', ') + ') as r';
        let out;
        try {
          await db.transaction(async (tx) => {
            await tx.exec('set local role ' + role);
            if (claims) await tx.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify(claims)]);
            out = (await tx.query(sql, names.map((k) => args[k]))).rows[0].r;
          });
        } catch (e) {
          if (/permission denied/i.test(e.message)) return send(res, role === 'anon' ? 401 : 403, { code: '42501', message: String(e.message) });
          throw e;
        }
        send(res, 200, out === null || out === undefined ? 'null' : out);
      } catch (e) { send(res, 400, { message: String(e.message || e) }); }
    });
  });
}).listen(PORT, '127.0.0.1', () => console.log('shim ready on', PORT));
