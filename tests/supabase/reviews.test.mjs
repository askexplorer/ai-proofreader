// Reviews (v5.3): withdraw / restore, team-side view, list details. SQL rules on a real Postgres (PGlite).
// Run: cd tests && npm install && node supabase/reviews.test.mjs
import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';

const SQL = readFileSync(new URL('../../supabase/setup.sql', import.meta.url), 'utf8');
let pass = 0, fail = 0;
const t = (name, cond, extra = '') => { (cond ? pass++ : fail++); if (!cond) console.log('FAIL  ' + name + '  ' + extra); };
const denied = async (fn) => { try { await fn(); return false; } catch (e) { return /permission denied/i.test(e.message); } };

const db = new PGlite();
await db.exec(`
  create role anon nologin; create role authenticated nologin; create schema auth;
  create table auth.users (id uuid primary key default gen_random_uuid(), email text unique, encrypted_password text,
    banned_until timestamptz, deleted_at timestamptz, raw_user_meta_data jsonb default '{}'::jsonb);
  create function auth.uid() returns uuid language sql stable as $$
    select nullif(coalesce(current_setting('request.jwt.claim.sub', true), (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')), '')::uuid $$;
  alter default privileges in schema public grant all on functions to anon, authenticated;
  alter default privileges in schema public grant all on tables to anon, authenticated;
  grant usage on schema auth to anon, authenticated; grant execute on function auth.uid() to anon, authenticated;`);

// A database made BEFORE v5.3 (old table, old share_create signature, a review that was already withdrawn): the update must carry it over.
await db.exec(`create schema if not exists public;
  create table public.review_shares (id uuid primary key, salt text not null, kdf_iter int not null default 600000, verifier text not null, payload text not null, decisions text,
    status text not null default 'pending' check (status in ('pending','in_progress','submitted','revoked')), version int not null default 0, failed_attempts int not null default 0,
    locked_until timestamptz, created_at timestamptz not null default now(), expires_at timestamptz not null, opened_at timestamptz, submitted_at timestamptz,
    created_by uuid, created_by_name text, title text, password text, issue_count int not null default 0, applied jsonb not null default '{}'::jsonb);
  create function public.share_create(p_id uuid, p_salt text, p_iter int, p_auth text, p_payload text, p_days int, p_title text, p_password text, p_issues int) returns jsonb language sql as $$ select '{}'::jsonb $$;
  insert into public.review_shares(id, salt, verifier, payload, status, expires_at, title, password, issue_count)
    values ('00000000-0000-4000-8000-0000000000aa', 's', 'v', 'OLD', 'revoked', now() + interval '10 days', 'Old withdrawn review', 'oldpassword1', 4);`);
await db.exec(SQL); await db.exec(SQL);
t('setup.sql upgrades an older database and runs again without errors', true);
const sigs = (await db.query(`select pg_get_function_identity_arguments(p.oid) a from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname='public' and p.proname='share_create'`)).rows;
t('only the new share_create (with p_meta) exists, no ambiguous old overload', sigs.length === 1 && /p_meta jsonb/.test(sigs[0].a), JSON.stringify(sigs));
const old = (await db.query(`select meta, status, title from public.review_shares where id='00000000-0000-4000-8000-0000000000aa'`)).rows[0];
t('an existing review keeps its data and gets empty details', old.status === 'revoked' && old.title === 'Old withdrawn review' && JSON.stringify(old.meta) === '{}', JSON.stringify(old));

const mk = async (email) => (await db.query(`insert into auth.users(email) values ($1) returning id`, [email])).rows[0].id;
const ADMIN = await mk('anna@explorer.team'), BEN = await mk('ben@explorer.team'), CARL = await mk('carl@explorer.team'), STRANGER = await mk('mallory@example.org');
await db.query('insert into public.team_admins(user_id) values ($1)', [ADMIN]);
for (const u of [BEN, CARL]) await db.query("insert into public.team_members(user_id, added_by) values ($1, 'test')", [u]);
const call = async (uid, fn, args = []) => {
  await db.exec('begin');
  try {
    await db.exec(uid ? 'set local role authenticated' : 'set local role anon');
    if (uid) await db.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: uid, role: 'authenticated' })]);
    const r = await db.query(`select public.${fn}(${args.map((_, i) => '$' + (i + 1)).join(',')}) as r`, args);
    await db.exec('commit'); return r.rows[0].r;
  } catch (e) { await db.exec('rollback'); throw e; }
};
const asRole = async (role, q) => { await db.exec('begin'); try { await db.exec('set local role ' + role); const r = await db.query(q); await db.exec('commit'); return r; } catch (e) { await db.exec('rollback'); throw e; } };

