# Tests

Nothing here ships to users; it only protects the code from regressions.

| Command | What it checks |
|---|---|
| `node tests/tc-core.test.mjs` | Translation-check engine on a generated sample book with known defects (omission, addition, changed number, untranslated text, missing and extra chapter, mistyped chapter number) and a fake model that misbehaves on purpose (bad JSON, incomplete answers, truncation, invented quotes, false omission claims). Also stop and continue. |
| `node tests/tc-rtf.test.mjs` | RTF reader, paragraph and chapter detection, the scoring rubric. |
| `node tests/openai-key.test.mjs` | The OpenAI key diagnosis (accepted / rejected / other / unreachable) and the key-problem error, cut out of `index.html` and run against a fake `fetch`. |
| `node tests/tc-second.test.mjs` | Translation-check clean-up and second look, on an invented lighthouse story with planted defects and two fake models (one for the check, one for the second look): German thousands separators, window labels, twin merge, verbatim repeats, recurring word choices with the extra places found, Notes, the second look (agreement, new findings, a forgotten pair, a failing part), per-model token tracking, estimates, share/CSV output. |
| `node tests/proof-json.test.mjs` | The proofreading reply reader cut out of `index.html`: unescaped quotes, raw line breaks, trailing commas, fences and prose around the JSON, cut-off and non-JSON replies, salvage, and that 3,000 random valid replies are never altered by the repair step. |
| `supabase/` | The team workspace database rules, run on a real Postgres (PGlite) with a stand-in for Supabase Auth. |

The first two need only Node 18+. For the Supabase tests:

```bash
cd tests && npm install
node supabase/pg_shim.mjs &        # local stand-in for Supabase, port 54321
sleep 8 && node supabase/accounts.test.mjs
```

The stand-in mimics Supabase's default grants (new functions are pre-granted to `anon` and `authenticated`), which is what
makes the "stranger gets nothing" and "anon cannot call team functions" checks meaningful.
