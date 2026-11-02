# Tests

Nothing here ships to users; it only protects the code from regressions.

| Command | What it checks |
|---|---|
| `node tests/tc-core.test.mjs` | Translation-check engine on a generated sample book with known defects (omission, addition, changed number, untranslated text, missing and extra chapter, mistyped chapter number) and a fake model that misbehaves on purpose (bad JSON, incomplete answers, truncation, invented quotes, false omission claims). Also stop and continue. |
| `node tests/tc-strict.test.mjs` | The translation check's strictness levels (facts only / close / everything), the "normal translation choices" calibration text, the Arabic note, demotion of minor findings, no "Ch 1" without chapters, length-outlier thresholds. Invented text. |
| `node tests/tc-docx.test.mjs` | `TC.docxPages`: Word page numbers read from hand-built .docx files (saved layout, explicit breaks, stored and deflated zips, Arabic, entities, bad input). |
| `node tests/tc-rtf.test.mjs` | RTF reader, paragraph and chapter detection, the scoring rubric. |
| `node tests/ai-fetch.test.mjs` | `aiFetch` cut out of `index.html`: direct calls unchanged, calls through the team server carry the user token and no key, a provider's 401 (rejected team key) is never treated as a lost session, a real expired token is refreshed once. |
| `node tests/ai-proxy.test.mjs` | The `ai-proxy` Edge Function, loaded exactly as written against a fake Supabase and fake AI providers: only team members get through, runs as the caller, keys never in any answer, crossed keys sorted, status/rate-limit headers pass through, validation, 140 s cut-off. |
| `node tests/projects-client.test.mjs` | The Projects helpers in `share-core.js`: gzip + base64 round trip (multi-script, large), the RPC calls and their arguments. |
| `node tests/admin-users.test.mjs` | The `admin-users` Edge Function (create / remove / reset logins), loaded exactly as written against a fake Supabase: only admins pass, service key never used for others, self/non-member protection, rollback of half-made logins. |
| `node tests/key-mixup.test.mjs` | The key mix-up guard (`keyKind`, `sortKeys`, `fixLocalKeys`, the Test-connection early check): a key pasted into the other company's box is moved to the right box and never lost or sent to the wrong company. Placeholder keys only. |
| `node tests/openai-key.test.mjs` | The OpenAI key diagnosis (accepted / rejected / other / unreachable) and the key-problem error, cut out of `index.html` and run against a fake `fetch`. |
| `node tests/tc-second.test.mjs` | Translation-check clean-up and second look, on an invented lighthouse story with planted defects and two fake models (one for the check, one for the second look): German thousands separators, window labels, twin merge, verbatim repeats, recurring word choices with the extra places found, Notes, the second look (agreement, new findings, a forgotten pair, a failing part), per-model token tracking, estimates, share/CSV output. |
| `node tests/proof-json.test.mjs` | The proofreading reply reader cut out of `index.html`: unescaped quotes, raw line breaks, trailing commas, fences and prose around the JSON, cut-off and non-JSON replies, salvage, and that 3,000 random valid replies are never altered by the repair step. |
| `supabase/` | The team workspace database rules (`accounts.test.mjs`, needs the stand-in running) and the shared Projects rules (`projects.test.mjs`), run on a real Postgres (PGlite) with a stand-in for Supabase Auth. |

The first two need only Node 18+. For the Supabase tests:

```bash
cd tests && npm install
node supabase/pg_shim.mjs &        # local stand-in for Supabase, port 54321
sleep 8 && node supabase/accounts.test.mjs
```

The stand-in mimics Supabase's default grants (new functions are pre-granted to `anon` and `authenticated`), which is what
makes the "stranger gets nothing" and "anon cannot call team functions" checks meaningful.
