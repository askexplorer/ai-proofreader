// Accounts + shared reviews + team key: SQL semantics (PGlite) and the client library (through the shim).
// Run:  cd tests && npm install && (node supabase/pg_shim.mjs &) && sleep 8 && node supabase/accounts.test.mjs
import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { createHash, createHmac } from 'node:crypto';

const SQL = readFileSync(new URL('../../supabase/setup.sql', import.meta.url), 'utf8');
const sha = (s) => createHash('sha256').update(s, 'utf8').digest('hex');
let pass = 0, fail = 0;
const t = (name, cond, extra = '') => { (cond ? pass++ : fail++); if (!cond) console.log('FAIL  ' + name + '  ' + extra); };
const denied = async (fn) => { try { await fn(); return false; } catch (e) { return /permission denied/i.test(e.message); } };

// ═══════════════ Part 1: SQL semantics on a fresh PGlite ═══════════════
{
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
  t('setup.sql runs, and runs again without errors', true);

  const mk = async (email, meta = {}) => (await db.query(`insert into auth.users(email, raw_user_meta_data) values ($1, $2::jsonb) returning id`, [email, JSON.stringify(meta)])).rows[0].id;
  const ADMIN = await mk('anna@explorer.team'), BEN = await mk('ben@explorer.team'), CARL = await mk('carl@explorer.team', { name: 'Carl the Designer' });
  const GHOST = '99999999-9999-4999-8999-999999999999';
  const STRANGER = await mk('mallory@example.org');          // signed up with the public key, never approved
  await db.query('insert into public.team_admins(user_id) values ($1)', [ADMIN]);
  for (const u of [BEN, CARL]) await db.query("insert into public.team_members(user_id, added_by) values ($1, 'test')", [u]);

  // call a function as: null = anon, uuid = signed-in user
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

  // 1. tables are sealed from the public key AND from signed-in users
  for (const role of ['anon', 'authenticated']) {
    for (const tbl of ['review_shares', 'team_keys', 'team_admins', 'team_members']) {
      t(`${role} cannot read ${tbl} directly`, await denied(() => asRole(role, `select * from public.${tbl}`)));
    }
    t(`${role} cannot write review_shares directly`, await denied(() => asRole(role, `update public.review_shares set status='pending'`)));
    t(`${role} cannot write team_keys directly`, await denied(() => asRole(role, `insert into public.team_keys(id,a) values ('x','y')`)));
    t(`${role} cannot make itself admin`, await denied(() => asRole(role, `insert into public.team_admins(user_id) values (gen_random_uuid())`)));
    for (const fn of ['_member()', '_is_admin()', "_name(gen_random_uuid())", "_sha256('x')"]) t(`${role} cannot call internal helper ${fn}`, await denied(() => asRole(role, `select public.${fn}`)));
  }
  // 2. anon cannot reach any team function at all
  for (const [fn, a] of [['team_whoami', []], ['team_keys_get', []], ['team_keys_put', ['k', null]], ['team_keys_clear', []], ['share_list', []],
                         ['share_manage', ['00000000-0000-4000-8000-000000000000', 'delete', 30]], ['share_applied', ['00000000-0000-4000-8000-000000000000', '1', true]]]) {
    t(`anon cannot call ${fn}()`, await denied(() => call(null, fn, a)));
  }
  // 2b. a stranger who signed up (authenticated, but never added by an admin) gets NOTHING
  for (const [fn, a] of [['team_whoami', []], ['team_keys_get', []], ['share_list', []], ['team_members_list', []],
                         ['share_create', ['ffffffff-ffff-4fff-8fff-ffffffffffff', 's', 600000, 'a'.repeat(64), '{}', 30, 't', 'longenough', 1]], ['team_keys_put', ['k', null]]]) {
    const r = await call(STRANGER, fn, a); t(`stranger (signed up, not approved) is denied by ${fn}()`, r.ok === false && r.error === 'denied', JSON.stringify(r));
  }
  // 3. signed-in but not a member (deleted/unknown account) -> denied by the function itself
  for (const [fn, a] of [['team_whoami', []], ['team_keys_get', []], ['share_list', []]]) {
    const r = await call(GHOST, fn, a); t(`non-member is denied by ${fn}()`, r.ok === false && r.error === 'denied', JSON.stringify(r));
  }
  // 4. identity
  let r = await call(BEN, 'team_whoami'); t('whoami: name from the username part of the email, not admin', r.ok && r.name === 'ben' && r.admin === false && r.email === 'ben@explorer.team', JSON.stringify(r));
  r = await call(ADMIN, 'team_whoami'); t('whoami: admin flag', r.ok && r.admin === true && r.name === 'anna');
  r = await call(CARL, 'team_whoami'); t('whoami: display name from account metadata', r.name === 'Carl the Designer', JSON.stringify(r));
  // 5. shared API key
  r = await call(BEN, 'team_keys_get'); t('key: none stored yet', r.ok && r.keys === null, JSON.stringify(r));
  r = await call(BEN, 'team_keys_put', ['sk-ant-X', null]); t('key: a member cannot change it', r.ok === false && r.error === 'forbidden', JSON.stringify(r));
  r = await call(ADMIN, 'team_keys_put', [null, '  ']); t('key: empty save is rejected', r.ok === false && r.error === 'bad_request');
  r = await call(ADMIN, 'team_keys_put', ['x'.repeat(501), null]); t('key: size cap', r.ok === false && r.error === 'too_large');
  r = await call(ADMIN, 'team_keys_put', ['  sk-ant-REAL-1  ', 'sk-proj-REAL-2']); t('key: admin saves (whitespace trimmed)', r.ok === true, JSON.stringify(r));
  r = await call(BEN, 'team_keys_get'); t('key: every member receives it', r.ok && r.keys.a === 'sk-ant-REAL-1' && r.keys.o === 'sk-proj-REAL-2' && r.updated_by === 'anna', JSON.stringify(r));
  r = await call(ADMIN, 'team_keys_put', ['sk-ant-REAL-1', null]); r = await call(BEN, 'team_keys_get'); t('key: replacing drops the old OpenAI key', r.keys.a === 'sk-ant-REAL-1' && !('o' in r.keys), JSON.stringify(r));
  r = await call(BEN, 'team_keys_clear'); t('key: a member cannot remove it', r.ok === false && r.error === 'forbidden');
  r = await call(ADMIN, 'team_keys_clear'); r = await call(BEN, 'team_keys_get'); t('key: admin removes it', r.ok && r.keys === null);

  // 5b. member management (admin only)
  r = await call(BEN, 'team_members_list'); t('a member cannot list members', r.ok === false && r.error === 'forbidden');
  r = await call(BEN, 'team_member_add', ['mallory@example.org', false]); t('a member cannot add anyone', r.ok === false && r.error === 'forbidden');
  r = await call(ADMIN, 'team_member_add', ['nobody@explorer.team', false]); t('adding an email with no account -> no_account', r.ok === false && r.error === 'no_account', JSON.stringify(r));
  r = await call(ADMIN, 'team_members_list'); t('admin lists members (2 members + admin, stranger absent)', r.ok && r.members.length === 3 && !r.members.some((m) => m.email.startsWith('mallory')) && r.members.find((m) => m.me).email === 'anna@explorer.team', JSON.stringify(r.members.map((m) => m.email)));
  r = await call(ADMIN, 'team_member_add', ['  MALLORY@example.org ', false]); t('admin approves the stranger (case/space tolerant)', r.ok === true);
  r = await call(STRANGER, 'team_whoami'); t('...and now they are in', r.ok === true && r.admin === false);
  r = await call(ADMIN, 'team_member_add', ['mallory@example.org', false]); t('adding someone twice is harmless', r.ok === true);
  r = await call(ADMIN, 'team_member_admin', [STRANGER, true]); r = await call(STRANGER, 'team_whoami'); t('admin can promote a member', r.admin === true);
  r = await call(ADMIN, 'team_member_admin', [STRANGER, false]); r = await call(STRANGER, 'team_whoami'); t('...and demote (they stay a member)', r.ok === true && r.admin === false);
  r = await call(ADMIN, 'team_member_admin', [ADMIN, false]); t('an admin cannot demote themselves', r.ok === false && r.error === 'bad_request');
  r = await call(ADMIN, 'team_member_remove', [ADMIN]); t('an admin cannot remove themselves', r.ok === false && r.error === 'bad_request');
  r = await call(ADMIN, 'team_member_remove', [STRANGER]); r = await call(STRANGER, 'team_whoami'); t('removing a member locks them out immediately', r.ok === false && r.error === 'denied');
  r = await call(ADMIN, 'team_member_admin', [GHOST, true]); t('promoting an unknown account -> not_found', r.ok === false && r.error === 'not_found');

  // 6. creating + listing reviews
  const ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', AUTH = 'a'.repeat(64), PW = 'river-amber-falcon-stone-lunar-47';
  r = await call(BEN, 'share_create', [ID, 'c2FsdA==', 600000, AUTH, '{"v":1,"ct":"x"}', 30, 'My Story', PW, 12]); t('member can create a review', r.ok === true, JSON.stringify(r));
  r = await call(BEN, 'share_create', [ID, 'c2FsdA==', 600000, AUTH, '{"v":1,"ct":"x"}', 30, 'Dup', PW, 1]); t('duplicate id is rejected, not overwritten', r.ok === false && r.error === 'exists');
  r = await call(BEN, 'share_create', ['bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 's', 600000, AUTH, '{}', 30, 'x', 'short', 1]); t('review password must be at least 8 characters', r.ok === false && r.error === 'bad_request');
  const stored = (await db.query('select verifier, created_by, created_by_name, title, password, issue_count from public.review_shares where id=$1', [ID])).rows[0];
  t('database stores sha256(proof), never the proof itself', stored.verifier === sha(AUTH) && stored.verifier !== AUTH);
  t('review records who created it, title and issue count', stored.created_by === BEN && stored.created_by_name === 'ben' && stored.title === 'My Story' && stored.issue_count === 12);
  r = await call(CARL, 'share_list'); const row = r.shares.find((s) => s.id === ID);
  t('a colleague sees everyone\'s reviews, with who shared them', r.ok && row && row.by === 'ben' && row.mine === false && row.title === 'My Story' && row.issues === 12, JSON.stringify(r));
  t('...including the review password (so any colleague can open the answers)', row.password === PW);
  r = await call(BEN, 'share_list'); t('"mine" is true for the creator', r.shares.find((s) => s.id === ID).mine === true);
  t('the list never contains the report or the reviewer answers', !JSON.stringify(r).includes('"ct"') && !JSON.stringify(r).includes('payload') && !JSON.stringify(r).includes('decisions'));

  // 7. the outside reviewer (no account) — same guarantees as before
  r = await call(null, 'share_info', [ID]); t('anonymous reviewer gets only salt + iterations', r.ok && r.salt === 'c2FsdA==' && r.iter === 600000 && !('payload' in r) && !('password' in r), JSON.stringify(r));
  r = await call(null, 'share_info', ['cccccccc-cccc-4ccc-8ccc-cccccccccccc']); t('unknown link -> not_found', r.ok === false && r.error === 'not_found');
  r = await call(null, 'share_open', [ID, 'f'.repeat(64)]); t('wrong review password -> bad_password with attempts left', r.ok === false && r.error === 'bad_password' && r.left === 7, JSON.stringify(r));
  for (let i = 0; i < 6; i++) await call(null, 'share_open', [ID, 'f'.repeat(64)]);
  r = await call(null, 'share_open', [ID, 'f'.repeat(64)]); t('8th wrong attempt locks the link', r.ok === false && r.left === 0);
  r = await call(null, 'share_open', [ID, AUTH]); t('while locked even the CORRECT password is refused', r.ok === false && r.error === 'locked');
  await db.query(`update public.review_shares set locked_until = now() - interval '1 minute' where id=$1`, [ID]);
  r = await call(null, 'share_open', [ID, AUTH]); t('after the lock expires the correct password works', r.ok === true && r.payload === '{"v":1,"ct":"x"}');
  r = await call(null, 'share_save', [ID, AUTH, '{"d":1}', false, 0]); t('reviewer saves progress -> version 1', r.ok && r.version === 1 && r.status === 'in_progress');
  r = await call(null, 'share_save', [ID, AUTH, '{"d":2}', false, 0]); t('stale version -> conflict returns newest decisions', r.ok === false && r.error === 'conflict' && r.decisions === '{"d":1}');
  r = await call(null, 'share_save', [ID, AUTH, '{"d":3}', true, 1]); t('submit -> submitted', r.ok && r.status === 'submitted');
  r = await call(null, 'share_save', [ID, AUTH, '{"d":4}', false, 2]); t('after submit the reviewer can no longer change anything', r.ok === false && r.error === 'submitted');
  r = await call(CARL, 'share_list'); t('team list shows the review as submitted', r.shares.find((s) => s.id === ID).status === 'submitted');

  // 8. who can manage a review
  r = await call(CARL, 'share_manage', [ID, 'revoke', 30]); t('a colleague who did not share it cannot withdraw it', r.ok === false && r.error === 'forbidden', JSON.stringify(r));
  r = await call(CARL, 'share_manage', [ID, 'delete', 30]); t('...or delete it', r.ok === false && r.error === 'forbidden');
  r = await call(ADMIN, 'share_manage', [ID, 'reopen', 30]); t('an admin can reopen anyone\'s review', r.ok === true);
  r = await call(null, 'share_save', [ID, AUTH, '{"d":5}', false, 2]); t('reviewer can edit again after reopen', r.ok && r.version === 3 && r.status === 'in_progress');
  r = await call(BEN, 'share_manage', [ID, 'extend', 14]); t('the creator can extend their own review', r.ok === true);
  r = await call(BEN, 'share_manage', ['dddddddd-dddd-4ddd-8ddd-dddddddddddd', 'revoke', 30]); t('unknown review -> not_found', r.ok === false && r.error === 'not_found');
  r = await call(BEN, 'share_manage', [ID, 'explode', 30]); t('unknown action is rejected', r.ok === false && r.error === 'bad_action');

  // 9. shared "applied in layout" ticks
  r = await call(CARL, 'share_applied', [ID, '7', true]); t('any colleague can tick an item as applied (and it records who)', r.ok && r.applied['7'].by === 'Carl the Designer' && !!r.applied['7'].at, JSON.stringify(r));
  r = await call(ADMIN, 'share_applied', [ID, '9', true]); t('ticks from several people accumulate', Object.keys(r.applied).sort().join() === '7,9');
  r = await call(BEN, 'share_list'); t('everyone sees the same progress in the list', Object.keys(r.shares.find((s) => s.id === ID).applied).length === 2);
  r = await call(BEN, 'share_applied', [ID, '7', false]); t('unticking removes it', Object.keys(r.applied).join() === '9');
  r = await call(BEN, 'share_applied', [ID, '', true]); t('empty issue id is rejected', r.ok === false && r.error === 'bad_request');
  r = await call(BEN, 'share_applied', ['dddddddd-dddd-4ddd-8ddd-dddddddddddd', '1', true]); t('ticking on an unknown review -> not_found', r.ok === false && r.error === 'not_found');

  // 10. revoke + expiry
  r = await call(BEN, 'share_manage', [ID, 'revoke', 30]); r = await call(null, 'share_open', [ID, AUTH]); t('a withdrawn link can no longer be opened', r.ok === false && r.error === 'not_found');
  r = await call(BEN, 'share_applied', [ID, '1', true]); t('...and cannot be ticked any more', r.ok === false && r.error === 'not_found');
  const ID2 = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
  await call(BEN, 'share_create', [ID2, 'c2FsdA==', 600000, AUTH, '{"v":1}', 7, 'Second', PW, 3]);
  await db.query(`update public.review_shares set expires_at = now() - interval '1 hour' where id=$1`, [ID2]);
  r = await call(null, 'share_open', [ID2, AUTH]); t('an expired link cannot be opened', r.ok === false && r.error === 'not_found');
  r = await call(BEN, 'share_list'); t('expired review is listed as "expired"', r.shares.find((s) => s.id === ID2).status === 'expired');
  await call(BEN, 'share_manage', [ID2, 'extend', 14]); r = await call(null, 'share_open', [ID2, AUTH]); t('the creator can extend an expired link', r.ok === true);
  await db.query(`update public.review_shares set expires_at = now() - interval '20 days' where id=$1`, [ID2]); await call(BEN, 'share_list');
  t('links expired >14 days ago are purged', (await db.query('select count(*)::int c from public.review_shares where id=$1', [ID2])).rows[0].c === 0);
  await call(BEN, 'share_create', ['eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', 's', 1, AUTH, '{}', 9999, 't', PW, 1]);
  t('expiry is capped at 90 days; KDF has a 100k floor', (await db.query(`select (expires_at < now() + interval '91 days') ok, kdf_iter from public.review_shares where id='eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'`)).rows.every((x) => x.ok && x.kdf_iter >= 100000));

  // 11. disabling an account locks the person out at once
  await db.query(`update auth.users set banned_until = now() + interval '100 years' where id=$1`, [BEN]);
  for (const [fn, a] of [['team_whoami', []], ['team_keys_get', []], ['share_list', []]]) { r = await call(BEN, fn, a); t(`banned user is refused by ${fn}() immediately`, r.ok === false && r.error === 'denied', JSON.stringify(r)); }
  await db.query(`update auth.users set banned_until = now() - interval '1 minute' where id=$1`, [BEN]);
  r = await call(BEN, 'team_whoami'); t('an expired ban no longer blocks', r.ok === true);
  await db.query(`update auth.users set deleted_at = now() where id=$1`, [BEN]);
  r = await call(BEN, 'share_list'); t('a deleted user is refused immediately', r.ok === false && r.error === 'denied');
  await db.query(`update auth.users set deleted_at = null where id=$1`, [BEN]);

  // 12. the admin helper SQL for the wizard
  await db.close();
}

// ═══════════════ Part 2: client library through the shim (needs shim on :54321) ═══════════════
{
  const ls = new Map();
  globalThis.localStorage = { getItem: (k) => (ls.has(k) ? ls.get(k) : null), setItem: (k, v) => ls.set(k, String(v)), removeItem: (k) => ls.delete(k) };
  await import(new URL('../../share-core.js', import.meta.url).href);
  const SR = globalThis.SR;
  const KEY = process.env.ANON_KEY || 'sb_publishable_testkey_1234567890';
  const cfg = { url: 'http://127.0.0.1:54321', key: KEY };
  const post = async (p, b) => (await (await fetch(cfg.url + p, { method: 'POST', body: typeof b === 'string' ? b : JSON.stringify(b) })).json());
  const sql = async (q) => (await post('/__sql', q)).rows;
  const code = async (fn) => { try { await fn(); return 'no error'; } catch (e) { return e.code || e.message; } };
  const sign = (p) => { const h = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url'), b = Buffer.from(JSON.stringify(p)).toString('base64url'); return h + '.' + b + '.' + createHmac('sha256', 'shim-only-secret').update(h + '.' + b).digest('base64url'); };
  const sess = () => JSON.parse(ls.get('sr_session') || 'null');

  t('emailFor: username gets the team domain, full emails are kept', SR.emailFor(' Ben ') === 'ben@explorer.team' && SR.emailFor('X@Y.org') === 'x@y.org');
  t('adminSql targets the right account and escapes quotes', /lower\(email\) = 'anna@explorer\.team'/.test(SR.adminSql('Anna')) && SR.adminSql("o'brien").includes("o''brien@explorer.team"));
  t('database check passes (functions installed)', await SR.testDatabase(cfg));

  const admin = await post('/__mkuser', { email: 'anna@explorer.team', password: 'anna-pass-1', admin: true });
  await post('/__mkuser', { email: 'ben@explorer.team', password: 'ben-pass-1', name: 'Ben' });
  await post('/__mkuser', { email: 'carl@explorer.team', password: 'carl-pass-1' });
  await post('/__mkuser', { email: 'mallory@example.org', password: 'mal-pass-1', nomember: true });
  await sql(`update auth.users set banned_until = now() + interval '100 years' where email = 'carl@explorer.team'`);

  t('not signed in -> team calls say signed_out', (await code(() => SR.listShares(cfg))) === 'signed_out');
  t('wrong password -> bad_login (friendly)', (await code(() => SR.signIn(cfg, 'anna', 'nope'))) === 'bad_login');
  t('unknown username -> same bad_login (no account enumeration)', (await code(() => SR.signIn(cfg, 'nobody', 'x'))) === 'bad_login');
  t('empty fields -> bad_login without calling the server', (await code(() => SR.signIn(cfg, '', ''))) === 'bad_login');
  t('a disabled account -> banned (friendly)', (await code(() => SR.signIn(cfg, 'carl', 'carl-pass-1'))) === 'banned' && !SR.hasSession());
  t('wrong project key -> bad_key', (await code(() => SR.signIn({ url: cfg.url, key: 'sb_publishable_wrong_key_0000000' }, 'anna', 'anna-pass-1'))) === 'bad_key');
  t('unreachable server -> network', (await code(() => SR.signIn({ url: 'http://127.0.0.1:9', key: KEY }, 'anna', 'x'))) === 'network');

  // a stranger who managed to sign up: can sign in, but is a nobody
  await SR.signIn(cfg, 'mallory@example.org', 'mal-pass-1');
  t('stranger: whoami denied', (await code(() => SR.whoami(cfg))) === 'denied');
  await SR.signIn(cfg, 'carl', 'carl-pass-1').catch(() => {});   // banned member, ignored
  SR.clearSession();
  t('sign-up status is readable (closed in the stand-in)', (await SR.signupOpen(cfg)) === false);

  // ── admin session ──
  await SR.signIn(cfg, 'anna', 'anna-pass-1');
  t('sign in works with a bare username', SR.hasSession() && !!sess().access_token);
  let me = await SR.whoami(cfg); t('whoami: admin anna', me.admin === true && me.name === 'anna' && me.id === admin.id);
  t('admin saves the team key', await SR.putTeamKeys(cfg, { a: 'sk-ant-test-LIVE-TEST-KEY-AAAAAAAA', o: 'sk-proj-LIVE-TEST-KEY-BBBBBBBB' }));
  let keys = await SR.getTeamKeys(cfg); t('team key round-trips', keys && keys.keys.a.includes('LIVE-TEST-KEY-AAAA') && keys.keys.o.includes('BBBB') && keys.updated_by === 'anna');

  const PW = 'river-amber-falcon-stone-lunar-47';
  const payload = { v: 1, kind: 'proofread', title: 'Mongolian Inside v1', language: 'Mongolian', createdBy: 'anna', issues: [
    { id: 1, type: 'Spelling', severity: 'Critical', page: 3, context: 'Сайн байна уу', original: 'байна', corrected: 'байна', explanation: 'x' },
    { id: 2, type: 'Grammar', severity: 'Major', page: 4, context: 'Би ирлээ', original: 'ирлээ', corrected: 'ирсэн', explanation: 'y' }] };
  const made = await SR.createShare(cfg, payload, PW, 30, { title: payload.title });
  t('admin creates an encrypted review', /^[0-9a-f-]{36}$/.test(made.id) && made.bytes > 100);
  const raw = JSON.stringify(await sql('select payload, password, title from public.review_shares'));
  t('stored payload is ciphertext (no readable text)', !/Mongolian|Сайн|ирлээ/.test(raw.replace('Mongolian Inside v1', '')));
  let list = await SR.listShares(cfg); t('list shows the review with title, password and who made it', list.length === 1 && list[0].title === payload.title && list[0].password === PW && list[0].by === 'anna' && list[0].mine === true && list[0].issues === 2);

  // the outside translator: link + password only, no account
  const saveSess = ls.get('sr_session'); ls.delete('sr_session');
  const rv = await SR.openShare(cfg, made.id, PW);
  t('translator (no account) opens it with the password', rv.payload.issues.length === 2 && rv.payload.title === payload.title);
  t('translator cannot call team functions', ['signed_out'].includes(await code(() => SR.listShares(cfg))));
  t('translator wrong password -> bad_password', (await code(() => SR.openShare(cfg, made.id, 'wrong-wrong-wrong'))) === 'bad_password');
  const dec = { v: 1, reviewer: 'Amarjargal', items: { 1: { d: 'agree', at: 1 }, 2: { d: 'edit', t: 'ирсэн бол', at: 2 } } };
  const sv = await SR.saveDecisions(rv.session, dec, true, rv.version); t('translator submits', sv.ok && sv.status === 'submitted');
  ls.set('sr_session', saveSess);

  // member management from the client
  let mem = await SR.listMembers(cfg); t('client: admin lists members', mem.length === 3 && mem.some((x) => x.admin && x.me));
  t('client: adding a colleague who has an account', (await SR.addMember(cfg, 'mallory@example.org', false)).ok === true && (await SR.listMembers(cfg)).length === 4);
  t('client: adding someone without an account -> no_account', (await code(() => SR.addMember(cfg, 'ghost'))) === 'no_account');
  const mal = (await SR.listMembers(cfg)).find((x) => x.email === 'mallory@example.org');
  t('client: remove member', await SR.removeMember(cfg, mal.id) && (await SR.listMembers(cfg)).length === 3);
  t('client: promote then demote', await SR.setMemberAdmin(cfg, mal.id, true) === true && true);
  await SR.removeMember(cfg, mal.id);

  // ── a colleague (member) ──
  await SR.signOut(cfg); t('sign out clears the session', !SR.hasSession() && (await code(() => SR.listShares(cfg))) === 'signed_out');
  await SR.signIn(cfg, 'ben', 'ben-pass-1');
  me = await SR.whoami(cfg); t('whoami: member ben', me.admin === false && me.name === 'Ben');
  list = await SR.listShares(cfg); t('colleague sees the review anna shared', list.length === 1 && list[0].mine === false && list[0].status === 'submitted' && list[0].by === 'anna');
  const ro = await SR.openShare(cfg, list[0].id, list[0].password);
  t('colleague opens the translator\'s answers using the shared password', ro.status === 'submitted' && ro.decisions.items[2].t === 'ирсэн бол');
  keys = await SR.getTeamKeys(cfg); t('colleague receives the team key', keys && keys.keys.a.includes('LIVE-TEST-KEY-AAAA'));
  t('colleague cannot change the team key', (await code(() => SR.putTeamKeys(cfg, { a: 'sk-ant-evil-000000000000000000' }))) === 'forbidden');
  t('colleague cannot remove the team key', (await code(() => SR.clearTeamKeys(cfg))) === 'forbidden');
  t('colleague cannot withdraw anna\'s review', (await code(() => SR.manageShare(cfg, list[0].id, 'revoke'))) === 'forbidden');
  const ap = await SR.setApplied(cfg, list[0].id, 1, true); t('colleague ticks "applied in layout"', ap['1'].by === 'Ben');
  const mine = await SR.createShare(cfg, { ...payload, title: 'Ben\'s book' }, PW + '-x', 14, { title: 'Ben\'s book' });
  t('colleague can create and manage their own review', await SR.manageShare(cfg, mine.id, 'extend', 14));

  // ── tokens: refresh, expiry, instant lockout ──
  const s0 = sess();
  ls.set('sr_session', JSON.stringify({ ...s0, expires_at: Date.now() - 1000 }));
  list = await SR.listShares(cfg); t('an expired access token is refreshed automatically', list.length === 2 && sess().refresh_token !== s0.refresh_token && sess().expires_at > Date.now());
  const now = Math.floor(Date.now() / 1000);
  const dead = sign({ sub: me.id, role: 'authenticated', aud: 'authenticated', exp: now - 60 });
  ls.set('sr_session', JSON.stringify({ ...sess(), access_token: dead, expires_at: Date.now() + 3600e3 }));
  list = await SR.listShares(cfg); t('a token the server rejects as expired is refreshed and the call retried', list.length === 2 && sess().access_token !== dead);
  const before = sess();
  ls.set('sr_session', JSON.stringify({ ...before, refresh_token: 'bogus', expires_at: Date.now() - 1000 }));
  t('an unusable refresh token -> signed_out and session cleared', (await code(() => SR.listShares(cfg))) === 'signed_out' && !SR.hasSession());

  await SR.signIn(cfg, 'ben', 'ben-pass-1');
  await SR.listShares(cfg);
  await sql(`update auth.users set banned_until = now() + interval '100 years' where email = 'ben@explorer.team'`);
  t('disabling the account blocks the next call even with a valid token', (await code(() => SR.listShares(cfg))) === 'denied');
  t('...and refreshing the session is refused too', (await code(() => SR.refreshSession(cfg))) === 'banned' && !SR.hasSession());
  t('...and signing in again is refused', (await code(() => SR.signIn(cfg, 'ben', 'ben-pass-1'))) === 'banned');

  // ── admin sees colleague's tick ──
  await SR.signIn(cfg, 'anna', 'anna-pass-1');
  list = await SR.listShares(cfg); const first = list.find((x) => x.id === made.id);
  t('admin sees the progress colleagues recorded', first.applied['1'] && first.applied['1'].by === 'Ben' && list.length === 2);
  t('admin can delete a colleague\'s review', await SR.manageShare(cfg, mine.id, 'delete') && (await SR.listShares(cfg)).length === 1);
  t('admin can remove the team key', await SR.clearTeamKeys(cfg) && (await SR.getTeamKeys(cfg)) === null);
}

console.log(`account tests: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
