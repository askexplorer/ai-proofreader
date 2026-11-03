// Offline test for the v5.3 review helpers in share-core.js: reviewInfo, createShare (list details + old-database fallback),
// viewShare (team-side open, fallback, strict), manageShare('restore'), setShareMeta.
// Run: node tests/reviews-client.test.mjs   (Node 18+)
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
new Function(readFileSync(path.join(root, 'share-core.js'), 'utf8'))();
const SR = globalThis.SR;
let pass = 0, fail = 0;
const ok = (c, n, x) => { if (c) pass++; else { fail++; console.log('FAIL  ' + n + (x ? '  ' + x : '')); } };

// ---- reviewInfo: what the Reviews list shows
const payload = { kind: 'translation', language: 'Spanish', sourceLanguage: 'English', pages: 82, wordCount: 25000,
  issues: [{ severity: 'Major' }, { severity: 'Major' }, { severity: 'Query' }, { severity: 'Minor' }, {}] };
let i = SR.reviewInfo(payload, { projectId: 'proj-1', found: 188 });
ok(i.kind === 'translation' && i.language === 'Spanish' && i.sourceLanguage === 'English' && i.pages === 82 && i.words === 25000 && i.items === 5, 'kind, languages, size and item count are read from the report', JSON.stringify(i));
ok(i.severities.Major === 2 && i.severities.Query === 1 && i.severities.Minor === 1 && i.severities.Other === 1, 'counts by severity (a missing severity is "Other")', JSON.stringify(i.severities));
ok(i.projectId === 'proj-1' && i.found === 188, 'the project id and the size of the full report are kept');
ok(SR.reviewInfo({ kind: 'proofread', issues: [] }).kind === 'proofread' && SR.reviewInfo({ issues: [] }).kind === 'proofread', 'anything that is not a translation check is a proofreading review');
ok(!('language' in SR.reviewInfo({ issues: [] })) && !('projectId' in SR.reviewInfo({ issues: [] })), 'no language / project when there is none');
ok(SR.reviewInfo({ language: 'x'.repeat(200), issues: [] }).language.length === 40, 'a very long language name is cut');
ok(JSON.stringify(SR.reviewInfo({ issues: Array.from({ length: 3000 }, (_, k) => ({ severity: 'Minor', id: k })) })).length < 400, 'the details stay tiny however many findings there are');
ok(!JSON.stringify(i).includes('context') && !JSON.stringify(SR.reviewInfo({ issues: [{ severity: 'Major', original: 'secret text', context: 'more secret text' }] })).includes('secret'), 'no report text ever goes into the plain-text details');

// ---- fake server
const calls = []; let mode = 'new';
const realFetch = globalThis.fetch, store = new Map();
globalThis.localStorage = { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k) };
store.set('sr_session', JSON.stringify({ access_token: 'tok', refresh_token: 'r', expires_at: Date.now() + 3600000 }));
const cfg = { url: 'https://proj.supabase.co', key: 'sb_publishable_placeholder' };
const PW = 'correct-horse-12';
let sealed = null;                                               // what share_view / share_open hand back (a real encrypted blob)
globalThis.fetch = async (url, init) => {
  const fn = String(url).split('/rpc/')[1], body = JSON.parse(init.body); calls.push({ fn, body });
  const J = (o, status = 200) => new Response(JSON.stringify(o), { status });
  const missing = () => J({ code: 'PGRST202', message: 'Could not find the function public.' + fn + ' in the schema cache' }, 404);
  if (fn === 'share_create') { if (mode === 'old' && 'p_meta' in body) return missing(); if (mode === 'old-500' && 'p_meta' in body) return J({ message: 'boom' }, 400); if (mode === 'denied') return J({ ok: false, error: 'denied' }); sealed = { salt: body.p_salt, payload: body.p_payload }; return J({ ok: true, id: body.p_id }); }
  if (fn === 'share_view') { if (mode === 'old') return missing(); return J({ ok: true, salt: sealed.salt, iter: 600000, payload: sealed.payload, decisions: null, status: 'revoked', version: 0, expires_at: '2030-01-01T00:00:00Z', submitted_at: null }); }
  if (fn === 'share_info') return J({ ok: true, salt: sealed.salt, iter: 600000 });
  if (fn === 'share_open') return J({ ok: true, payload: sealed.payload, decisions: null, status: 'pending', version: 0, expires_at: '2030-01-01T00:00:00Z', submitted_at: null });
  if (fn === 'share_manage') { if (body.p_action === 'restore' && mode === 'old') return J({ ok: false, error: 'bad_action' }); return J({ ok: true }); }
  if (fn === 'share_meta') return J({ ok: false, error: 'forbidden' });
  return J({}, 404);
};