const R1 = '11111111-1111-4111-8111-111111111111', R2 = '22222222-2222-4222-8222-222222222222', NOPE = '99999999-9999-4999-8999-999999999999';
const META = { kind: 'translation', language: 'Spanish', sourceLanguage: 'English', pages: 82, items: 9, severities: { Major: 2, Query: 7 }, projectId: 'p-1', found: 40 };
const create = (uid, id, meta, title = 'Translation check: demo.docx') => call(uid, 'share_create', [id, 'salt', 600000, 'proof-' + id, 'CIPHERTEXT', 30, title, 'correct-horse-12', 9, meta === undefined ? null : JSON.stringify(meta)]);

// --- list details
let r = await create(BEN, R1, META);
t('a member can create a review with list details', r.ok === true, JSON.stringify(r));
r = await call(CARL, 'share_list');
let row = r.shares.find((x) => x.id === R1);
t('the list carries the details for every member', row && row.meta.language === 'Spanish' && row.meta.sourceLanguage === 'English' && row.meta.severities.Major === 2 && row.meta.projectId === 'p-1', JSON.stringify(row));
t('the list never carries the encrypted report', !('payload' in row));
r = await create(BEN, R2, undefined, 'No details'); row = (await call(BEN, 'share_list')).shares.find((x) => x.id === R2);
t('a review made without details has an empty details object (old clients keep working)', r.ok && JSON.stringify(row.meta) === '{}', JSON.stringify(row));
r = await call(BEN, 'share_create', ['33333333-3333-4333-8333-333333333333', 's', 600000, 'a', 'P', 30, 't', 'longenough1', 1]);
t('a call WITHOUT p_meta (an older browser page) still works', r.ok === true, JSON.stringify(r));
r = await create(BEN, '44444444-4444-4444-8444-444444444444', ['not', 'an', 'object']);
row = (await call(BEN, 'share_list')).shares.find((x) => x.id === '44444444-4444-4444-8444-444444444444');
t('details that are not an object are stored as empty', r.ok && JSON.stringify(row.meta) === '{}');
r = await create(BEN, '55555555-5555-4555-8555-555555555555', { blob: 'x'.repeat(5000) });
row = (await call(BEN, 'share_list')).shares.find((x) => x.id === '55555555-5555-4555-8555-555555555555');
t('oversized details are stored as empty', r.ok && JSON.stringify(row.meta) === '{}');

// --- withdraw / restore
r = await call(BEN, 'share_manage', [R1, 'revoke', 30]); t('the creator can withdraw a link', r.ok === true);
row = (await call(CARL, 'share_list')).shares.find((x) => x.id === R1); t('it shows as withdrawn (revoked) for the team', row.status === 'revoked');
r = await call(null, 'share_info', [R1]); t('a withdrawn link is closed for the reviewer (share_info)', r.ok === false && r.error === 'not_found');
r = await call(null, 'share_open', [R1, 'proof-' + R1]); t('a withdrawn link cannot be opened by the reviewer even with the right proof', r.ok === false && r.error === 'not_found');
r = await call(CARL, 'share_manage', [R1, 'restore', 30]); t('another member cannot restore it', r.ok === false && r.error === 'forbidden', JSON.stringify(r));
r = await call(STRANGER, 'share_manage', [R1, 'restore', 30]); t('a stranger cannot restore it', r.ok === false && r.error === 'denied');
await db.query(`update public.review_shares set expires_at = now() + interval '1 day' where id = $1`, [R1]);
r = await call(BEN, 'share_manage', [R1, 'restore', 30]); t('the creator can restore it', r.ok === true, JSON.stringify(r));
row = (await call(BEN, 'share_list')).shares.find((x) => x.id === R1);
t('a review nobody had answered goes back to waiting', row.status === 'pending', row.status);
t('the link keeps working for at least a week after a restore', new Date(row.expires_at) > new Date(Date.now() + 6.5 * 864e5), row.expires_at);
r = await call(null, 'share_info', [R1]); t('the reviewer can open the same link again', r.ok === true);
r = await call(null, 'share_open', [R1, 'proof-' + R1]); t('and the same password still works', r.ok === true && r.payload === 'CIPHERTEXT', JSON.stringify(r));

// a review the reviewer had started comes back as in progress; a submitted one as submitted
await call(null, 'share_save', [R1, 'proof-' + R1, 'DECISIONS', false, 0]);
await call(BEN, 'share_manage', [R1, 'revoke', 30]); await call(BEN, 'share_manage', [R1, 'restore', 30]);
t('a review the reviewer had started comes back as in progress', (await call(BEN, 'share_list')).shares.find((x) => x.id === R1).status === 'in_progress');
await call(null, 'share_save', [R1, 'proof-' + R1, 'DECISIONS2', true, 1]);
await call(ADMIN, 'share_manage', [R1, 'revoke', 30]);
r = await call(ADMIN, 'share_manage', [R1, 'restore', 30]); t('an admin can withdraw and restore anyone\'s review', r.ok === true);
row = (await call(BEN, 'share_list')).shares.find((x) => x.id === R1); t('a submitted review comes back as submitted, with its answers', row.status === 'submitted' && row.version === 2);
r = await call(BEN, 'share_manage', [R1, 'restore', 30]); t('restoring a link that is not withdrawn changes nothing', r.ok === true && (await call(BEN, 'share_list')).shares.find((x) => x.id === R1).status === 'submitted');
r = await call(BEN, 'share_manage', [R1, 'explode', 30]); t('an unknown action is refused', r.ok === false && r.error === 'bad_action');

