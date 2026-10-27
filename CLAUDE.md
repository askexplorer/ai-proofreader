# Explorer AI Proofreader — Project Memory

## What this project is
Single-file browser app for professional AI-powered proofreading. Powered by Anthropic Claude API (direct browser → API calls). No backend, no server — pure client-side HTML/JS/CSS.

**Live repo:** github.com/askexplorer/ai-proofreader (remote `askexplorer`; the old `origin` = shakkeer-cloud is retired)  
**Live site:** https://askexplorer.github.io/ai-proofreader/ (GitHub Pages, serves `master`)  
**Branch:** master  
**Current version:** v3.6.0

---

## Files

| File | Purpose | Lines |
|---|---|---|
| `index.html` | Main app — all logic, UI, CSS in one file (incl. creator-side sharing UI: Setup wizard, Share modal, Reviews tab) | ~4400 |
| `share.html` | Reviewer page — opened from a share link, password-gated, Agree / Disagree / Edit per issue, autosave, Submit | ~620 |
| `share-core.js` | `window.SR` — E2E crypto + Supabase RPC client shared by index.html and share.html | ~240 |
| `supabase/setup.sql` | One-time DB setup for the user's own Supabase project (locked tables + SECURITY DEFINER RPCs) | ~250 |
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

## Review sharing (v3.5.0) — architecture and security model

Flow: creator presses **Share for review** on a report -> issues are encrypted in the browser -> link + password sent to translator/proofreader (in two separate messages) -> reviewer opens `share.html?s=<id>#c=<base64url {u,k}>`, enters name + password, decides on each issue (Agree / Disagree / Edit + comment), autosaves, presses **Submit** -> creator sees a badge on the **Reviews** tab, opens feedback, exports an apply-list (Word landscape / CSV) for layout and ticks items off.

- **Zero-knowledge:** password -> PBKDF2-SHA256 (600k iterations, `KDF_ITER`) -> 64 bytes = AES-GCM key (32 B) + `proof` (32 B hex). The server only ever stores `sha256(proof)` and ciphertext (payload is gzipped via CompressionStream first). The password never leaves the browser.
- **Database:** user's own Supabase project. Tables have RLS on with no policies and all rights revoked from `anon`/`authenticated`; everything goes through SECURITY DEFINER RPCs (`share_create, share_info, share_open, share_save, share_list, share_manage`) that RETURN an error jsonb instead of raising, so failed-attempt counters persist.
- **Brute-force limits:** reviewer link locks 15 min after 8 wrong passwords (also for the correct password while locked); creator secret (hash in `app_config.creator_hash`) locks 10 min after 20 wrong tries. Expiry <= 90 days, expired rows purged after 14 days.
- **Creator passphrase:** typed in Setup step 2, kept only in this browser's localStorage (`sr_creator`). It is shared by the whole team. It is **never sent to the server**: `SR.creatorToken()` derives a 256-bit token (PBKDF2, salt `.../creator/auth/v1`) that goes out as `p_creator`, and `SR.creatorSql()` registers sha256(token). A second, independent derivation (salt `.../creator/team/v1`) gives the AES key that encrypts team secrets, so Supabase can never derive it.
- **Connection config** (Project URL + public anon/publishable key) travels inside the link fragment `#c=` (fragments are not sent to servers). Legacy JWT keys also get an `Authorization` header; `sb_publishable_` keys must not.
- **Concurrency:** version-based optimistic locking in `share_save`; client merges (newest `at` per issue wins).
- **localStorage keys (index.html):** `sr_sb_url, sr_sb_key, sr_creator, sr_shares, sr_verified, sr_s1_done, sr_applied_<shareId>, sr_team_a, sr_team_o` (the last two = `'1'` when that browser's Anthropic/OpenAI key came from the team). `srReady()` needs URL+key+creator and `sr_verified==='1'` (set by Save & test connection).
- **Payload schema:** `{v:1, kind:'proofread', title, language, pages, wordCount, createdBy, createdAt, note, issues:[{id,type,severity,page,loc,context,original,corrected,explanation,source:{label,text}}]}`. `loc` and `source` are reserved for translation-check issues ("Ch 33 - para 7", source-language text).
- **Decisions schema:** `{v:1, reviewer, reviewers[], items:{id:{d:'agree'|'disagree'|'edit', t, c, at}}, updatedAt}`.
- **Tested** against a PGlite (real Postgres) stand-in for Supabase: 40/40 SQL tests (anon blocked on direct table access, lockouts, expiry, conflicts, reopen/revoke) plus full browser E2E (wizard, share, reviewer, submit, feedback, exports, withdraw).

### Team access (v3.6.0): one shared API key, colleagues type nothing
- **Admin** (Setup tab, "Team access" card): types the API key in the API card, presses *Save API key for the team* -> `SR.putTeamKeys()` encrypts `{v,a,o,by,at}` with the creator-derived AES key and stores it in `team_secrets` (RPCs `team_put / team_get / team_clear`, all gated by `_creator_ok`). Then *Create team link*.
- **Team link** = `index.html#team=<base64url {v:1,u,k,c}>` (Supabase URL, public anon key, shared creator passphrase). The API key is NOT in the link when Supabase is ready. Fallback when Supabase is not set up: link carries `{a,o}` itself.
- **Colleague:** opens the link -> `teamBoot()` strips the hash immediately, validates, shows a confirm modal (host + masked key; warns when it replaces an existing key) -> `teamJoin()` saves the connection, verifies it, then `teamPull()` fetches + decrypts the team key into `proof_api_key` / `proof_openai_key`.
- **Sync:** `teamPull()` runs 2.5 s after load and every 3 min. It only overwrites/removes keys marked `sr_team_a/o`; a colleague's own typed key is never touched. Rotation propagates automatically; *Remove team key* deletes team-sourced keys on the next pull.
- **Honest limits:** the key still lives in each colleague's browser (devtools can read it), so use a dedicated Console key with a monthly spend limit and rotate it when someone leaves. A claude.ai subscription cannot be used as an API key. The creator lock (20 wrong tokens -> 10 min) is team-wide, and the anon key is public, so an outsider could lock the team out of creator actions for 10 min (key stays cached in each browser). Upgrade path if keys must never reach browsers: a Supabase Edge Function / Cloudflare Worker proxy holding the key.
- **Upgrading an existing database:** re-run `supabase/setup.sql` (idempotent) to add `team_secrets` + RPCs.
- Tests (scratchpad, not in repo): SQL 40/40, core 38/38, team 25/25 against PGlite; browser E2E of admin save, link, join, rotate, remove, own-key, bad link, cancel, fallback.

### Known gotchas
- Global `label {text-transform:uppercase}` in index.html leaks into new UI; use `.sr-field > label.sr-opt`-style overrides.
- `.nav-badge[hidden]` needs an explicit `display:none` rule.
- Navigating a tab to the identical URL does not reload; use `location.reload()` when testing.
- Write tool turns `\uXXXX` escapes into literal characters (breaks regex literals for U+2028); use constants.

### Still to build (agreed scope)
Translation check: optional source-document upload (DOCX/RTF/IDML/TXT; the user's real source `.doc` is actually RTF), chapter-aligned compare for missing/added text, translation quality score (Critical 10 / Major 5 / Minor 1 / Query 0; score = 100 - 4 x penalty per 1000 words; Pass >= 90 and 0 Critical, Revise 75-89 or any Critical, Fail < 75), a "Translation check" report tab, and Word-vs-Word sharing to the translator before layout.

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
