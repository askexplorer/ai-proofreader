// Shared projects: SQL rules on a real Postgres (PGlite). Run: cd tests && npm install && node supabase/projects.test.mjs
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
await db.exec(SQL); await db.exec(SQL);
t('setup.sql (with projects) runs, and runs again without errors', true);

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

const P1 = '11111111-1111-4111-8111-111111111111', P2 = '22222222-2222-4222-8222-222222222222';
const save = (uid, id, kind = 'proofread', title = 'Doc A', payload = 'H4sIAAAA', summary = { errors: 3 }, instr = 'Use British English.') => call(uid, 'project_save', [id, kind, title, JSON.stringify(summary), payload, instr]);

// the table is sealed; the functions are the only way in
for (const role of ['anon', 'authenticated']) t(`${role} cannot read projects directly`, await denied(() => asRole(role, 'select * from public.projects')));
for (const role of ['anon', 'authenticated']) t(`${role} cannot write projects directly`, await denied(() => asRole(role, `update public.projects set title='x'`)));
for (const [fn, a] of [['project_list', []], ['project_get', [P1]], ['project_delete', [P1]], ['project_save', [P1, 'proofread', 't', '{}', 'x', null]]]) t(`anon cannot call ${fn}()`, await denied(() => call(null, fn, a)));
for (const [fn, a] of [['project_list', []], ['project_get', [P1]], ['project_delete', [P1]], ['project_save', [P1, 'proofread', 't', '{}', 'x', null]]]) {
  const r = await call(STRANGER, fn, a); t(`a stranger (signed up, not approved) is denied by ${fn}()`, r.ok === false && r.error === 'denied', JSON.stringify(r));
}

// saving, listing, opening
let r = await save(BEN, P1);
t('a member can save a project', r.ok === true && r.id === P1, JSON.stringify(r));
r = await call(CARL, 'project_list');
t('everyone on the team sees it in the list', r.ok && r.projects.length === 1 && r.projects[0].title === 'Doc A' && r.projects[0].by === 'ben' && r.projects[0].mine === false, JSON.stringify(r));
t('the list never carries the heavy payload', !('payload' in r.projects[0]));
t('the list carries the summary and instructions', r.projects[0].summary.errors === 3 && r.projects[0].instructions === 'Use British English.');
r = await call(CARL, 'project_get', [P1]);
t('any member can open it, with the payload', r.ok && r.project.payload === 'H4sIAAAA' && r.project.kind === 'proofread', JSON.stringify(r).slice(0, 200));
r = await call(CARL, 'project_get', [P2]); t('unknown id -> not_found', r.ok === false && r.error === 'not_found');

// who may change or delete
r = await save(CARL, P1, 'proofread', 'Hijacked');
t('another member cannot overwrite it', r.ok === false && r.error === 'forbidden', JSON.stringify(r));
r = await save(BEN, P1, 'proofread', 'Doc A v2', 'NEWPAYLOAD', { errors: 5 });
t('the creator can update it', r.ok === true);
r = await call(ADMIN, 'project_get', [P1]); t('the update is stored', r.project.title === 'Doc A v2' && r.project.payload === 'NEWPAYLOAD' && r.project.summary.errors === 5);
t('updating keeps the original creator', r.project.by === 'ben');
r = await save(ADMIN, P1, 'proofread', 'Doc A (admin edit)'); t('an admin can update any project', r.ok === true);
r = await call(CARL, 'project_delete', [P1]); t('another member cannot delete it', r.ok === false && r.error === 'forbidden');
r = await call(BEN, 'project_delete', [P1]); t('the creator can delete it', r.ok === true);
r = await call(CARL, 'project_list'); t('it is gone from the list', r.projects.length === 0);
await save(CARL, P2, 'translation', 'Chapter check', 'T', { score: 91 });
r = await call(ADMIN, 'project_delete', [P2]); t('an admin can delete any project', r.ok === true);

// bad input
t('unknown kind is refused', (await save(BEN, P1, 'novel')).error === 'bad_request');
t('empty payload is refused', (await save(BEN, P1, 'proofread', 't', '')).error === 'bad_request');
t('missing id is refused', (await call(BEN, 'project_save', [null, 'proofread', 't', '{}', 'x', null])).error === 'bad_request');
t('oversize payload is refused', (await save(BEN, P1, 'proofread', 't', 'x'.repeat(8000001))).error === 'too_large');
r = await save(BEN, P1, 'proofread', 'T'.repeat(500), 'x', {}, 'I'.repeat(5000));
const got = await call(BEN, 'project_get', [P1]);
t('title and instructions are capped', got.project.title.length === 300 && got.project.instructions.length === 3000);

// deleting a login keeps the project readable (no foreign key to auth.users)
await db.query('delete from auth.users where id = $1', [BEN]);
r = await call(CARL, 'project_list'); t('a deleted colleague\'s project stays, with their name', r.projects.length === 1 && r.projects[0].by === 'ben', JSON.stringify(r).slice(0, 160));

console.log(`${fail ? 'FAILED' : 'OK'}: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
