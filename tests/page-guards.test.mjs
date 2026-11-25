// Guards on the pages themselves (no browser needed): things an audit found once and that must not come back.
// Run: node tests/page-guards.test.mjs   (Node 18+)
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const rd = (f) => readFileSync(path.join(root, f), 'utf8');
let pass = 0, fail = 0;
const ok = (c, n, x) => { if (c) pass++; else { fail++; console.log('FAIL  ' + n + (x ? '  ' + x : '')); } };

const INDEX = rd('index.html'), SHARE = rd('share.html');
const inlineCode = (h) => (h.match(/<script(?![^>]*\bsrc=)[^>]*>[\s\S]*?<\/script>/g) || []).map((x) => x.replace(/^<script[^>]*>|<\/script>$/g, '')).join('\n');
const strip = (h) => h.replace(/<script[\s\S]*?<\/script>/g, '').replace(/<style[\s\S]*?<\/style>/g, '');

for (const [name, html] of [['index.html', INDEX], ['share.html', SHARE]]) {
  const code = inlineCode(html);
  try { new Function(code); ok(true, name + ': scripts parse'); } catch (e) { ok(false, name + ': scripts parse', e.message); }
  const ids = [...strip(html).matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]), seen = new Set(), dup = ids.filter((i) => seen.has(i) || !seen.add(i));
  ok(!dup.length, name + ': no duplicate element ids', dup.join());
  // every function an inline handler calls exists
  const defined = new Set([...code.matchAll(/function\s+([A-Za-z_$][\w$]*)/g)].map((m) => m[1]).concat([...code.matchAll(/(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=/g)].map((m) => m[1])));
  const handlers = [...html.matchAll(/\bon(?:click|change|input|submit|keydown)=\\?"([^"]*)"/g)].map((m) => m[1]);
  const called = new Set(); handlers.forEach((h) => { for (const m of h.matchAll(/(?<![\w.$'"])([A-Za-z_$][\w$]*)\s*\(/g)) called.add(m[1]); });
  const builtins = new Set(['if', 'return', 'confirm', 'alert', 'setTimeout', 'toast', 'srCopy', 'closeShareModal', 'translation', 'function']);
  const missing = [...called].filter((n) => !defined.has(n) && !builtins.has(n) && !(n in globalThis));
  ok(!missing.length, name + ': every function used by an inline handler is defined', missing.join());
  ok(!/[\u2028\u2029\u0000]/.test(html), name + ': no U+2028 / U+2029 / NUL characters');
}

// third-party scripts: pinned version + integrity hash (a hijacked CDN file cannot run inside the app)
const ext = [...INDEX.matchAll(/<script[^>]*\ssrc="(https:\/\/[^"]+)"[^>]*>/g)];
ok(ext.length >= 5, 'index.html loads its libraries from CDNs (' + ext.length + ')');
for (const m of ext) {
  ok(/integrity="sha384-[A-Za-z0-9+/=]{64}"/.test(m[0]) && /crossorigin="anonymous"/.test(m[0]), 'integrity hash + crossorigin on ' + m[1].split('/').slice(-2).join('/'));
  ok(/[@/]\d+\.\d+\.\d+/.test(m[1]), 'pinned exact version: ' + m[1].split('/').slice(-2).join('/'));
}
ok(/getDocument\(\{[^}]*isEvalSupported:\s*false/.test(INDEX), 'pdf.js: isEvalSupported:false (CVE-2024-4367, script in a crafted PDF font)');
ok(!/getDocument\(\{data:buf\}\)/.test(INDEX), 'pdf.js: no getDocument call without the safe option');

// cache tags move together with the files they point at
const tag = (h, f) => (h.match(new RegExp(f.replace('.', '\\.') + '\\?v=([\\d.]+)')) || [])[1];
ok(tag(INDEX, 'share-core.js') && tag(INDEX, 'share-core.js') === tag(SHARE, 'share-core.js'), 'share-core.js carries the same ?v= tag on both pages', tag(INDEX, 'share-core.js') + ' / ' + tag(SHARE, 'share-core.js'));
ok(!!tag(INDEX, 'tc-core.js'), 'tc-core.js is loaded with a ?v= tag');
ok(tag(INDEX, 'tc-core.js') === (INDEX.match(/app-footer-version">v([\d.]+)</) || [])[1], 'tc-core.js ?v= tag follows the app version (a cached old engine must not meet a new page)', tag(INDEX, 'tc-core.js'));

// file hygiene from CLAUDE.md
ok(!/[^\x00-\x7f]/.test(rd('tc-core.js')), 'tc-core.js is ASCII only');
ok(!/[^\x00-\x7f]/.test(rd('docx-apply.js')), 'docx-apply.js is ASCII only');
ok(tag(INDEX, 'docx-apply.js') === (INDEX.match(/app-footer-version">v([\d.]+)</) || [])[1], 'docx-apply.js ?v= tag follows the app version', tag(INDEX, 'docx-apply.js'));
ok(INDEX.indexOf('docx-apply.js') < INDEX.indexOf('<script>', INDEX.indexOf('docx-apply.js')) && INDEX.indexOf('docx-apply.js') > 0, 'docx-apply.js is loaded before the page script that uses it');
const jsOnly = inlineCode(INDEX).split('\n').filter((l) => !/^\s*\/\//.test(l));
ok(!jsOnly.some((l) => /[\u2018\u2019\u201c\u201d]/.test(l.replace(/(['"`])(?:\\.|(?!\1).)*\1/g, ''))), 'no curly quotes in JS code outside strings');

// regressions found by the v5.3 audit
const fin = INDEX.slice(INDEX.indexOf('function tcFinalize()'), INDEX.indexOf('function tcShowError'));
ok(/projectId:\s*R\.projectId\b/.test(fin) && !/lastTC\s*&&\s*lastTC\.projectId/.test(fin), 'a new translation check never inherits the previous report\'s Project id (it overwrote it)');
ok(/TC_RUN = \{[^]*?projectId:\s*crypto\.randomUUID\(\)/.test(INDEX), 'every translation run starts with its own Project id');
// found in the 146-finding Inside report: a "not an issue" mark from an EARLIER check travelled into the next one
ok(/sameRun\s*=[^;]*String\(lastTC\.projectId\)\s*===\s*String\(R\.projectId\)/.test(fin) && /triage\s*=\s*sameRun\s*\?\s*lastTC\.triage\s*:\s*\{\}/.test(fin), 'a new translation check starts with no triage marks (only a continued run keeps them)');
ok(/id="i-' \+ esc\(i\.id\)/.test(SHARE) && /String\(ACTIVE\) === String\(i\.id\)/.test(SHARE), 'reviewer page: issue ids are escaped and the active card is compared as text');
ok(/\(\+x\.severities\[k\] \|\| 0\)/.test(INDEX) && /\(\+x\.pages\)/.test(INDEX), 'Reviews list: numbers from the plain-text details are coerced before they are shown');
ok(!/pdf\.worker/.test(INDEX.replace(/workerSrc[\s\S]*?pdf\.worker\.min\.js/, '')), 'the pdf.js worker is referenced in one place');

// v5.4.1: fixes after a translator rejected most findings of a literary check
ok(/function tcStrictPref\(\) \{ return 'facts'; \}/.test(INDEX) && !/localStorage\.setItem\('proof_tc_strict'/.test(INDEX), 'the translation check always starts at "Facts only" (the level is never remembered)');
ok(/d === 'agree' \? \(issue\.corrected \? issue\.corrected : null\)/.test(INDEX), 'agreeing with a finding that has no wording never means "delete this text"');
ok(/id="tc-literary"/.test(INDEX) && /literary,\s*only: P\.only/.test(INDEX) && /literary: !!R\.literary/.test(INDEX), 'the literary-text choice reaches the run and the report');
ok(/secondSameModel: !R\.model2 \|\| R\.model2 === R\.model/.test(INDEX), 'the engine is told when the second look uses the same model');
ok(/LEVEL_TEXT\[p\.strict\]/.test(SHARE) && /strict: tc \?/.test(INDEX), 'the reviewer page says how strict the check was');
// v5.4.1: reviewers can look at what they submitted; Apply to Word flags suspicious changes
const startFn = SHARE.slice(SHARE.indexOf('function startReview(r)'), SHARE.indexOf('function openWelcome'));
ok(/if \(SUBMITTED\) return enterSubmittedView\(\);/.test(startFn) && !/showDone\(true\)/.test(startFn), 'reviewer page: a submitted link opens straight into the read-only copy (not a thank-you card with a hidden way in)');
ok(/id="subbox"/.test(SHARE) && /function paintSubmitted\(\)/.test(SHARE) && /function downloadMine\(\)/.test(SHARE) && /\$\('btn-viewmine'\)\.onclick = enterSubmittedView/.test(SHARE), 'reviewer page: banner, "Download my answers" and the button after submitting are wired');
ok(/View what I submitted/.test(SHARE) && !/They are shown below in read-only form/.test(SHARE), 'reviewer page: the done card no longer promises answers it does not show');
ok(/'To check in Word'/.test(INDEX) && /Why check: /.test(INDEX), 'Apply to Word: flagged changes have their own tile and list');
ok(/^\s*function foldPlain\(raw\)/m.test(rd('docx-apply.js')) && /foldPlain\(p\.text\)/.test(rd('docx-apply.js')), 'docx-apply.js: fingerprints keep the old folding so reviews made before the NFC fix still match');
console.log(`${fail ? 'FAILED' : 'OK'}: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