// --- share_view: the team's way in
r = await call(BEN, 'share_manage', [R2, 'revoke', 30]);
r = await call(CARL, 'share_view', [R2]);
t('a member can view a WITHDRAWN review (payload + salt for the stored password)', r.ok === true && r.payload === 'CIPHERTEXT' && r.salt === 'salt' && r.iter === 600000 && r.status === 'revoked', JSON.stringify(r));
const before = (await db.query(`select opened_at, failed_attempts, locked_until from public.review_shares where id = $1`, [R2])).rows[0];
t('viewing as a member does not count as the reviewer opening it', before.opened_at === null && before.failed_attempts === 0 && before.locked_until === null, JSON.stringify(before));
await db.query(`update public.review_shares set expires_at = now() - interval '1 day' where id = $1`, [R2]);
await db.query(`update public.review_shares set status = 'pending' where id = $1`, [R2]);
r = await call(CARL, 'share_view', [R2]); t('an expired review can still be viewed, reported as expired', r.ok === true && r.status === 'expired', JSON.stringify(r));
r = await call(CARL, 'share_view', [NOPE]); t('unknown id -> not_found', r.ok === false && r.error === 'not_found');
r = await call(STRANGER, 'share_view', [R1]); t('a stranger (signed up, not approved) is denied', r.ok === false && r.error === 'denied');
t('anon cannot call share_view', await denied(() => call(null, 'share_view', [R1])));
t('anon cannot call share_meta', await denied(() => call(null, 'share_meta', [R1, '{"kind":"x"}'])));
t('anon cannot call _clean_meta', await denied(() => call(null, '_clean_meta', ['{}'])));
t('authenticated cannot call _clean_meta either (internal helper)', await denied(() => call(BEN, '_clean_meta', ['{}'])));
t('anon cannot call share_manage', await denied(() => call(null, 'share_manage', [R1, 'restore', 30])));
t('the review table is still sealed', await denied(() => asRole('authenticated', 'select meta from public.review_shares')));

// --- share_meta: fill in older reviews
const OLD = '00000000-0000-4000-8000-0000000000aa';
row = (await call(CARL, 'share_list')).shares.find((x) => x.id === OLD);
t('the review that existed before the update is listed, with empty details', row && row.status === 'revoked' && JSON.stringify(row.meta) === '{}' && row.password === 'oldpassword1');
r = await call(CARL, 'share_meta', [OLD, JSON.stringify({ kind: 'proofread', language: 'French', items: 4 })]);
t('any member can fill in details that are still empty (older reviews)', r.ok === true, JSON.stringify(r));
row = (await call(BEN, 'share_list')).shares.find((x) => x.id === OLD); t('the details are stored for everyone', row.meta.language === 'French' && row.meta.kind === 'proofread');
r = await call(CARL, 'share_meta', [OLD, JSON.stringify({ kind: 'proofread', language: 'German' })]);
t('a member who did not share it cannot overwrite details that exist', r.ok === false && r.error === 'forbidden', JSON.stringify(r));
r = await call(ADMIN, 'share_meta', [OLD, JSON.stringify({ kind: 'proofread', language: 'German' })]); t('an admin can correct them', r.ok === true);
r = await call(ADMIN, 'share_meta', [OLD, '[1,2]']); t('details that are not an object are refused', r.ok === false && r.error === 'bad_request');
r = await call(ADMIN, 'share_meta', [OLD, '{}']); t('empty details are refused', r.ok === false && r.error === 'bad_request');
r = await call(ADMIN, 'share_meta', [NOPE, '{"kind":"x"}']); t('unknown id -> not_found', r.ok === false && r.error === 'not_found');
r = await call(STRANGER, 'share_meta', [OLD, '{"kind":"x"}']); t('a stranger is denied', r.ok === false && r.error === 'denied');

// --- delete still removes everything
r = await call(BEN, 'share_manage', [R2, 'delete', 30]); t('the creator can delete a review', r.ok === true);
r = await call(CARL, 'share_view', [R2]); t('a deleted review cannot be viewed any more', r.ok === false && r.error === 'not_found');

console.log(`${fail ? 'FAILED' : 'OK'}: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