// ---- createShare sends the details, and survives a database that has not had the update
let r = await SR.createShare(cfg, payload, PW, 30, { title: 'T', info: i });
let c = calls.find((x) => x.fn === 'share_create');
ok(r.id && c && c.body.p_meta && c.body.p_meta.language === 'Spanish' && c.body.p_title === 'T' && c.body.p_issues === 5, 'createShare sends the list details as p_meta');
ok(!JSON.stringify(c.body).includes('Spanish') || JSON.stringify(c.body.p_meta).includes('Spanish'), 'the language is only in p_meta, the report itself stays inside the encrypted payload');
ok(!c.body.p_payload.includes('Spanish') && !c.body.p_payload.includes('Major'), 'the uploaded payload is ciphertext (no readable words)');
calls.length = 0; await SR.createShare(cfg, payload, PW, 30, { title: 'T' });
ok(calls.length === 1 && !('p_meta' in calls[0].body), 'without details nothing extra is sent (older behaviour)');
calls.length = 0; mode = 'old'; r = await SR.createShare(cfg, payload, PW, 30, { title: 'T', info: i });
ok(r.id && calls.length === 2 && 'p_meta' in calls[0].body && !('p_meta' in calls[1].body), 'on a database without the v5.3 update the share is created again without the details', calls.map((x) => x.fn + ':' + ('p_meta' in x.body)).join());
// a gateway that answers an unknown argument with a plain server error instead of PGRST202 is handled the same way
calls.length = 0; mode = 'old-500'; r = await SR.createShare(cfg, payload, PW, 30, { title: 'T', info: i });
ok(r.id && calls.length === 2 && !('p_meta' in calls[1].body), 'a generic server error on the first try also falls back to sharing without the details');
calls.length = 0; mode = 'denied'; let dcode = ''; try { await SR.createShare(cfg, payload, PW, 30, { title: 'T', info: i }); } catch (e) { dcode = e.code; }
ok(dcode === 'denied' && calls.length === 1, 'a real refusal is NOT retried (one call, error shown)', dcode + ' ' + calls.length);
mode = 'new';

// ---- viewShare: the team reads it with the stored password, whatever its status
r = await SR.createShare(cfg, payload, PW, 30, { title: 'T' }); calls.length = 0;
let v = await SR.viewShare(cfg, r.id, PW);
ok(v.payload.language === 'Spanish' && v.payload.issues.length === 5 && v.status === 'revoked' && calls.length === 1 && calls[0].fn === 'share_view', 'viewShare decrypts a withdrawn review with the stored password (one call, no reviewer route)', JSON.stringify(calls.map((x) => x.fn)));
let code = ''; try { await SR.viewShare(cfg, r.id, 'wrong-password-99'); } catch (e) { code = e.code; }
ok(code === 'bad_password', 'a wrong stored password is reported as bad_password, not as garbage');
calls.length = 0; mode = 'old'; v = await SR.viewShare(cfg, r.id, PW);
ok(v.payload.language === 'Spanish' && calls.map((x) => x.fn).join() === 'share_view,share_info,share_open', 'on an old database it falls back to the reviewer route', calls.map((x) => x.fn).join());
calls.length = 0; code = ''; try { await SR.viewShare(cfg, r.id, PW, { strict: true }); } catch (e) { code = e.code; }
ok(code === 'setup_missing' && calls.map((x) => x.fn).join() === 'share_view', 'strict mode never takes the reviewer route (it would mark the review as opened)', code + ' ' + calls.map((x) => x.fn).join());
mode = 'new';

// ---- restore and details
calls.length = 0; ok(await SR.manageShare(cfg, 'id', 'restore') === true && calls[0].body.p_action === 'restore', 'manageShare can restore a withdrawn link');
mode = 'old'; code = ''; try { await SR.manageShare(cfg, 'id', 'restore'); } catch (e) { code = e.code; }
ok(code === 'bad_action' && /re-run the setup SQL/i.test(SR.friendly({ code })), 'on an old database restore says what to do (re-run the setup SQL)');
mode = 'new'; code = ''; try { await SR.setShareMeta(cfg, 'id', i); } catch (e) { code = e.code; }
ok(code === 'forbidden', 'setShareMeta surfaces a refusal');

globalThis.fetch = realFetch;
console.log(`${fail ? 'FAILED' : 'OK'}: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
