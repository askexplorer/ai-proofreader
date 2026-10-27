-- ════════════════════════════════════════════════════════════════════════
--  Explorer AI Proofreader — secure review links
--  Run this ONCE in Supabase:  SQL Editor  →  New query  →  paste  →  Run
--  It is safe to run again (nothing is deleted or duplicated).
--
--  How the protection works
--   • Reports are encrypted in the browser BEFORE they are uploaded. This
--     database only ever stores scrambled text — it never sees the password.
--   • The tables below are locked: the public (anon) key cannot read or write
--     them directly. The only way in is through the functions at the bottom,
--     and each one checks a password-derived proof first.
--   • Wrong passwords are counted; after 8 failures a link locks for 15 minutes.
--   • Links expire automatically and can be revoked at any time.
-- ════════════════════════════════════════════════════════════════════════

-- ── Tables ───────────────────────────────────────────────────────────────
create table if not exists public.app_config (
  key   text primary key,
  value text not null
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

-- The team's shared API key. Encrypted in the browser with a key derived from
-- the creator passphrase, so this database only ever holds scrambled text.
create table if not exists public.team_secrets (
  name       text primary key,
  blob       text not null,                            -- ENCRYPTED
  updated_at timestamptz not null default now()
);

-- Lock the tables completely. No policies on purpose = deny everything;
-- only the SECURITY DEFINER functions below can touch the data.
alter table public.app_config    enable row level security;
alter table public.review_shares enable row level security;
alter table public.team_secrets  enable row level security;
revoke all on table public.app_config    from anon, authenticated;
revoke all on table public.review_shares from anon, authenticated;
revoke all on table public.team_secrets  from anon, authenticated;

-- ── Internal helpers (not callable from outside) ─────────────────────────
create or replace function public._sha256(t text) returns text
language sql immutable as $$
  select encode(sha256(convert_to(t, 'UTF8')), 'hex')
$$;

-- Is this the owner's creator passphrase?  (20 wrong tries → 10 minute lock)
create or replace function public._creator_ok(p_creator text) returns boolean
language plpgsql security definer set search_path = public as $$
declare h text; locked timestamptz; fails int;
begin
  select value into h from public.app_config where key = 'creator_hash';
  if h is null then return false; end if;
  select value::timestamptz into locked from public.app_config where key = 'creator_locked_until';
  if locked is not null and locked > now() then return false; end if;
  if public._sha256(coalesce(p_creator, '')) = h then
    delete from public.app_config where key in ('creator_fails', 'creator_locked_until');
    return true;
  end if;
  insert into public.app_config(key, value) values ('creator_fails', '1')
    on conflict (key) do update set value = ((public.app_config.value)::int + 1)::text
    returning value::int into fails;
  if fails >= 20 then
    insert into public.app_config(key, value)
      values ('creator_locked_until', (now() + interval '10 minutes')::text)
      on conflict (key) do update set value = excluded.value;
    delete from public.app_config where key = 'creator_fails';
  end if;
  return false;
end $$;

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

-- ── Functions the web pages call ─────────────────────────────────────────

-- Reviewer step 1: fetch the (public) salt so the browser can derive the key.
create or replace function public.share_info(p_id uuid) returns jsonb
language sql security definer set search_path = public stable as $$
  select coalesce(
    (select jsonb_build_object('ok', true, 'salt', salt, 'iter', kdf_iter)
       from public.review_shares
      where id = p_id and status <> 'revoked' and expires_at > now()),
    jsonb_build_object('ok', false, 'error', 'not_found'))
$$;

-- Reviewer step 2: open the review (needs the password-derived proof).
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

-- Reviewer: save progress, or submit (p_submit = true).
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

-- Owner: publish a new encrypted review.
create or replace function public.share_create(
  p_creator text, p_id uuid, p_salt text, p_iter int, p_auth text, p_payload text, p_days int
) returns jsonb
language plpgsql security definer set search_path = public as $$
begin
  if not public._creator_ok(p_creator) then
    return jsonb_build_object('ok', false, 'error', 'denied');
  end if;
  if length(coalesce(p_payload, '')) > 20000000 then
    return jsonb_build_object('ok', false, 'error', 'too_large');
  end if;
  insert into public.review_shares(id, salt, kdf_iter, verifier, payload, expires_at)
  values (p_id, p_salt, greatest(coalesce(p_iter, 600000), 100000), public._sha256(p_auth), p_payload,
          now() + make_interval(days => least(greatest(coalesce(p_days, 30), 1), 90)));
  return jsonb_build_object('ok', true, 'id', p_id);
exception when unique_violation then
  return jsonb_build_object('ok', false, 'error', 'exists');
end $$;

-- Owner: list all reviews and their status (no content is returned).
create or replace function public.share_list(p_creator text) returns jsonb
language plpgsql security definer set search_path = public as $$
begin
  if not public._creator_ok(p_creator) then
    return jsonb_build_object('ok', false, 'error', 'denied');
  end if;
  delete from public.review_shares where expires_at < now() - interval '14 days';
  return jsonb_build_object('ok', true, 'shares', coalesce((
    select jsonb_agg(jsonb_build_object(
             'id', id,
             'status', case when status <> 'revoked' and expires_at < now() then 'expired' else status end,
             'version', version, 'created_at', created_at, 'expires_at', expires_at,
             'opened_at', opened_at, 'submitted_at', submitted_at)
           order by created_at desc)
      from public.review_shares), '[]'::jsonb));
end $$;

-- Owner: revoke | reopen | extend | delete a review.
create or replace function public.share_manage(
  p_creator text, p_id uuid, p_action text, p_days int default 30
) returns jsonb
language plpgsql security definer set search_path = public as $$
begin
  if not public._creator_ok(p_creator) then
    return jsonb_build_object('ok', false, 'error', 'denied');
  end if;
  if    p_action = 'revoke' then
    update public.review_shares set status = 'revoked' where id = p_id;
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

-- Team: store / read / remove the shared (encrypted) API key.
-- p_creator is a token derived in the browser from the creator passphrase;
-- the passphrase itself never reaches this database.
create or replace function public.team_put(p_creator text, p_blob text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare t timestamptz;
begin
  if not public._creator_ok(p_creator) then
    return jsonb_build_object('ok', false, 'error', 'denied');
  end if;
  if length(coalesce(p_blob, '')) > 20000 then
    return jsonb_build_object('ok', false, 'error', 'too_large');
  end if;
  insert into public.team_secrets(name, blob, updated_at) values ('api_keys', p_blob, now())
    on conflict (name) do update set blob = excluded.blob, updated_at = excluded.updated_at
    returning updated_at into t;
  return jsonb_build_object('ok', true, 'updated_at', t);
end $$;

create or replace function public.team_get(p_creator text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare r public.team_secrets;
begin
  if not public._creator_ok(p_creator) then
    return jsonb_build_object('ok', false, 'error', 'denied');
  end if;
  select * into r from public.team_secrets where name = 'api_keys';
  if not found then return jsonb_build_object('ok', true, 'blob', null); end if;
  return jsonb_build_object('ok', true, 'blob', r.blob, 'updated_at', r.updated_at);
end $$;

create or replace function public.team_clear(p_creator text) returns jsonb
language plpgsql security definer set search_path = public as $$
begin
  if not public._creator_ok(p_creator) then
    return jsonb_build_object('ok', false, 'error', 'denied');
  end if;
  delete from public.team_secrets where name = 'api_keys';
  return jsonb_build_object('ok', true);
end $$;

-- ── Permissions: only the public functions are callable, nothing else ────
revoke all on function public._sha256(text)                        from public, anon, authenticated;
revoke all on function public._creator_ok(text)                    from public, anon, authenticated;
revoke all on function public._share_check(uuid, text)             from public, anon, authenticated;
revoke all on function public.share_info(uuid)                     from public;
revoke all on function public.share_open(uuid, text)               from public;
revoke all on function public.share_save(uuid, text, text, boolean, int) from public;
revoke all on function public.share_create(text, uuid, text, int, text, text, int) from public;
revoke all on function public.share_list(text)                     from public;
revoke all on function public.share_manage(text, uuid, text, int)  from public;

revoke all on function public.team_put(text, text)                 from public;
revoke all on function public.team_get(text)                       from public;
revoke all on function public.team_clear(text)                     from public;

grant execute on function public.team_put(text, text)              to anon, authenticated;
grant execute on function public.team_get(text)                    to anon, authenticated;
grant execute on function public.team_clear(text)                  to anon, authenticated;
grant execute on function public.share_info(uuid)                  to anon, authenticated;
grant execute on function public.share_open(uuid, text)            to anon, authenticated;
grant execute on function public.share_save(uuid, text, text, boolean, int) to anon, authenticated;
grant execute on function public.share_create(text, uuid, text, int, text, text, int) to anon, authenticated;
grant execute on function public.share_list(text)                  to anon, authenticated;
grant execute on function public.share_manage(text, uuid, text, int) to anon, authenticated;
