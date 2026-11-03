-- ════════════════════════════════════════════════════════════════════════
--  Explorer AI Proofreader — team workspace
--  Run this ONCE in Supabase:  SQL Editor  →  New query  →  paste  →  Run
--  It is safe to run again (nothing is deleted or duplicated).
--
--  What it sets up
--   • Personal accounts: colleagues sign in with the usernames/passwords you
--     create in Supabase (Authentication → Users), and you approve each one in
--     the portal. An account that is not on the member list gets nothing, even
--     if someone manages to sign up.
--   • One shared list of reviews for the whole team, with shared "applied in
--     layout" progress.
--   • One shared API key for the team, handed only to signed-in colleagues.
--   • Review links for outside translators (no account needed).
--
--  How the protection works
--   • Reports are encrypted in the browser BEFORE they are uploaded, with the
--     review's own password. Anyone holding only the link sees a password box.
--   • The tables are locked: the public (anon) key cannot read or write them.
--     The only way in is through the functions at the bottom, and each team
--     function checks the signed-in account on EVERY call. Disable or delete a
--     user in Supabase and they are locked out immediately.
--   • Wrong review passwords are counted; after 8 failures a link locks for 15
--     minutes. Links expire automatically and can be withdrawn at any time.
-- ════════════════════════════════════════════════════════════════════════

-- ── Clean up pieces of earlier versions (passphrase-based) ───────────────
drop function if exists public.share_create(text, uuid, text, int, text, text, int);
drop function if exists public.share_create(uuid, text, int, text, text, int, text, text, int);   -- v5.3: now takes p_meta as well
drop function if exists public.share_list(text);
drop function if exists public.share_manage(text, uuid, text, int);
drop function if exists public.team_put(text, text);
drop function if exists public.team_get(text);
drop function if exists public.team_clear(text);
drop function if exists public._creator_ok(text);
drop table    if exists public.team_secrets;
drop table    if exists public.app_config;

-- ── Tables ───────────────────────────────────────────────────────────────
-- Who may manage the team API key and every review (the people you promote).
create table if not exists public.team_admins (
  user_id uuid primary key references auth.users(id) on delete cascade
);

-- Who is on the team. Having a Supabase account is NOT enough: the admin must add the person here
-- (from the portal), so a stranger who signs up with the public key still gets nothing.
create table if not exists public.team_members (
  user_id  uuid primary key references auth.users(id) on delete cascade,
  added_by text,
  added_at timestamptz not null default now()
);

-- The shared API key(s). Only signed-in team members can read it (via team_keys_get).
create table if not exists public.team_keys (
  id         text primary key default 'api',
  a          text,                                     -- Anthropic key
  o          text,                                     -- OpenAI key
  updated_by text,
  updated_at timestamptz not null default now()
);

create table if not exists public.review_shares (
  id              uuid primary key,
  salt            text not null,                       -- public; needed to derive the key
  kdf_iter        int  not null default 600000,
  verifier        text not null,                       -- sha256 of the password-derived proof
  payload         text not null,                       -- ENCRYPTED report
  decisions       text,                                -- ENCRYPTED reviewer decisions
  status          text not null default 'pending'
                  check (status in ('pending','in_progress','submitted','revoked')),
  version         int  not null default 0,
  failed_attempts int  not null default 0,
  locked_until    timestamptz,
  created_at      timestamptz not null default now(),
  expires_at      timestamptz not null,
  opened_at       timestamptz,
  submitted_at    timestamptz
);
-- Team-visible details (added in v4; safe on databases that already have the table)
alter table public.review_shares add column if not exists created_by      uuid;
alter table public.review_shares add column if not exists created_by_name text;
alter table public.review_shares add column if not exists title           text;
alter table public.review_shares add column if not exists password        text;   -- visible to team members only
alter table public.review_shares add column if not exists issue_count     int   not null default 0;
alter table public.review_shares add column if not exists applied         jsonb not null default '{}'::jsonb;
-- v5.3: what the Reviews list shows without opening anything (kind, languages, pages, counts by severity, project id).
-- Plain text, same trust level as the title: members and the Supabase owner can read it. The report itself stays encrypted.
alter table public.review_shares add column if not exists meta            jsonb not null default '{}'::jsonb;

