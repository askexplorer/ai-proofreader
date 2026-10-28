# Explorer AI Proofreader — Project Memory

## What this project is
Single-file browser app for professional AI-powered proofreading. Powered by Anthropic Claude API (direct browser → API calls). The proofreading itself is pure client-side HTML/JS/CSS. Since v4.0.0 an optional **team workspace** (personal accounts, shared reviews, one shared API key) runs on the user's own Supabase project; without it the portal works exactly as a single-user tool.

**Supabase project (Explorer-owned, org `askexplorer`):** ref `esslcpdxlhsxxeccfixy`, region ap-northeast-1. The schema is already applied there. The user must still create their own admin account (see below); I must NOT create accounts or admin grants in their live auth system (the permission checker blocks it, and it is the user's to do).

**Live repo:** github.com/askexplorer/ai-proofreader (remote `askexplorer`; the old `origin` = shakkeer-cloud is retired)  
**Live site:** https://askexplorer.github.io/ai-proofreader/ (GitHub Pages, serves `master`)  
**Branch:** master  
**Current version:** v4.2.0

---

## Files

| File | Purpose | Lines |
|---|---|---|
| `index.html` | Main app — all logic, UI, CSS in one file (incl. team workspace UI: sign-in, Setup wizard, team members, Share modal, Reviews tab) | ~4700 |
| `share.html` | Reviewer page — opened from a share link, password-gated, Agree / Disagree / Edit per issue, autosave, Submit | ~620 |
| `tc-core.js` | `window.TC` - translation-check engine: RTF reader, paragraphs, chapters, alignment, windows, prompts, strict answer validation, rule checks, scoring (pure logic, no DOM/network, unit-tested) | ~900 |
| `tests/` | Offline tests (engine, RTF/rubric, Supabase rules); see `tests/README.md` | |
| `share-core.js` | `window.SR` — E2E crypto, Supabase Auth sign-in/refresh, RPC client; shared by index.html and share.html | ~330 |
| `supabase/setup.sql` | DB setup for the Supabase project (locked tables + SECURITY DEFINER RPCs; idempotent, re-run to upgrade) | ~430 |
| `review.html` | Older review page (not actively maintained, do not touch) | ~1160 |

**RULE: `index.html`, `share.html`, `share-core.js` and `supabase/setup.sql` are all in scope (the user explicitly allowed it). Leave `review.html` alone unless asked.**
Keep the file hygiene rule: no curly quotes in JS code, no literal U+2028/U+2029/NUL (use `String.fromCharCode` / constants).

---

## Architecture (index.html)

- **PDF.js** (cdnjs 2.16.105) for client-side PDF text extraction
- **Mammoth** for .docx extraction
- **jsPDF** + **docx.js** for PDF and Word exports
- **Anthropic API** called directly from browser with `anthropic-dangerous-direct-browser-access: true`
- **localStorage** for: API key, user name, history (20 entries), last report (24h), cost stats, glossary, page texts (retry), theme
- No framework — vanilla JS throughout

---

## Key constants (index.html ~line 638)

```js
CHUNK_SIZE = 45000        // chars per chunk (~16k tokens)
CHUNK_OVERLAP = 150       // chars of overlap at chunk boundaries
RATE_LIMIT_WAIT_S = 75    // seconds between chunks
```

## Models
```js
claude-sonnet-4-6          // default, fast, recommended for RTL/complex scripts
claude-opus-4-7            // best quality, slow, expensive
claude-haiku-4-5-20251001  // fastest, cheapest, good for large batch docs
```

## MODEL_PRICING (per 1M tokens)
```js
sonnet-4-6:  { in: 3.00,  out: 15.00 }
opus-4-7:    { in: 15.00, out: 75.00 }
haiku-4-5:   { in: 0.80,  out: 4.00  }
```

---

## State object (docInfo)

```js
docInfo = {
  filename, ext, fileSize,
  pages,          // int — PDF page count
  pageTexts,      // string[] — per-page text (used for page number attribution)
  wordCount, charCount, paraCount,
  images, graphics, tables,
  language,       // detected language string
  isSpread,       // bool — InDesign double-page spread detected (page width > 750pt)
  scriptDir,      // 'ltr' | 'rtl'
}
```

---

## v3.0.0 / v3.0.1 — What was built (May 2026)

### PDF extraction improvements
- **Column-aware extraction** (`buildColumnText`): for spread PDFs, text items split at page midpoint, left column extracted first then right — prevents word interleaving
- **Spread auto-detection**: first page viewport width > 750pt = spread; user can override with Page Layout select
- **RTL word-order fix** (`fixRTLWordOrder`): pdf.js returns Arabic/Hebrew in visual L→R order; words are reversed per line when RTL script detected
- **NFC normalization**: fixes Bengali/Arabic/Hindi glyph fragments after extraction
- **Decorative text removal** (`fixDecorativeText`): strips InDesign shadow/echo text like "KK IISSAA HH"
- **Text compression** (`compressExtractedText`): collapses whitespace, trims blank lines
- **Quality warning** (`checkExtractionQuality`): alerts user when < 10 words/page (likely scanned)
- **Urdu advisory**: warns user that Nastaliq fonts use proprietary glyph maps — paste manually

### New UI controls
- **Page Layout** select: Auto-detect / Single page / Double-page spread
- **Reading Direction** select: Auto-detect / LTR / RTL
- **⚡ Quick** preset check button (Typos + Spelling + Grammar + Punctuation) — fastest/cheapest
- **Cost Tracker** card in Setup page (session, all-time, avg/run, Reset)
- **Confirm modal**: now shows per-1k-words cost + Layout/Direction info row + smarter model tip (RTL → Sonnet, large → Haiku)
- **Report cost line**: shows per-1k-words cost alongside total
- **Analyse panel**: shows Script Direction + Page Layout stats

### Language support
- `detectLanguage()` now covers: Hebrew, Persian, Hindi, Bengali, Tamil, Thai, Japanese, Korean (script-range detection) + Latin-script scoring (Indonesian, Malay, French, Spanish, German, English)
- Dropdown added: Hebrew, Japanese, Korean, Persian, Traditional Chinese
- `RTL_LANGS = new Set(['arabic','hebrew','persian','urdu'])`
- System prompt: RTL note, Thai note (no word-spaces), spread note — all injected per-document

### Cost reduction
- **Prompt caching**: system sent as `[{type:'text', text:systemPrompt, cache_control:{type:'ephemeral'}}]` with `anthropic-beta: prompt-caching-2024-07-31` header — ~80% cost saving on multi-chunk runs
- **Adaptive max_tokens**: Haiku 1500–4096, Sonnet 2000–8000 (sized per chunk word count)
- **CHUNK_OVERLAP**: reduced from 400 → 150 chars
- **CJK sentence boundaries** in `splitIntoChunks()`: `。！？；`

### Export fixes (v3.0.1)
- `buildCtxParts(context, original, replacement)` — plain-text equivalent of `buildCtx()`; returns `{before, highlight, after}`
- **Word export**: `cellCtx()` builds multi-TextRun cells — shows full context sentence with original in red, corrected in green; surrounding context in grey
- **PDF export**: uses `buildCtxParts()` for full context strings; columns widened (38→46mm / 44→52mm); page-break guard for long rows
- Column headers renamed: "Original (in context)" / "Corrected (in context)"

### Fonts
- Noto Sans Bengali, Arabic, Devanagari, Hebrew, Tamil, Thai, Nastaliq Urdu loaded via Google Fonts
- Multi-script CSS font stack on `.context-snippet, td`

---

## Key functions to know

| Function | What it does |
|---|---|
| `extractText(file)` | Dispatches to PDF/DOCX/TXT extractor |
| `buildColumnText(items, isSpread)` | Column-aware pdf.js item → text |
| `fixRTLWordOrder(text)` | Reverses word order in RTL lines |
| `fixDecorativeText(text)` | Strips InDesign shadow-layer echoes |
| `compressExtractedText(text)` | Collapses whitespace |
| `checkExtractionQuality(text, pages)` | Returns warning string or null |
| `detectLanguage(text)` | Returns language name string |
| `isRTLLang(lang)` | Returns bool |
| `splitIntoChunks(text, size)` | Latin + CJK sentence boundaries |
| `addChunkOverlap(chunks, n)` | Adds n-char tail from previous chunk |
| `callApiWithRetry(payload, key, …)` | Fetch with 3× retry + rate-limit wait |
| `proofreadOne(file, paste, key, show)` | Full single-document proofreading flow |
| `renderReport(r)` | Renders report page from report object |
| `buildCtx(ctx, orig, cls, repl)` | HTML context snippet with mark |
| `buildCtxParts(ctx, orig, repl)` | Plain-text {before,highlight,after} for exports |
| `renderCostTracker()` | Updates Setup cost tracker card |
| `trackCost(usd)` | Adds to session + localStorage stats |
| `saveToHistory(report)` | Persists to proof_history (max 20) |
| `loadHistoryItem(id)` | Restores report from history |
| `saveLastReport(report)` | Persists to proof_last_report (24h TTL) |
| `showConfirmModal(…)` | Pre-run cost estimate modal |
| `retryFailedChunks()` | Continues partial run from _retryState |

---

## API call format (proofreadOne)

```js
{
  model,
  max_tokens: adaptiveMaxTok,   // 1500–8000 based on chunk word count
  temperature: 0,
  system: [{
    type: 'text',
    text: systemPrompt,
    cache_control: { type: 'ephemeral' }
  }],
  messages: [{ role:'user', content: `Proofread this text (part N of M):\n\n${chunk}` }]
}
// Headers include: anthropic-beta: prompt-caching-2024-07-31
```

---

## System prompt structure (proofreadOne)

1. Language line (auto-detect instruction OR `The document is in ${resolvedLang}`)
2. Checks line (`Check ONLY these error types: …`)
3. 8 error type definitions (Typos, Spelling, Grammar, Punctuation, Capitalization, Style, Consistency, Clarity)
4. Severity rules
5. 4 important rules (exact text, page markers, explanation format, certainty)
6. Optional: glossary line (from localStorage)
7. Optional: RTL note (when scriptDir === 'rtl')
8. Optional: Thai note (when language === Thai)
9. Optional: spread note (when isSpread === true)
10. JSON schema for response

---

## Team workspace (v4.0.0) — accounts, shared reviews, shared API key

**Workflow it serves:** editors proofread with the *shared team API key* and share a report with an external translator (link + separate password, no account). The translator decides on each issue and submits. Any colleague (editor or designer) sees the answers in the shared **Reviews** list, exports an apply-list (Word/CSV) and ticks items off as applied in layout; the ticks are shared so everyone sees progress. The admin adds/removes colleagues from the portal.

### People and access
- **Colleagues** sign in with Supabase Auth (username + password, username -> `username@explorer.team`, or a full email). The admin creates the login in the Supabase dashboard (Authentication -> Users -> Add user, tick *Auto Confirm User*) and then **adds them as a team member in the portal** (Setup -> Team workspace -> Team members). Having a Supabase account is NOT enough: `_member()` requires a row in `team_members` or `team_admins`, so a stranger who signs up with the public key gets nothing even if "Allow new users to sign up" is left on (turning it off is still recommended; the wizard warns via `GET /auth/v1/settings` `disable_signup`).
- **Admin**: row in `team_admins`. Can store/remove the team API key, add/remove/promote members, and manage every review. First admin is bootstrapped with SQL (`SR.adminSql(username)`, appended by the wizard's "Copy setup SQL").
- **External translators**: no account. They use `share.html?s=<id>#c=<{u,k}>` + the review password. Reviewer RPCs are the only ones granted to `anon`.
- **Disabling someone**: Remove in the portal, or Ban/delete in Supabase. `_member()` is evaluated on every RPC, so it takes effect immediately even while their token is valid; their next refresh/call shows the sign-in dialog and removes team-supplied keys from the browser.

### Security model
- Reports are encrypted in the browser (password -> PBKDF2-SHA256 600k -> 32 B AES-GCM key + 32 B proof; gzip first). The server stores only ciphertext and `sha256(proof)`; reviewer password lockout: 8 wrong -> 15 min.
- Team data (review titles, **review passwords**, the **team API key**) is stored server-side in plaintext and returned only to signed-in members through SECURITY DEFINER RPCs. So the Supabase project owner/admin could read them; outsiders cannot. (Earlier v3.x designs encrypted these under a shared passphrase; v4 replaced that with real accounts.)
- Tables `team_admins, team_members, team_keys, review_shares` have RLS on, no policies, and all rights revoked from `anon`/`authenticated`. Functions are revoked from `public, anon, authenticated` and then granted explicitly (Supabase pre-grants new functions to anon/authenticated, so `revoke ... from public` alone is NOT enough; the test stand-in mimics those default grants).
- Supabase security advisors: the `anon_/authenticated_security_definer_function_executable` WARNs and `rls_enabled_no_policy` INFOs are intentional.
- Session: access token + refresh token in `localStorage['sr_session']`, refreshed automatically (`SR.arpc`). Auth errors map to friendly codes (`bad_login, banned, signed_out, denied, forbidden, rate, not_confirmed, no_account`).

### RPCs (all `security definer`, `search_path = public`)
Reviewer (anon + authenticated): `share_info, share_open, share_save`. Team members: `team_whoami, team_keys_get, share_create, share_list, share_manage (creator or admin), share_applied`. Admin only: `team_keys_put, team_keys_clear, team_members_list, team_member_add, team_member_remove, team_member_admin`. Helpers (not callable): `_sha256, _member, _is_admin, _name, _share_check`.

### Client structure (index.html, section "Team workspace")
`SRK` keys (`sr_sb_url, sr_sb_key, sr_s1_done, sr_admin_user, sr_last_user, sr_seen`), `SRU` (signed-in user), `SRL` (shared review list), `srReady()`, `srSyncIdentity()`, `srAuthLost(e)`, `srOpenLogin/srDoLogin/srSignOut`, setup wizard (`srSaveAndTest, srPaintChecks, srCopySql`), share modal (`openShareModal, srCreateShare`), Reviews (`renderReviews, srRefresh, srManage`), feedback viewer + exports (`srOpenFeedback, srToggleApplied` = shared via `share_applied`), team (`teamPull` keeps a colleague's key in step with the team key; keys that came from the team are marked `sr_team_a` / `sr_team_o`, so a colleague's own typed key is never touched; `teamDrop` removes only team-supplied keys on sign-out), members UI (`teamLoadMembers, teamAddMember, teamRemoveMember, teamToggleAdmin`), workspace link `#team=<b64 {v:2,u,k}>` (public info only: URL + publishable key; no secrets) handled by `teamBoot/teamJoin`.
- Payload schema: `{v:1, kind:'proofread', title, language, pages, wordCount, createdBy, createdAt, note, issues:[{id,type,severity,page,loc,context,original,corrected,explanation,source:{label,text}}]}`. `loc`/`source` are reserved for translation-check issues. Issue ids can be numbers; the server returns applied keys as strings, so compare with `String(i.id)`.
- Decisions schema: `{v:1, reviewer, reviewers[], items:{id:{d:'agree'|'disagree'|'edit', t, c, at}}, updatedAt}`.

### Testing
Scratchpad (not in repo): a PGlite-based stand-in for Supabase (`pg_shim.mjs`: PostgREST RPC + Auth token/refresh/ban + default grants) and `acct_test.mjs` (156 checks: anon/stranger/member/admin rules, instant lockout, token refresh, reviewer flow, member management). Real-project checks done: function/table privileges via SQL, anonymous calls refused (401), sign-in error shape. NOT yet done on the real project: signing in with a real account (needs the user's admin account).

### Known gotchas
- Global `label {text-transform:uppercase}` in index.html leaks into new UI; override explicitly (`.sr-opt`).
- `.nav-badge[hidden]` and `#team-card[hidden]` need explicit `display:none` rules.
- Navigating a tab to the identical URL does not reload; use `location.reload()` when testing.
- Write tool turns `\uXXXX` escapes into literal characters (breaks regex literals for U+2028); use constants.
- Browser-pane screenshots can lag one step behind; confirm state with DOM reads.
- "Failed to fetch" / "Load failed" means the browser got NO answer from the AI provider (VPN/firewall/ad-blocker/DNS/offline), not a bad key or document. `callApiWithRetry` and `callOpenAI` retry brief drops 3 times (6/12/18 s) then throw `NETWORK: Could not reach <provider> (...)`; `netErrorHelpHtml` shows the steps; **Setup -> Test connection** (`apiProbe`, one 1-token request per saved key) tells connection, key and credit problems apart.
- **OpenAI + "Failed to fetch" is often a REJECTED KEY, not the network.** api.openai.com answers a rejected `POST /v1/chat/completions` (wrong key, restricted key, no credit/model access) WITHOUT a CORS permission header, so the browser hides the reply and reports a network failure (curl shows the real 401). `GET /v1/models` does carry the header even on 401, so `openaiDiagnose(key)` uses it to tell accepted / rejected / other / unreachable. `callOpenAI`, `tcCall` and **Setup -> Test connection** run it on the first network failure; anything but "unreachable" becomes a `KEY_PROBLEM:` error (`openaiKeyError`, `isKeyProblem`, `keyProblemHtml`) with key-specific steps, and only a truly unreachable OpenAI goes through the 3 retries and the connection dialog. Anthropic is not affected (its 401 is readable). Tested for real with a fake key from the browser pane and by `tests/openai-key.test.mjs`.
- "Could not read the reply" (JSON) errors: models sometimes leave quotes inside a value unescaped, put a raw line break in a value, add a trailing comma or answer in prose. At temperature 0 an identical retry repeats the same reply, so `parseClaudeJSON` now repairs these (`repairJSON`: escapes inner quotes/control characters, drops trailing commas; valid JSON is never altered), a retry adds a format reminder (`JSON_FIX_NOTE`), after 3 unreadable replies the chunk is split in half, then complete errors are salvaged (`salvageErrors`, recorded as unchecked) and only then does the run fail; the dialog (`jsonErrHelpHtml`) shows the model's real reply under "Technical detail". Anthropic `stop_reason: refusal` and OpenAI `finish_reason: content_filter` are treated like a content-filter block (split, then record as unchecked). Tested by `tests/proof-json.test.mjs` (the functions are cut out of index.html).
- Upgrading a database: re-run `supabase/setup.sql` (idempotent; it drops pre-v4 passphrase functions/tables).

## Translation check (v4.1.0)

**What it does:** compares a translation with its source document and reports omissions, additions, wrong meaning, wrong numbers/dates, terminology and untranslated text, with a score (fixed rubric) and a list the translator can answer through a review link. **The AI must account for every paragraph on both sides**; nothing may be silently skipped.

**UI (v4.1.4):** the Proof page opens with a two-way choice, **Proofread a document** | **Check a translation** (`setProofMode`, remembered in `localStorage.proof_mode`, `#proof-page[data-mode]` + `.only-proof` / `.only-tc` show only the steps of the chosen mode). Translation mode = 1 add the translation (main upload/paste box), 2 add the original (the `.docx`, `.idml`, `.pdf`, `.txt`, or a `.doc` that is really RTF), 3 settings; ONE primary button (`#proof-btn`, `runPrimary()` -> `tcStart()` in this mode). Earlier the translation check was a small optional card with its own button, and users pressed the big Proofread button, got a normal proofreading report and found the Translation tab empty -> confirm dialog (structure check, optional "only these chapters" for a cheap pilot, cost/time estimate, notes for the AI) -> **Translation** tab (score ring, chapter heat-map, coverage statement, filters, issues table, triage buttons, Continue after a stop/failure, exports CSV/Word/JSON, **Send to translator** = share link with `kind:'translation'`).

**Pipeline (tc-core.js):**
1. Read both into paragraphs (`rtfToText`, `parasFromText`, `parasFromPages` keeps IDML/PDF page numbers). Real binary `.doc` (OLE) is refused with a "Save as .docx" message.
2. `detectSections`: chapter headings = numeric-only line + title line, "Chapter N"/localized keyword, or "N. Title"; the longest 1,2,3... chain is kept (stray page numbers ignored). `matchSections` pairs by number, else by order, else falls back to a length-aligned whole-document run. `repairGaps` recovers a mistyped heading number. A chapter present on one side only becomes a Critical Structure issue without a model call.
3. `planWindows` -> one window per chapter (long chapters are cut at well-aligned points with Gale-Church length alignment `alignByLength`). `estimateRun` gives tokens/cost.
4. Per window the model gets numbered `[S1].. [T1]..` paragraphs and must return a compact `alignment` (`"2|2,3"`, `"3|"` = omitted, `"|9"` = added) covering EVERY paragraph exactly once, plus `issues`. `parseAlignment`/`readAnswer` validate it: incomplete -> retry with a note, then halve the window (also on truncation / content-filter); quotes must exist verbatim in the text or the issue is downgraded to a zero-point Query; omission locations come from the alignment, not the model's guess.
5. Every Omission/Addition claim gets a second look (`verifySystemPrompt`: is the content really absent anywhere in the other text?): false alarms are dropped, unsure ones become Query.
6. Rule-based checks add: changed/large numbers (not in front matter, no ISBN/phone-like), near-identical (untranslated) text, length outliers (all Query = zero points). Safety valve: if most paragraphs of a window have no counterpart the window collapses into ONE Structure issue instead of dozens of bogus ones. Chapters whose translation/source length ratio is far from the book's usual get a Structure Query.
7. Score: Critical 10 / Major 5 / Minor 1 / Query 0; `score = 100 - 4 x penalty per 1000 source words`; **Pass** >= 90 and no Critical, **Revise** 75-89 or any Critical, **Fail** < 75. False positives marked by the user leave the score. A chapter-limited run is labelled "Selected chapters only".
8. `buildReport` returns issues (locations `Ch N pP`, `after Ch N pP` for insertions, page numbers from the translation), per-chapter table and a coverage ledger (`complete` only if every window is done and no paragraph is unverified).

### v4.2.0 - second look at meaning and a tidier list (after comparing a real run with a single GPT prompt)

A real run on a long English -> German book manuscript (confidential: no client text belongs in this public repo) gave 51 findings; checking them against the text and against a single-prompt GPT report (19 findings) showed: the serious defect found, but ~40% noise (3 false number alerts from German `800.000`, 9 repeats, 11 wrong or unhelpful items, 7 explanations leaking window labels like "T11") AND 8 real meaning shifts missed (a duty's direction reversed, advising turned into deciding, an ambiguous reference, a lost qualifier, a term with a narrower legal scope, ...). Hence:
- **Number rule** (`numbersIn`): a dot between groups of exactly three digits is a thousands separator ("800.000" = "800,000"); both sides read the same way; `0.125` stays a decimal.
- **One problem, one finding** (`refineIssues`, run inside `buildReport`): an Omission + the "Addition" sitting where it should be -> one finding (`twin`); the same finding verbatim (pull-quote repeats) -> one finding with `also`; a recurring word choice -> one finding: the model gives `term_s` / `term_t` (kept only if both occur verbatim), same pair merges, then every aligned pair containing both words is listed in `also` (cap 80, `alsoCount`). Grouped findings count ONCE in the score.
- **Quiet tier**: type `Wording` / severity `Note` = acceptable rewording, weight 0, hidden by default (a "Notes" chip shows them), excluded from the share link and the Word report, kept in CSV/JSON. At most 3 per call from the model; an explanation that starts with "Acceptable ..." (`SELF_OK`) becomes a Note.
- **Calibration**: prompt says Major = meaning clearly changes (who acts, direction of a duty, what is asserted, role/authority, negation, key term wrong); a defensible different rendering is NOT Major; report a problem only if the suggested fix is clearly better; never write S12/T12 labels (and `relabel` turns any that slip through into real paragraph numbers).
- **Second look** (`ctx.second`, `meaningSystemPrompt`, `meaningPass`, `readMeaning`, `mergeSecond`): after the first check, every aligned pair of each window is judged again ("same" list + "differs" objects; EVERY pair must be in one of them: a missing pair is asked for once more, then counted as not judged). Findings both looks made get `second:'agrees'` (a Query becomes Minor); findings only the second look made are `origin:'ai2'`, capped at Major. A failing second look never fails the run (`coverage.meaningFailed`). Optional different model (`ctx.callModelSecond`, `TC_RUN.model2`; options only for models with a saved key; choosing another company sends both texts there too - the dialog says so). Tokens tracked separately (`state.sInTok/sOutTok`) so cost uses each model's price. Default ON in the confirm dialog, with its own cost line.
- Tests: `tests/tc-second.test.mjs` (invented lighthouse story, NOT client text: the repo is public). Dry run on the real report (deterministic parts only): 51 -> 41 findings.
- **NOT verified with a real model:** how the real models answer the new prompts (Wording notes, `term_s`/`term_t`, the second look). Re-run the Inside pair and compare with the GPT list before trusting the new numbers. The translation check's Anthropic calls now send `temperature: 0` (they did not before, so identical input gave different runs). `tc-core.js` is loaded as `tc-core.js?v=4.2.0` so a cached old engine cannot meet a new page: bump the query when the engine changes.

**Calls (index.html `tcCall`):** Anthropic or OpenAI model chosen on the Proof page; prompt caching on the system prompt; adaptive pacing (token budget per minute, halves after a 429 and waits `retry-after`, grows after successes); Stop button; resumable (`TC_RUN.state` survives errors; reload loses Continue but keeps the saved report: `proof_last_tc` 24 h + `proof_tc_history` last 6).

**Reviewer page:** `share.html` shows the source passage and location; `insert:true` issues render as "In the translation: Nothing here / Add this"; apply-list exports show "(insert after) ..." and "(delete this text)".

**Verified:** engine/rules/validation/stop-continue with a deliberately misbehaving fake model on a pseudo-translation with known defects (tests/tc-core.test.mjs); the REAL pair (English RTF 1,173 paragraphs vs Mongolian IDML 1,297 paragraphs / 306 pages) plans as 50 of 50 chapters matched, 54 windows, ~68 calls, ~$2 on Sonnet-class (~$0.5 Haiku), and every real window runs through the engine; full UI flow in the browser (confirm, run, stop, continue, 429 retry, bad key, filters, triage, exports, history, share to translator and back).
**NOT verified:** the real model's judgement quality on real Mongolian text (no API key in the build environment). Recommend a pilot on chapters 33, 36, 42 (a few cents) and checking its flags by hand before trusting a full run. Known limits: terminology consistency is checked only inside a window (not across chapters); scanned PDFs have no OCR; PDF paragraph reconstruction is heuristic.

### Ideas not built
Cross-chapter term glossary check, mechanical pre-pass, re-verify diff mode, InDesign Find/Change script, per-client glossary, proxy so the API key never reaches browsers.

---

## share.html (reviewer page) key facts

- Views: `#v-lock, #v-error, #v-review, #v-done`; overlays `#ov-welcome`, `#ov-submit`. Reads `s` (share id) from the query and config `c` from the hash.
- Wrong/withdrawn/expired/deleted links all end in the same neutral "This link is no longer available" message (no info leak about which).
- Filters (To review / Agree / Disagree / Edited / With comments / type / search), progress bar, keyboard shortcuts A / D / E / C / J / K, mobile layout, dark/light theme, RTL-safe context rendering.
- Older `proof_last_report` / `proof_supabase_*` flow is gone; the page no longer reads the creator's localStorage.
---

## Commit conventions

Use descriptive commit messages. Always add:
```
Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>
```

## Things that do NOT work / known limitations
- Urdu Nastaliq fonts: proprietary glyph maps — pdf.js cannot extract readable text; user is warned to paste manually
- Scanned PDFs: no OCR support; quality warning shown when < 10 words/page
- Very large files (>300k chars): user warned; Haiku recommended for rate-limit safety
- Opus 4.7 on large docs: very slow + expensive; confirm modal warns
