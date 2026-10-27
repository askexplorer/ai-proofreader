/*  Explorer AI Proofreader — secure review core
 *  Used by index.html (creator) and share.html (reviewer).
 *
 *  Everything sensitive happens in the browser with WebCrypto:
 *    password  --PBKDF2-SHA256 (600k rounds)-->  64 bytes
 *               first 32  = AES-GCM key   (encrypts the report + the decisions)
 *               last  32  = "proof"       (sent to the server instead of the password)
 *  The server stores only ciphertext and sha256(proof). It never sees the
 *  password, the key, or any readable text.
 *
 *  Colleagues sign in with Supabase Auth (username + password, accounts created by
 *  the admin). Team calls carry their access token; the database checks the account
 *  on every call. Outside reviewers need no account: link + review password only.
 */
(function (global) {
  'use strict';

  const enc = new TextEncoder();
  const dec = new TextDecoder();
  const KDF_ITER = 600000;

  // ── small helpers ──────────────────────────────────────────────────────
  const b64e = (buf) => {
    const a = new Uint8Array(buf); let s = '';
    for (let i = 0; i < a.length; i += 0x8000) s += String.fromCharCode.apply(null, a.subarray(i, i + 0x8000));
    return btoa(s);
  };
  const b64d = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
  const hex = (buf) => Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, '0')).join('');
  const b64url = (s) => btoa(unescape(encodeURIComponent(s))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const unb64url = (s) => decodeURIComponent(escape(atob(s.replace(/-/g, '+').replace(/_/g, '/'))));
  const sha256hex = async (s) => hex(await crypto.subtle.digest('SHA-256', enc.encode(s)));

  function isSupported() {
    return !!(global.crypto && global.crypto.subtle && global.isSecureContext !== false);
  }

  // ── errors with friendly text ──────────────────────────────────────────
  class SRError extends Error {
    constructor(code, detail) { super(detail || code); this.code = code; }
  }
  const FRIENDLY = {
    not_configured: 'Review sharing is not set up yet. Open Setup and follow the 4 steps.',
    network:        'Could not reach the server. Check your internet connection and try again.',
    setup_missing:  'The database is not ready. Run the setup SQL in your Supabase project (Setup, step 3).',
    bad_key:        'The Supabase URL or key is wrong. Re-copy them from Supabase, Project Settings, API.',
    denied:         'Your account is not part of the team workspace, or has been disabled. Ask the admin.',
    forbidden:      'Only the person who shared this, or an admin, can do that.',
    bad_login:      'Wrong username or password.',
    banned:         'This account has been disabled. Ask the admin.',
    not_confirmed:  'This account is not confirmed yet. The admin must create it with "Auto Confirm User" ticked.',
    rate:           'Too many attempts. Wait a few minutes and try again.',
    signed_out:     'Your session has ended. Please sign in again.',
    bad_request:    'That request was not valid.',
    no_account:     'No account with that username exists yet. Create it in Supabase first (Authentication, Users, Add user), then add it here.',
    not_found:      'This review link is no longer available. It may have expired or been withdrawn.',
    bad_password:   'That password is not correct.',
    locked:         'Too many wrong attempts. This link is locked for a few minutes.',
    submitted:      'This review has already been submitted and is now read-only.',
    conflict:       'Someone else saved changes at the same time.',
    exists:         'A review with this id already exists. Please try again.',
    too_large:      'This is too large to store. Share only the issues that still need review.',
    server:         'The server returned an unexpected error.',
    unsupported:    'This browser cannot do secure encryption. Use an up-to-date Chrome, Edge, Safari or Firefox over https.',
  };
  const friendly = (e) => (e && FRIENDLY[e.code]) || (e && e.message) || 'Something went wrong.';

  // ── key derivation + encryption ────────────────────────────────────────
  const normPassword = (p) => String(p || '').normalize('NFKC').trim();

  async function deriveKeys(password, saltB64, iter) {
    const base = await crypto.subtle.importKey('raw', enc.encode(normPassword(password)), 'PBKDF2', false, ['deriveBits']);
    const bits = await crypto.subtle.deriveBits(
      { name: 'PBKDF2', hash: 'SHA-256', salt: b64d(saltB64), iterations: iter || KDF_ITER }, base, 512);
    const key = await crypto.subtle.importKey('raw', bits.slice(0, 32), 'AES-GCM', false, ['encrypt', 'decrypt']);
    return { key, auth: hex(bits.slice(32)) };
  }

  const hasGzip = typeof CompressionStream !== 'undefined' && typeof DecompressionStream !== 'undefined';
  async function pipe(u8, Stream, kind) {
    const s = new Stream(kind); const w = s.writable.getWriter();
    w.write(u8); w.close();
    return new Uint8Array(await new Response(s.readable).arrayBuffer());
  }

  async function encryptJSON(obj, key) {
    let bytes = enc.encode(JSON.stringify(obj)); let z = false;
    if (hasGzip) { bytes = await pipe(bytes, CompressionStream, 'gzip'); z = true; }
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, bytes);
    return JSON.stringify({ v: 1, z, iv: b64e(iv), ct: b64e(ct) });
  }
  async function decryptJSON(str, key) {
    const w = JSON.parse(str);
    let bytes = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: b64d(w.iv) }, key, b64d(w.ct)));
    if (w.z) bytes = await pipe(bytes, DecompressionStream, 'gzip');
    return JSON.parse(dec.decode(bytes));
  }

  // ── talking to Supabase (RPC only — the tables are not reachable) ──────
  async function rpc(cfg, fn, args, bearer) {
    if (!cfg || !cfg.url || !cfg.key) throw new SRError('not_configured');
    const headers = { 'Content-Type': 'application/json', apikey: cfg.key };
    if (bearer) headers.Authorization = 'Bearer ' + bearer;                    // signed-in colleague
    else if (/^eyJ/.test(cfg.key)) headers.Authorization = 'Bearer ' + cfg.key; // legacy JWT anon keys
    let res;
    try {
      res = await fetch(cfg.url.replace(/\/+$/, '') + '/rest/v1/rpc/' + fn, { method: 'POST', headers, body: JSON.stringify(args) });
    } catch (e) { throw new SRError('network'); }
    const text = await res.text();
    let j = null; try { j = JSON.parse(text); } catch (_) { /* not JSON */ }
    if (!res.ok) {
      if (j && /PGRST30[1-3]|JWT (expired|invalid)/i.test((j.code || '') + ' ' + (j.message || ''))) throw new SRError('jwt_expired');
      if (res.status === 404 || (j && /PGRST20[0-9]|Could not find the function/i.test((j.code || '') + (j.message || '')))) throw new SRError('setup_missing');
      if (res.status === 401 || res.status === 403) throw new SRError(bearer && !/api ?key/i.test((j && j.message) || '') ? 'denied' : 'bad_key', j && j.message);
      throw new SRError('server', (j && (j.message || j.hint)) || ('HTTP ' + res.status));
    }
    return j;
  }

  // ── sessions (Supabase Auth, password grant) ───────────────────────────
  const TEAM_DOMAIN = 'explorer.team';                 // "anna" -> anna@explorer.team (or type a full email)
  const SESSION_KEY = 'sr_session';
  const mem = {};
  const store = {
    get(k) { try { return global.localStorage ? global.localStorage.getItem(k) : (k in mem ? mem[k] : null); } catch (_) { return k in mem ? mem[k] : null; } },
    set(k, v) { try { if (global.localStorage) global.localStorage.setItem(k, v); else mem[k] = v; } catch (_) { mem[k] = v; } },
    del(k) { try { if (global.localStorage) global.localStorage.removeItem(k); else delete mem[k]; } catch (_) { delete mem[k]; } },
  };
  const loadSession = () => { try { return JSON.parse(store.get(SESSION_KEY) || 'null'); } catch (_) { return null; } };
  const hasSession = () => { const s = loadSession(); return !!(s && s.refresh_token); };
  const clearSession = () => store.del(SESSION_KEY);
  const emailFor = (u) => { const s = String(u || '').trim().toLowerCase(); return s.indexOf('@') >= 0 ? s : s + '@' + TEAM_DOMAIN; };

  async function authCall(cfg, path, body) {
    if (!cfg || !cfg.url || !cfg.key) throw new SRError('not_configured');
    let res;
    try { res = await fetch(cfg.url.replace(/\/+$/, '') + '/auth/v1/' + path, { method: 'POST', headers: { 'Content-Type': 'application/json', apikey: cfg.key }, body: JSON.stringify(body) }); }
    catch (e) { throw new SRError('network'); }
    const text = await res.text(); let j = null; try { j = JSON.parse(text); } catch (_) { /* not JSON */ }
    if (!res.ok) {
      const code = String((j && (j.error_code || j.code)) || ''), msg = String((j && (j.msg || j.message || j.error_description)) || '');
      if (/user_banned/i.test(code) || /banned/i.test(msg)) throw new SRError('banned');
      if (/invalid_credentials/i.test(code) || /invalid login/i.test(msg)) throw new SRError('bad_login');
      if (/email_not_confirmed/i.test(code) || /not confirmed/i.test(msg)) throw new SRError('not_confirmed');
      if (res.status === 429 || /rate_limit/i.test(code)) throw new SRError('rate');
      if (/refresh_token|session_not_found|session_expired/i.test(code) || /refresh token/i.test(msg)) throw new SRError('signed_out');
      if ((res.status === 401 || res.status === 403) && /api ?key/i.test(msg)) throw new SRError('bad_key', msg);
      throw new SRError('server', msg || ('HTTP ' + res.status));
    }
    return j;
  }
  function saveFrom(j) {
    const s = { access_token: j.access_token, refresh_token: j.refresh_token, expires_at: j.expires_at ? j.expires_at * 1000 : Date.now() + (j.expires_in || 3600) * 1000, email: j.user && j.user.email };
    store.set(SESSION_KEY, JSON.stringify(s)); return s;
  }
  async function signIn(cfg, user, password) {
    if (!String(user || '').trim() || !password) throw new SRError('bad_login');
    return saveFrom(await authCall(cfg, 'token?grant_type=password', { email: emailFor(user), password }));
  }
  let refreshing = null;
  function refreshSession(cfg) {
    if (refreshing) return refreshing;
    const s = loadSession(); if (!s || !s.refresh_token) return Promise.reject(new SRError('signed_out'));
    refreshing = (async () => {
      try { return saveFrom(await authCall(cfg, 'token?grant_type=refresh_token', { refresh_token: s.refresh_token })); }
      catch (e) {
        if (e.code === 'network' || e.code === 'server') throw e;       // temporary: keep the session
        clearSession(); throw new SRError(e.code === 'banned' ? 'banned' : 'signed_out');
      } finally { refreshing = null; }
    })();
    return refreshing;
  }
  async function getToken(cfg) {
    let s = loadSession(); if (!s) throw new SRError('signed_out');
    if (!s.expires_at || s.expires_at - Date.now() < 60000) s = await refreshSession(cfg);
    return s.access_token;
  }
  // RPC as the signed-in colleague (refreshes an expired token once)
  async function arpc(cfg, fn, args) {
    let tok = await getToken(cfg);
    try { return await rpc(cfg, fn, args, tok); }
    catch (e) { if (e.code !== 'jwt_expired') throw e; tok = (await refreshSession(cfg)).access_token; return rpc(cfg, fn, args, tok); }
  }
  async function signOut(cfg) {
    const s = loadSession(); clearSession();
    if (s && cfg && cfg.url) { try { await fetch(cfg.url.replace(/\/+$/, '') + '/auth/v1/logout', { method: 'POST', headers: { apikey: cfg.key, Authorization: 'Bearer ' + s.access_token } }); } catch (_) { /* best effort */ } }
  }
  const must = (r) => { if (!r || r.ok !== true) throw new SRError((r && r.error) || 'server'); return r; };

  // ── team operations (signed-in colleagues) ─────────────────────────────
  async function whoami(cfg) { return must(await arpc(cfg, 'team_whoami', {})); }
  async function createShare(cfg, payload, password, days, meta) {
    if (!isSupported()) throw new SRError('unsupported');
    const id = crypto.randomUUID();
    const salt = b64e(crypto.getRandomValues(new Uint8Array(16)));
    const { key, auth } = await deriveKeys(password, salt, KDF_ITER);
    const blob = await encryptJSON(payload, key);
    must(await arpc(cfg, 'share_create', { p_id: id, p_salt: salt, p_iter: KDF_ITER, p_auth: auth, p_payload: blob, p_days: days,
      p_title: (meta && meta.title) || payload.title || '', p_password: password, p_issues: (payload.issues || []).length }));
    return { id, bytes: blob.length };
  }
  async function listShares(cfg) { return must(await arpc(cfg, 'share_list', {})).shares; }
  async function manageShare(cfg, id, action, days) { must(await arpc(cfg, 'share_manage', { p_id: id, p_action: action, p_days: days || 30 })); return true; }
  async function setApplied(cfg, id, issueId, done) { return must(await arpc(cfg, 'share_applied', { p_id: id, p_issue: String(issueId), p_done: !!done })).applied; }
  async function getTeamKeys(cfg) {
    const r = must(await arpc(cfg, 'team_keys_get', {}));
    return r.keys ? { keys: r.keys, updated_at: r.updated_at, updated_by: r.updated_by } : null;
  }
  async function putTeamKeys(cfg, keys) { must(await arpc(cfg, 'team_keys_put', { p_a: keys.a || null, p_o: keys.o || null })); return true; }
  async function clearTeamKeys(cfg) { must(await arpc(cfg, 'team_keys_clear', {})); return true; }
  // Team members (admin only). A Supabase account alone is not enough: the admin adds each person here.
  async function listMembers(cfg) { return must(await arpc(cfg, 'team_members_list', {})).members; }
  async function addMember(cfg, user, admin) { return must(await arpc(cfg, 'team_member_add', { p_email: emailFor(user), p_admin: !!admin })); }
  async function removeMember(cfg, id) { must(await arpc(cfg, 'team_member_remove', { p_user: id })); return true; }
  async function setMemberAdmin(cfg, id, on) { must(await arpc(cfg, 'team_member_admin', { p_user: id, p_admin: !!on })); return true; }
  // Is public sign-up still switched on in Supabase? (true = still open, false = closed, null = unknown)
  async function signupOpen(cfg) {
    try {
      const res = await fetch(cfg.url.replace(/\/+$/, '') + '/auth/v1/settings', { headers: { apikey: cfg.key } });
      if (!res.ok) return null;
      const j = await res.json();
      return j && typeof j.disable_signup === 'boolean' ? !j.disable_signup : null;
    } catch (_) { return null; }
  }
  // Does the database have the functions installed? (no account needed)
  async function testDatabase(cfg) {
    const r = await rpc(cfg, 'share_info', { p_id: '00000000-0000-4000-8000-000000000000' });
    return !!(r && r.ok === false && r.error === 'not_found');
  }
  // SQL the admin runs once so their account is an admin (the account must exist first)
  function adminSql(username) {
    const em = emailFor(username).replace(/'/g, "''");
    return "insert into public.team_admins(user_id)\nselect id from auth.users where lower(email) = '" + em + "'\non conflict do nothing;";
  }

  // ── reviewer / shared operations ───────────────────────────────────────
  async function openShare(cfg, id, password) {
    if (!isSupported()) throw new SRError('unsupported');
    const info = await rpc(cfg, 'share_info', { p_id: id });
    if (!info.ok) throw new SRError('not_found');
    const { key, auth } = await deriveKeys(password, info.salt, info.iter);
    const r = await rpc(cfg, 'share_open', { p_id: id, p_auth: auth });
    if (!r.ok) { const e = new SRError(r.error); e.left = r.left; e.until = r.until; throw e; }
    let payload;
    try { payload = await decryptJSON(r.payload, key); }
    catch (e) { throw new SRError('bad_password'); }
    const decisions = r.decisions ? await decryptJSON(r.decisions, key) : null;
    return { payload, decisions, version: r.version, status: r.status, expires_at: r.expires_at,
             submitted_at: r.submitted_at, session: { cfg, id, key, auth } };
  }
  async function saveDecisions(sess, decisions, submit, expected) {
    const blob = await encryptJSON(decisions, sess.key);
    const r = await rpc(sess.cfg, 'share_save', { p_id: sess.id, p_auth: sess.auth, p_decisions: blob, p_submit: !!submit, p_expected: expected });
    if (r.ok) return { ok: true, version: r.version, status: r.status };
    if (r.error === 'conflict') {
      return { ok: false, conflict: true, version: r.version, decisions: r.decisions ? await decryptJSON(r.decisions, sess.key) : null };
    }
    throw new SRError(r.error);
  }
  // Newest decision per issue wins
  function mergeDecisions(local, remote) {
    const out = { v: 1, reviewer: (local && local.reviewer) || (remote && remote.reviewer) || '', items: {}, updatedAt: Date.now() };
    const a = (local && local.items) || {}, b = (remote && remote.items) || {};
    new Set(Object.keys(a).concat(Object.keys(b))).forEach((k) => {
      const x = a[k], y = b[k];
      out.items[k] = !x ? y : !y ? x : ((x.at || 0) >= (y.at || 0) ? x : y);
    });
    return out;
  }

  // ── share link: the Supabase URL + public key ride in the #fragment ────
  // (public by design; a fragment is never sent to any server)
  function buildLink(id, cfg, baseHref) {
    const u = new URL('share.html', baseHref || global.location.href);
    u.search = '?s=' + id;
    u.hash = 'c=' + b64url(JSON.stringify({ u: cfg.url, k: cfg.key }));
    return u.toString();
  }
  function parseLink(loc) {
    const out = { id: null, cfg: null };
    const q = new URLSearchParams(loc.search || '');
    out.id = q.get('s');
    const m = /(?:^#|&)c=([^&]+)/.exec(loc.hash || '');
    if (m) { try { const o = JSON.parse(unb64url(m[1])); if (o.u && o.k) out.cfg = { url: o.u, key: o.k }; } catch (_) { /* bad fragment */ } }
    return out;
  }

  // ── passphrase generator (5 random words + 2 digits ≈ 48 bits) ─────────
  const WORDS = ('acorn amber anchor apple arrow aspen atlas autumn badge baker bamboo banner barley basil beacon berry birch bishop ' +
    'blossom bluff bonus border bottle branch breeze bridge bronze brook buckle butter cabin cactus camel candle canyon carbon cargo ' +
    'castle cedar cellar chalk cherry chess cliff clover cobalt comet coral cotton cradle crane crystal curtain dagger daisy dawn ' +
    'delta desert diamond dolphin dragon dune eagle ember engine falcon feather fern ferry field flame flint forest fossil fox galaxy ' +
    'garden garlic ginger glacier glove granite grove harbor hazel heron hill honey horizon island ivory jacket jasmine jungle kettle ' +
    'kingdom kite ladder lagoon lantern laurel lemon lilac linen lotus lunar magnet maple marble meadow melon mirror monsoon moss ' +
    'mountain mustard nectar needle nickel noble oasis ocean olive onyx orchid otter oyster paddle palace panther pebble pepper pillow ' +
    'pine planet plum pocket polar pond poppy prairie pumpkin quartz quill rabbit rain raven reef ribbon river robin rocket saddle ' +
    'saffron sage sailor salmon sand satin scarlet shadow shell silver sketch slate spark spice spruce squirrel stable star stone ' +
    'storm summit sunrise swan tangle thistle thunder tiger timber topaz torch tower trail tulip tundra turtle valley velvet violet ' +
    'voyage walnut wander willow winter wolf yarrow zebra zephyr breeze pearl comet lilac harvest meteor orbit pixel rhythm ' +
    'almond apricot bagel balcony beetle biscuit blanket bolt bonfire bubble cabbage cashew chapel chimney cider citrus compass ' +
    'copper cricket crown cuckoo dahlia denim dusk elbow elm emerald fable fennel fiddle finch firefly flute fountain frost gadget ' +
    'gazelle glimmer goblet gravel guitar hammock harp hawk helmet hickory hollow hornet iris jade jigsaw juniper kiwi koala lace ' +
    'lava ledger lime locket lyric mango mantle mosaic nutmeg oak opal parrot peach pigeon plume prism radish raisin relic rivet ' +
    'rose ruby scarab sequoia sparrow sunset thyme trumpet umber vine waffle wheat zinnia').split(' ')
    .filter((w, i, a) => a.indexOf(w) === i);

  function randInt(n) {                               // unbiased
    const lim = Math.floor(4294967296 / n) * n; const buf = new Uint32Array(1);
    do { crypto.getRandomValues(buf); } while (buf[0] >= lim);
    return buf[0] % n;
  }
  function newPassphrase() {
    const w = []; for (let i = 0; i < 5; i++) w.push(WORDS[randInt(WORDS.length)]);
    return w.join('-') + '-' + (10 + randInt(90));
  }
  // rough strength for the UI: 0 weak, 1 ok, 2 strong
  function strength(pw) {
    const p = String(pw || ''); if (p.length < 8) return 0;
    let pool = 0; if (/[a-z]/.test(p)) pool += 26; if (/[A-Z]/.test(p)) pool += 26; if (/\d/.test(p)) pool += 10; if (/[^A-Za-z0-9]/.test(p)) pool += 20;
    const bits = p.length * Math.log2(Math.max(pool, 2));
    return bits >= 60 ? 2 : bits >= 40 ? 1 : 0;
  }

  global.SR = {
    KDF_ITER, SRError, friendly, isSupported, normPassword,
    deriveKeys, encryptJSON, decryptJSON, rpc,
    TEAM_DOMAIN, emailFor, signIn, signOut, hasSession, loadSession, clearSession, refreshSession, whoami,
    createShare, listShares, manageShare, setApplied, getTeamKeys, putTeamKeys, clearTeamKeys, testDatabase, adminSql,
    listMembers, addMember, removeMember, setMemberAdmin, signupOpen,
    openShare, saveDecisions, mergeDecisions, buildLink, parseLink,
    newPassphrase, strength, sha256hex, WORDS,
  };
})(typeof window !== 'undefined' ? window : globalThis);