-- Lock the tables completely. No policies on purpose = deny everything;
-- only the SECURITY DEFINER functions below can touch the data.
-- Shared projects: every finished proofread / translation check, visible to the whole team.
-- Only the creator or an admin can change or delete one. payload = gzip+base64 of the report JSON (no uploaded manuscript).
create table if not exists public.projects (
  id              uuid primary key default gen_random_uuid(),
  kind            text not null check (kind in ('proofread', 'translation')),
  title           text not null default '',
  created_by      uuid,
  created_by_name text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  summary         jsonb not null default '{}'::jsonb,
  instructions    text,
  size            int  not null default 0,
  payload         text not null
);
create index if not exists projects_updated_idx on public.projects (updated_at desc);
alter table public.projects enable row level security;
revoke all on table public.projects from anon, authenticated;

alter table public.team_admins   enable row level security;
alter table public.team_members  enable row level security;
alter table public.team_keys     enable row level security;
alter table public.review_shares enable row level security;
revoke all on table public.team_admins   from anon, authenticated;
revoke all on table public.team_members  from anon, authenticated;
revoke all on table public.team_keys     from anon, authenticated;
revoke all on table public.review_shares from anon, authenticated;

-- ── Internal helpers (not callable from outside) ─────────────────────────
create or replace function public._sha256(t text) returns text
language sql immutable set search_path = public as $$
  select encode(sha256(convert_to(t, 'UTF8')), 'hex')
$$;

-- The signed-in, active team member making this request (NULL = not allowed).
-- Must be on the member list (or an admin), and not disabled or deleted. Checked on every
-- call, so removing or disabling someone locks them out at once, even while their sign-in
-- token is technically still valid.
create or replace function public._member() returns uuid
language sql stable security definer set search_path = public as $$
  select u.id from auth.users u
   where u.id = auth.uid()
     and u.deleted_at is null
     and (u.banned_until is null or u.banned_until <= now())
     and (exists (select 1 from public.team_members m where m.user_id = u.id)
          or exists (select 1 from public.team_admins a where a.user_id = u.id))
$$;

create or replace function public._is_admin() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.team_admins a where a.user_id = public._member())
$$;

create or replace function public._name(uid uuid) returns text
language sql stable security definer set search_path = public as $$
  select coalesce(nullif(u.raw_user_meta_data->>'name', ''), nullif(split_part(u.email, '@', 1), ''), 'colleague')
    from auth.users u where u.id = uid
$$;

-- A review's list details must be a small JSON object (anything else is stored as empty).
create or replace function public._clean_meta(m jsonb) returns jsonb
language sql immutable set search_path = public as $$
  select case when m is not null and jsonb_typeof(m) = 'object' and length(m::text) <= 4000 then m else '{}'::jsonb end
$$;

-- Reviewer password check. Returns NULL when the proof is correct, otherwise
-- an error object. (It RETURNS errors instead of raising them so that failed
-- attempts are still counted.)
create or replace function public._share_check(p_id uuid, p_auth text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare r public.review_shares;
begin
  select * into r from public.review_shares where id = p_id for update;
  if not found or r.status = 'revoked' or r.expires_at < now() then
    return jsonb_build_object('ok', false, 'error', 'not_found');
  end if;
  if r.locked_until is not null and r.locked_until > now() then
    return jsonb_build_object('ok', false, 'error', 'locked', 'until', r.locked_until);
  end if;
  if public._sha256(coalesce(p_auth, '')) <> r.verifier then
    update public.review_shares
       set locked_until    = case when r.failed_attempts + 1 >= 8
                                  then now() + interval '15 minutes' else r.locked_until end,
           failed_attempts = case when r.failed_attempts + 1 >= 8
                                  then 0 else r.failed_attempts + 1 end
     where id = p_id;
    return jsonb_build_object('ok', false, 'error', 'bad_password',
                              'left', greatest(8 - (r.failed_attempts + 1), 0));
  end if;
  if r.failed_attempts <> 0 then
    update public.review_shares set failed_attempts = 0 where id = p_id;
  end if;
  return null;
end $$;

-- ── Reviewer functions (anyone with the link + password; no account) ─────

-- Step 1: fetch the (public) salt so the browser can derive the key.
create or replace function public.share_info(p_id uuid) returns jsonb
language sql security definer set search_path = public stable as $$
  select coalesce(
    (select jsonb_build_object('ok', true, 'salt', salt, 'iter', kdf_iter)
       from public.review_shares
      where id = p_id and status <> 'revoked' and expires_at > now()),
    jsonb_build_object('ok', false, 'error', 'not_found'))
$$;

-- Step 2: open the review (needs the password-derived proof).
create or replace function public.share_open(p_id uuid, p_auth text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare err jsonb; r public.review_shares;
begin
  err := public._share_check(p_id, p_auth);
  if err is not null then return err; end if;
  select * into r from public.review_shares where id = p_id;
  if r.opened_at is null then
    update public.review_shares set opened_at = now() where id = p_id;
  end if;
  return jsonb_build_object('ok', true, 'payload', r.payload, 'decisions', r.decisions,
                            'status', r.status, 'version', r.version,
                            'expires_at', r.expires_at, 'submitted_at', r.submitted_at);
end $$;

-- Save progress, or submit (p_submit = true).
-- p_expected is the version the browser last saw; a mismatch means someone
-- else saved in between, and the newest decisions are returned for merging.
create or replace function public.share_save(
  p_id uuid, p_auth text, p_decisions text, p_submit boolean, p_expected int
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare err jsonb; r public.review_shares; v int;
begin
  err := public._share_check(p_id, p_auth);
  if err is not null then return err; end if;
  select * into r from public.review_shares where id = p_id;
  if r.status = 'submitted' then
    return jsonb_build_object('ok', false, 'error', 'submitted');
  end if;
  if p_expected is distinct from r.version then
    return jsonb_build_object('ok', false, 'error', 'conflict',
                              'version', r.version, 'decisions', r.decisions);
  end if;
  if length(coalesce(p_decisions, '')) > 5000000 then
    return jsonb_build_object('ok', false, 'error', 'too_large');
  end if;
  update public.review_shares
     set decisions    = p_decisions,
         version      = r.version + 1,
         status       = case when p_submit then 'submitted' else 'in_progress' end,
         submitted_at = case when p_submit then now() else submitted_at end
   where id = p_id
   returning version into v;
  return jsonb_build_object('ok', true, 'version', v,
                            'status', case when p_submit then 'submitted' else 'in_progress' end);
end $$;

-- ── Team functions (signed-in colleagues only) ───────────────────────────

-- Who am I? Used at sign-in to confirm the account is part of the team.
create or replace function public.team_whoami() returns jsonb
language plpgsql security definer set search_path = public as $$
declare uid uuid := public._member(); em text;
begin
  if uid is null then return jsonb_build_object('ok', false, 'error', 'denied'); end if;
  select email into em from auth.users where id = uid;
  return jsonb_build_object('ok', true, 'id', uid, 'name', public._name(uid), 'email', em,
                            'admin', public._is_admin());
end $$;

-- Team members (admin only): list, add, remove, promote/demote.
create or replace function public.team_members_list() returns jsonb
language plpgsql security definer set search_path = public as $$
begin
  if public._member() is null then return jsonb_build_object('ok', false, 'error', 'denied'); end if;
  if not public._is_admin() then return jsonb_build_object('ok', false, 'error', 'forbidden'); end if;
  return jsonb_build_object('ok', true, 'members', coalesce((
    select jsonb_agg(jsonb_build_object(
             'id', u.id, 'email', u.email, 'name', public._name(u.id),
             'admin', exists (select 1 from public.team_admins a where a.user_id = u.id),
             'disabled', (u.banned_until is not null and u.banned_until > now()),
             'added_at', m.added_at, 'me', (u.id = auth.uid()))
           order by lower(u.email))
      from auth.users u
      left join public.team_members m on m.user_id = u.id
     where u.deleted_at is null
       and (m.user_id is not null or exists (select 1 from public.team_admins a where a.user_id = u.id))), '[]'::jsonb));
end $$;

create or replace function public.team_member_add(p_email text, p_admin boolean default false) returns jsonb
language plpgsql security definer set search_path = public as $$
declare uid uuid := public._member(); target uuid;
begin
  if uid is null then return jsonb_build_object('ok', false, 'error', 'denied'); end if;
  if not public._is_admin() then return jsonb_build_object('ok', false, 'error', 'forbidden'); end if;
  select id into target from auth.users where lower(email) = lower(btrim(coalesce(p_email, ''))) and deleted_at is null;
  if target is null then return jsonb_build_object('ok', false, 'error', 'no_account'); end if;
  insert into public.team_members(user_id, added_by) values (target, public._name(uid)) on conflict (user_id) do nothing;
  if coalesce(p_admin, false) then insert into public.team_admins(user_id) values (target) on conflict do nothing; end if;
  return jsonb_build_object('ok', true, 'id', target);
end $$;

create or replace function public.team_member_remove(p_user uuid) returns jsonb
language plpgsql security definer set search_path = public as $$
declare uid uuid := public._member();
begin
  if uid is null then return jsonb_build_object('ok', false, 'error', 'denied'); end if;
  if not public._is_admin() then return jsonb_build_object('ok', false, 'error', 'forbidden'); end if;
  if p_user = uid then return jsonb_build_object('ok', false, 'error', 'bad_request'); end if;   -- never lock yourself out
  delete from public.team_members where user_id = p_user;
  delete from public.team_admins  where user_id = p_user;
  return jsonb_build_object('ok', true);
end $$;

create or replace function public.team_member_admin(p_user uuid, p_admin boolean) returns jsonb
language plpgsql security definer set search_path = public as $$
declare uid uuid := public._member();
begin
  if uid is null then return jsonb_build_object('ok', false, 'error', 'denied'); end if;
  if not public._is_admin() then return jsonb_build_object('ok', false, 'error', 'forbidden'); end if;
  if not exists (select 1 from auth.users where id = p_user and deleted_at is null) then return jsonb_build_object('ok', false, 'error', 'not_found'); end if;
  if coalesce(p_admin, false) then
    insert into public.team_admins(user_id) values (p_user) on conflict do nothing;
  else
    if p_user = uid then return jsonb_build_object('ok', false, 'error', 'bad_request'); end if;   -- keep at least yourself as admin
    insert into public.team_members(user_id, added_by) values (p_user, public._name(uid)) on conflict (user_id) do nothing;   -- stays a member
    delete from public.team_admins where user_id = p_user;
  end if;
  return jsonb_build_object('ok', true);
end $$;

-- The shared API key: any team member can read it, only admins can change it.
create or replace function public.team_keys_get() returns jsonb
language plpgsql security definer set search_path = public as $$
declare k public.team_keys;
begin
  if public._member() is null then return jsonb_build_object('ok', false, 'error', 'denied'); end if;
  select * into k from public.team_keys where id = 'api';
  if not found or (k.a is null and k.o is null) then
    return jsonb_build_object('ok', true, 'keys', null);
  end if;
  return jsonb_build_object('ok', true, 'keys', jsonb_strip_nulls(jsonb_build_object('a', k.a, 'o', k.o)),
                            'updated_at', k.updated_at, 'updated_by', k.updated_by);
end $$;

create or replace function public.team_keys_put(p_a text, p_o text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare uid uuid := public._member(); v_a text := nullif(btrim(coalesce(p_a, '')), ''); v_o text := nullif(btrim(coalesce(p_o, '')), '');
begin
  if uid is null then return jsonb_build_object('ok', false, 'error', 'denied'); end if;
  if not public._is_admin() then return jsonb_build_object('ok', false, 'error', 'forbidden'); end if;
  if v_a is null and v_o is null then return jsonb_build_object('ok', false, 'error', 'bad_request'); end if;
  if length(coalesce(v_a, '')) > 500 or length(coalesce(v_o, '')) > 500 then
    return jsonb_build_object('ok', false, 'error', 'too_large');
  end if;
  insert into public.team_keys(id, a, o, updated_by, updated_at) values ('api', v_a, v_o, public._name(uid), now())
    on conflict (id) do update set a = excluded.a, o = excluded.o, updated_by = excluded.updated_by, updated_at = excluded.updated_at;
  return jsonb_build_object('ok', true);
end $$;

create or replace function public.team_keys_clear() returns jsonb
language plpgsql security definer set search_path = public as $$
begin
  if public._member() is null then return jsonb_build_object('ok', false, 'error', 'denied'); end if;
  if not public._is_admin() then return jsonb_build_object('ok', false, 'error', 'forbidden'); end if;
  delete from public.team_keys where id = 'api';
  return jsonb_build_object('ok', true);
end $$;

-- Publish a new encrypted review (any team member). p_meta = list details (see review_shares.meta).
create or replace function public.share_create(
  p_id uuid, p_salt text, p_iter int, p_auth text, p_payload text, p_days int,
  p_title text, p_password text, p_issues int, p_meta jsonb default null
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare uid uuid := public._member();
begin
  if uid is null then return jsonb_build_object('ok', false, 'error', 'denied'); end if;
  if length(coalesce(p_payload, '')) > 20000000 then
    return jsonb_build_object('ok', false, 'error', 'too_large');
  end if;
  if length(coalesce(p_password, '')) < 8 or length(p_password) > 300 then
    return jsonb_build_object('ok', false, 'error', 'bad_request');
  end if;
  insert into public.review_shares(id, salt, kdf_iter, verifier, payload, expires_at,
                                   created_by, created_by_name, title, password, issue_count, meta)
  values (p_id, p_salt, greatest(coalesce(p_iter, 600000), 100000), public._sha256(p_auth), p_payload,
          now() + make_interval(days => least(greatest(coalesce(p_days, 30), 1), 90)),
          uid, public._name(uid), left(coalesce(p_title, ''), 200), p_password, greatest(coalesce(p_issues, 0), 0),
          public._clean_meta(p_meta));
  return jsonb_build_object('ok', true, 'id', p_id);
exception when unique_violation then
  return jsonb_build_object('ok', false, 'error', 'exists');
end $$;

-- The team's shared list of reviews. Returns status, who shared it, layout progress and
-- the review password (so any colleague can open the answers). Never returns the report.
create or replace function public.share_list() returns jsonb
language plpgsql security definer set search_path = public as $$
declare uid uuid := public._member();
begin
  if uid is null then return jsonb_build_object('ok', false, 'error', 'denied'); end if;
  delete from public.review_shares where expires_at < now() - interval '14 days';
  return jsonb_build_object('ok', true, 'shares', coalesce((
    select jsonb_agg(jsonb_build_object(
             'id', id,
             'status', case when status <> 'revoked' and expires_at < now() then 'expired' else status end,
             'version', version, 'created_at', created_at, 'expires_at', expires_at,
             'opened_at', opened_at, 'submitted_at', submitted_at,
             'title', title, 'password', password, 'issues', issue_count,
             'by', created_by_name, 'mine', (created_by is not distinct from uid), 'applied', applied, 'meta', meta)
           order by created_at desc)
      from public.review_shares), '[]'::jsonb));
end $$;

-- revoke | restore | reopen | extend | delete. Allowed for the person who shared it, or an admin.
create or replace function public.share_manage(
  p_id uuid, p_action text, p_days int default 30
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare uid uuid := public._member(); r public.review_shares;
begin
  if uid is null then return jsonb_build_object('ok', false, 'error', 'denied'); end if;
  select * into r from public.review_shares where id = p_id;
  if not found then return jsonb_build_object('ok', false, 'error', 'not_found'); end if;
  if not (r.created_by is not distinct from uid or public._is_admin()) then
    return jsonb_build_object('ok', false, 'error', 'forbidden');
  end if;
  if    p_action = 'revoke' then
    update public.review_shares set status = 'revoked' where id = p_id;
  elsif p_action = 'restore' then      -- undo a withdrawal: same link, same password, back to where it was
    update public.review_shares
       set status = case when submitted_at is not null then 'submitted' when version > 0 then 'in_progress' else 'pending' end,
           expires_at = greatest(expires_at, now() + interval '7 days')
     where id = p_id and status = 'revoked';
  elsif p_action = 'reopen' then
    update public.review_shares
       set status = 'in_progress', submitted_at = null,
           expires_at = greatest(expires_at, now() + interval '7 days')
     where id = p_id and status = 'submitted';
  elsif p_action = 'extend' then
    update public.review_shares
       set expires_at = now() + make_interval(days => least(greatest(coalesce(p_days, 30), 1), 90))
     where id = p_id and status <> 'revoked';
  elsif p_action = 'delete' then
    delete from public.review_shares where id = p_id;
  else
    return jsonb_build_object('ok', false, 'error', 'bad_action');
  end if;
  return jsonb_build_object('ok', true);
end $$;

-- Tick / untick "applied in layout" for one issue. Shared with the whole team.
create or replace function public.share_applied(p_id uuid, p_issue text, p_done boolean) returns jsonb
language plpgsql security definer set search_path = public as $$
declare uid uuid := public._member(); res jsonb;
begin
  if uid is null then return jsonb_build_object('ok', false, 'error', 'denied'); end if;
  if length(coalesce(p_issue, '')) < 1 or length(p_issue) > 100 then
    return jsonb_build_object('ok', false, 'error', 'bad_request');
  end if;
  update public.review_shares
     set applied = case when p_done
                        then applied || jsonb_build_object(p_issue, jsonb_build_object('by', public._name(uid), 'at', now()))
                        else applied - p_issue end
   where id = p_id and status <> 'revoked'
   returning applied into res;
  if not found then return jsonb_build_object('ok', false, 'error', 'not_found'); end if;
  return jsonb_build_object('ok', true, 'applied', res);
end $$;

-- Open a review from the team side WITHOUT the reviewer's proof: the member already holds the password (share_list),
-- so this adds no access. It works for withdrawn and expired reviews too, never counts as "opened by the reviewer"
-- and never touches the reviewer's lock-out counter. Returns what the browser needs to decrypt with the stored password.
create or replace function public.share_view(p_id uuid) returns jsonb
language plpgsql security definer set search_path = public as $$
declare r public.review_shares;
begin
  if public._member() is null then return jsonb_build_object('ok', false, 'error', 'denied'); end if;
  select * into r from public.review_shares where id = p_id;
  if not found then return jsonb_build_object('ok', false, 'error', 'not_found'); end if;
  return jsonb_build_object('ok', true, 'salt', r.salt, 'iter', r.kdf_iter, 'payload', r.payload, 'decisions', r.decisions,
                            'status', case when r.status <> 'revoked' and r.expires_at < now() then 'expired' else r.status end,
                            'version', r.version, 'expires_at', r.expires_at, 'submitted_at', r.submitted_at);
end $$;

-- Fill in (or correct) the list details of a review. Any member may fill in details that are still empty (older reviews);
-- changing existing details needs the person who shared it, or an admin.
create or replace function public.share_meta(p_id uuid, p_meta jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare uid uuid := public._member(); r public.review_shares; m jsonb := public._clean_meta(p_meta);
begin
  if uid is null then return jsonb_build_object('ok', false, 'error', 'denied'); end if;
  if m = '{}'::jsonb then return jsonb_build_object('ok', false, 'error', 'bad_request'); end if;
  select * into r from public.review_shares where id = p_id;
  if not found then return jsonb_build_object('ok', false, 'error', 'not_found'); end if;
  if r.meta <> '{}'::jsonb and not (r.created_by is not distinct from uid or public._is_admin()) then
    return jsonb_build_object('ok', false, 'error', 'forbidden');
  end if;
  update public.review_shares set meta = m where id = p_id;
  return jsonb_build_object('ok', true);
end $$;

-- ── Shared projects (team members only) ──────────────────────────────────
create or replace function public.project_save(p_id uuid, p_kind text, p_title text, p_summary jsonb, p_payload text, p_instructions text default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare uid uuid := public._member(); r public.projects;
begin
  if uid is null then return jsonb_build_object('ok', false, 'error', 'denied'); end if;
  if p_kind is null or p_kind not in ('proofread', 'translation') or p_id is null or coalesce(p_payload, '') = '' then
    return jsonb_build_object('ok', false, 'error', 'bad_request');
  end if;
  if length(p_payload) > 8000000 then return jsonb_build_object('ok', false, 'error', 'too_large'); end if;
  select * into r from public.projects where id = p_id;
  if found then
    if not (r.created_by is not distinct from uid or public._is_admin()) then return jsonb_build_object('ok', false, 'error', 'forbidden'); end if;
    update public.projects set title = left(coalesce(p_title, ''), 300), summary = coalesce(p_summary, '{}'::jsonb), payload = p_payload,
           instructions = left(p_instructions, 3000), size = length(p_payload), updated_at = now() where id = p_id;
  else
    insert into public.projects(id, kind, title, created_by, created_by_name, summary, instructions, size, payload)
      values (p_id, p_kind, left(coalesce(p_title, ''), 300), uid, public._name(uid), coalesce(p_summary, '{}'::jsonb), left(p_instructions, 3000), length(p_payload), p_payload);
  end if;
  return jsonb_build_object('ok', true, 'id', p_id);
end $$;

create or replace function public.project_list() returns jsonb
language plpgsql security definer set search_path = public as $$
declare uid uuid := public._member();
begin
  if uid is null then return jsonb_build_object('ok', false, 'error', 'denied'); end if;
  return jsonb_build_object('ok', true, 'projects', coalesce((
    select jsonb_agg(jsonb_build_object('id', id, 'kind', kind, 'title', title, 'by', created_by_name, 'createdAt', created_at, 'updatedAt', updated_at,
                                        'summary', summary, 'instructions', instructions, 'size', size, 'mine', (created_by is not distinct from uid)) order by updated_at desc)
      from (select id, kind, title, created_by, created_by_name, created_at, updated_at, summary, instructions, size from public.projects order by updated_at desc limit 300) x), '[]'::jsonb));
end $$;

create or replace function public.project_get(p_id uuid) returns jsonb
language plpgsql security definer set search_path = public as $$
declare uid uuid := public._member(); r public.projects;
begin
  if uid is null then return jsonb_build_object('ok', false, 'error', 'denied'); end if;
  select * into r from public.projects where id = p_id;
  if not found then return jsonb_build_object('ok', false, 'error', 'not_found'); end if;
  return jsonb_build_object('ok', true, 'project', jsonb_build_object('id', r.id, 'kind', r.kind, 'title', r.title, 'by', r.created_by_name,
           'createdAt', r.created_at, 'updatedAt', r.updated_at, 'summary', r.summary, 'instructions', r.instructions, 'mine', (r.created_by is not distinct from uid), 'payload', r.payload));
end $$;

create or replace function public.project_delete(p_id uuid) returns jsonb
language plpgsql security definer set search_path = public as $$
declare uid uuid := public._member(); r public.projects;
begin
  if uid is null then return jsonb_build_object('ok', false, 'error', 'denied'); end if;
  select * into r from public.projects where id = p_id;
  if not found then return jsonb_build_object('ok', false, 'error', 'not_found'); end if;
  if not (r.created_by is not distinct from uid or public._is_admin()) then return jsonb_build_object('ok', false, 'error', 'forbidden'); end if;
  delete from public.projects where id = p_id;
  return jsonb_build_object('ok', true);
end $$;

-- ── Permissions: only the public functions are callable, nothing else ────
-- (Supabase pre-grants new functions to anon + authenticated, so those are revoked explicitly.)
revoke all on function public._sha256(text)                          from public, anon, authenticated;
revoke all on function public._member()                              from public, anon, authenticated;
revoke all on function public._is_admin()                            from public, anon, authenticated;
revoke all on function public._name(uuid)                            from public, anon, authenticated;
revoke all on function public._clean_meta(jsonb)                     from public, anon, authenticated;
revoke all on function public._share_check(uuid, text)               from public, anon, authenticated;

revoke all on function public.share_info(uuid)                       from public;
revoke all on function public.share_open(uuid, text)                 from public;
revoke all on function public.share_save(uuid, text, text, boolean, int) from public;
revoke all on function public.team_members_list()                    from public, anon, authenticated;
revoke all on function public.team_member_add(text, boolean)         from public, anon, authenticated;
revoke all on function public.team_member_remove(uuid)               from public, anon, authenticated;
revoke all on function public.team_member_admin(uuid, boolean)       from public, anon, authenticated;
revoke all on function public.team_whoami()                          from public, anon, authenticated;
revoke all on function public.team_keys_get()                        from public, anon, authenticated;
revoke all on function public.team_keys_put(text, text)              from public, anon, authenticated;
revoke all on function public.team_keys_clear()                      from public, anon, authenticated;
revoke all on function public.share_create(uuid, text, int, text, text, int, text, text, int, jsonb) from public, anon, authenticated;
revoke all on function public.share_list()                           from public, anon, authenticated;
revoke all on function public.share_manage(uuid, text, int)          from public, anon, authenticated;
revoke all on function public.share_applied(uuid, text, boolean)    from public, anon, authenticated;
revoke all on function public.share_view(uuid)                       from public, anon, authenticated;
revoke all on function public.share_meta(uuid, jsonb)                from public, anon, authenticated;
revoke all on function public.project_save(uuid, text, text, jsonb, text, text) from public, anon, authenticated;
revoke all on function public.project_list()                         from public, anon, authenticated;
revoke all on function public.project_get(uuid)                      from public, anon, authenticated;
revoke all on function public.project_delete(uuid)                   from public, anon, authenticated;

-- Reviewers (no account) may only use these three:
grant execute on function public.share_info(uuid)                    to anon, authenticated;
grant execute on function public.share_open(uuid, text)              to anon, authenticated;
grant execute on function public.share_save(uuid, text, text, boolean, int) to anon, authenticated;
-- Everything else needs a signed-in account:
grant execute on function public.team_members_list()                 to authenticated;
grant execute on function public.team_member_add(text, boolean)      to authenticated;
grant execute on function public.team_member_remove(uuid)            to authenticated;
grant execute on function public.team_member_admin(uuid, boolean)    to authenticated;
grant execute on function public.team_whoami()                       to authenticated;
grant execute on function public.team_keys_get()                     to authenticated;
grant execute on function public.team_keys_put(text, text)           to authenticated;
grant execute on function public.team_keys_clear()                   to authenticated;
grant execute on function public.share_create(uuid, text, int, text, text, int, text, text, int, jsonb) to authenticated;
grant execute on function public.share_list()                        to authenticated;
grant execute on function public.share_manage(uuid, text, int)       to authenticated;
grant execute on function public.share_applied(uuid, text, boolean)  to authenticated;
grant execute on function public.share_view(uuid)                    to authenticated;
grant execute on function public.share_meta(uuid, jsonb)             to authenticated;
grant execute on function public.project_save(uuid, text, text, jsonb, text, text) to authenticated;
grant execute on function public.project_list()                      to authenticated;
grant execute on function public.project_get(uuid)                   to authenticated;
grant execute on function public.project_delete(uuid)                to authenticated;
