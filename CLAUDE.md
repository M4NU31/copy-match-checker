# CLAUDE.md — Copy Match Checker

Guidance for working on this project. Read this before editing.

## What this is

**Copy Match Checker** is a browser-based QA tool for the **Punch Toolkit**. It helps the
Production/QA team automatically compare **approved copy** (a PDF or Word document) against the
**content implemented on a live or staging web page**, and produces a structured report of
missing copy, mismatches, extra content, and CTA/link issues. (Acronym consistency checking
existed as a regex/dictionary feature and was **removed 2026-07-02** — noisy and dictionary-bound —
pending a proper AI-driven redesign in a future pass. Don't re-add the old regex version.)

The whole app is a **single self-contained file: `index.html`** (HTML + CSS + JavaScript embedded).
The UI, document parsing, and scaffolding filter run client-side, but **reading the live page and
comparing it against the approved copy are NOT optional client-side heuristics anymore** — both
require `serve.py` running with Playwright and an Anthropic API key. There is no offline/heuristic
fallback for those two steps by design (see "Comparison is 100% AI-driven" below) — if `serve.py`
isn't running, or the API key isn't set, the tool shows a clear error instead of silently degrading.

## Repository layout (single monorepo)

As of 2026-07-10 the whole tool is **one git repository**
(`git@github.com:M4NU31/copy-match-checker.git`) with `frontend/` and `backend/`
as subfolders. (It started as two separate repos on 2026-07-08 —
`copy-match-checker-front` / `-backend` — now consolidated; those two remain on
GitHub only as history.) Later this whole repo becomes **one folder inside a
larger "Punch Toolkit" monorepo that hosts multiple QA tools** — see "future
monorepo" notes; the rule there is the same as here: front and backend stay in
**separate subfolders**, never intermixed in one flat directory (or Cloudflare
Pages would serve backend files as static, and the build tooling breaks).

```
punch-copymatch-checker/            (monorepo root — origin: copy-match-checker.git)
├── CLAUDE.md                       ← This file.
├── README.md                      ← User-facing docs (Spanish), whole-tool.
├── .gitignore                     ← Root ignores (sample-decks/, .env, cruft).
├── sample-decks/                  ← Real client copy decks (PDF) for manual testing (GITIGNORED).
├── full-build-v0.4/               ← ARCHIVED advanced build (Google Docs OAuth, multi-URL,
│                                     history, dictionaries). Base for a future "Phase 2".
│                                     Do not wire it in.
├── frontend/                       Static front (Cloudflare Pages, and/or served by the VPS)
│   ├── index.html                 ← THE APP. Single file: HTML + <style> + <script>. Edit here.
│   ├── functions/api/[[path]].js  ← Pages Function: proxies /api/* to the backend + secret.
│   ├── wrangler.jsonc             ← Marks the Pages project (pages_build_output_dir).
│   ├── README.md · .gitignore
│   └── test/                      ← Sample-file generators + fixtures (stdlib Python only).
└── backend/                        API + Playwright renderer (VPS, root: Python + Chrome)
    ├── serve.py                   ← /render (Playwright), /ai/* (Claude), local static server.
    ├── .env                        ← ANTHROPIC_API_KEY, PROXY_SECRET, DATABASE_URL (GITIGNORED).
    ├── .env.example · .gitignore · README.md
    ├── DEPLOY.md                  ← Deploy runbook.
    ├── deploy/                    ← systemd unit + nginx config.
    └── Iniciar Copy Match Checker.bat  ← Windows one-click launcher.
```

There is **no build step**. Edit `frontend/index.html` directly;
the front reaches the backend via a `<meta name="api-base">` tag (empty =
same-origin/local dev). See `backend/DEPLOY.md`.

## How to run / test

- **Required:** `cd backend && py serve.py` then open `http://localhost:5500` — the backend also
  serves `../frontend/index.html` on localhost, so the whole tool runs same-origin exactly as
  before the split. Comparing against a live page needs this server (it renders the page with a
  headless Chrome and calls Claude). Opening `frontend/index.html` directly via `file://` still
  works for uploading/parsing the approved copy, but **Run QA Check will fail** with an explicit
  error, by design.
- **One-click:** double-click `backend/Iniciar Copy Match Checker.bat`.
- Put your key in `.env` (copy `.env.example`): `ANTHROPIC_API_KEY=sk-ant-...`. `serve.py` loads it
  itself (no `python-dotenv` dependency) and prints whether it found the key on startup.
- First-time setup: `py -m pip install playwright`. No `playwright install` needed — `serve.py`
  launches the machine's existing Chrome via `channel="chrome"`, not a separately-downloaded browser.
- Generate test fixtures: `py test/make_samples.py` and `py test/make_color_sample.py`.

Environment note: Windows, Python via the `py` launcher (real Python is at
`AppData/Local/Programs/Python/Python314`; the bare `python`/`python3` are Store stubs). No Node.

### Cache-busting / build marker

The footer shows a build tag, e.g. `build 2026-06-26n`. **Bump this string on every change**
(e.g. `…-26n` → `…-26o`). It lets the user confirm the browser loaded the new version after a
hard refresh (`Ctrl+Shift+R`). Stale cache has repeatedly been mistaken for bugs, so `serve.py`
also sends `Cache-Control: no-store`.

## Architecture of `index.html`

Order in the file: `<style>` → HTML body → `<script>`. The script has clearly commented sections.

### 1. Document parsing (approved copy → blocks)

- **PDF** — `parsePdf(buf)` (pdf.js) returns `{pdf, lines, text}`. `lines` are visual lines with
  `{page, str, x0,y0,x1,y1}` bounding boxes (used by the "View"/locate feature AND by reflow, next).
  `reflowLines()` rejoins wrapped lines into paragraphs: a line is a continuation of the previous
  one when the previous doesn't end in sentence punctuation, and either the next starts lowercase,
  OR — using the bounding boxes — the vertical gap between them is small enough to be normal
  line-wrap spacing rather than a paragraph/heading break. The bounding-box check exists because a
  wrapped **Title Case headline** ("On-Prem Keys for" / "Cloud Data", "...Bowie State University
  for M.A.P." / "Program") doesn't start lowercase, so the text-only rule alone left an orphaned
  one- or two-word "line" that polluted page-title detection and showed up as its own bogus
  approved-copy block — found across several real client decks (TST, Diaconia) with narrow-column
  PDFs that wrap mid-heading constantly. The bounding-box check is skipped (never merges) for a
  bullet/page-number stamp ("• • 17") or a bare URL slug ("/who-we-are") sitting right under a
  heading — neither is ever a genuine continuation even when vertically tight.
- **DOCX** — `parseDocxStructured(buf)` (JSZip) reads `word/document.xml` directly to get, per
  paragraph, its **text + color** (green vs pink/red) and whether it lives inside the **SEO/Yoast
  table**. Falls back to `parseDocx` (mammoth, raw text) if that throws.
- `handleFile(file)` dispatches by extension and returns
  `{rawText, raw, regionSEO, docKind:'pdf'|'docx', pdf, lines}`. `raw` is the flat pre-scaffold
  `{text,kind}` list for the WHOLE file — scaffolding isn't filtered yet at this point, because
  page segmentation (next) needs those signals (Page Goal/SEO box/breadcrumb) to find page
  boundaries. `loadFile()` stores the parse results, then segments, then filters (see below).

### 2. Page segmentation — which page in the doc am I comparing? (`segmentPagesWithClaude`)

Approved-copy decks often bundle the copy for an **entire site** into one file, with no fixed,
consistent marker between pages. Two strategies, tried in order:

1. **`deterministicPageSplit(raw)`** — many client decks paste a repeating SEO/Yoast box
   (`PAGE_BOX_OPEN_RE`, a narrower cousin of `SEO_TRIGGER` that matches only the box-*opening*
   line, not every field inside it) right after each page's name/breadcrumb. When that marker
   repeats 2+ times, its positions ARE the page boundaries — free, instant, and 100% consistent
   between runs, unlike asking an LLM to guess from prose. `titleFor()` walks back up to 10 lines
   from each marker to find the readable name/breadcrumb, skipping noise via `isTitleNoiseLine()`
   (`Page Goal(s):`/`Goal CTA(s):`, the `AddSomePunch.com` watermark, page-number/bullet lines,
   `Footer` markers, `[[Double Bracket]]`/`[X] | [Y]` markup, `Tab N`/`Copy of Tab 1` placeholders)
   and preferring a real name over a bare URL slug for the label. (An earlier version's narrower
   skip-list latched onto stray page numbers like `23` as the page title on a real Fortreum deck;
   another bug used `raw[start].text` — the boundary line itself — as the displayed title instead
   of the label `titleFor()` actually computed, so when no clean name turned up in the window, the
   title silently showed whatever noise line the scan stopped on, e.g. `"Page Goal: provide gateway
   for detailed technology pages"` on a real Victus deck, instead of falling back to `"Page N"` as
   intended — both fixed by comparing several real client decks side by side. A third bug: Fortreum's
   own template placeholder line — `"Sub Page Name > Sub-sub page name if needed"`, left unfilled on
   two real pages — is itself shaped exactly like a real breadcrumb (`Text > Text`, short, no ending
   punctuation), so the scan stopped there and never looked further back to the actual name
   (`Company>About Us`, `Services>CMMC`). Both pages' content was always grouped correctly; only the
   *label* was wrong, hiding them from view under a confusing shared title. Fixed by recognizing that
   exact placeholder as noise too.)
2. **Claude** (`POST /ai/segment-pages`, `SEGMENT_SYSTEM_PROMPT` / `SUBMIT_PAGES_TOOL` in
   `serve.py`) — used only when the deterministic check finds fewer than 2 markers, i.e. the
   document doesn't follow that template. The prompt is deliberately biased toward returning
   **one page** unless there's a clear, repeating identity marker — an early version over-split
   single-page documents just because the intro/body/CTA read as "different topics." `serve.py`
   also defends (`_coerce_list_field`) against an occasional model quirk where a tool argument
   (`pages`, or `issues` in §5) comes back double-JSON-encoded as a string instead of an array.

Both paths land in the same shape: `{title, start_line, end_line}` per page — `pageOwnName()`
reduces a breadcrumb-shaped title to just its last segment (`"Platform>XRAMP>Pricing"` →
`"Pricing"`) before it's ever shown, since the parent lineage is disambiguation for segmentation,
not the page's actual name a reviewer recognizes. Document front matter (a cover/title block, an
index/TOC, a sitemap/site-navigation listing) is never returned as a page at all — not hidden,
not selectable, dropped entirely — because it's never site content: `deterministicPageSplit`
simply never creates a page for whatever precedes the first marker, and `SEGMENT_SYSTEM_PROMPT`
tells Claude to skip it the same way for the non-deterministic path.

`expandEmbeddedPages()` then runs over EITHER path's output looking for a page that actually
contains two pages stapled together — not every page in a deck carries the deck's own marker; a
partner's co-marketing page (or anything pasted in from elsewhere) can sit inside another page's
boundaries with none of the usual signals. `findEmbeddedPageSplit()` uses the same tell a human
reviewer does: a short (1-3 word) Title Case name that was **never mentioned earlier** in that
page suddenly appears, and the name repeats **4+ times in the next 20 lines** — dense, sudden
self-reference is real evidence of a new page even with zero structural markers, whereas a
content-free label like "Tab 1" (nothing follows it, or nothing that repeats it) correctly isn't
evidence of anything. (Found on a real Fortreum deck: an embedded "Kovr" partnership page, with no
SEO box of its own, was silently swallowed into the tail of "Company>Accreditations" until this
existed — checked against all ten decks studied so far for false triggers from a heavily-repeated
name like "Diaconia" or "The Swift Group"; none fired, since that name is already established
earlier on those pages, failing the "never mentioned before" requirement.)

Each remaining page's raw slice is then run through `buildApprovedBlocks(slice, regionSEO)`
independently (scaffolding filtered per-page, so one page's SEO box can't swallow another page's
heading). Results land in `state.pages = [{title, blocks, rawCount}]`.

- If only **one page** is detected, the picker (`#pageSelectField`, in the "Page to Compare" card)
  stays hidden and that page's blocks are used automatically — zero extra clicks for the common
  single-page case.
- If **multiple pages** are detected, the picker shows just `"<title>"` per page (no block count —
  that's an internal sanity-check number, not something a reviewer needs to see to pick a page).
  Switching it re-points `state.approvedBlocks` at that page's blocks and syncs the **Page Name**
  field (only on an explicit switch — the initial auto-fill won't clobber a name the user already
  typed).
- If the endpoint fails (server down, no API key, bad response), segmentation falls back to a
  single **"Full document"** page — upload still works, it just can't offer a picker. This is an
  explicit degraded state, not a silent one (`splitFailed: true` flows into the status message).

### 3. Scaffolding filter — what to DROP from the approved doc

Approved docs contain a lot of production-only content that must NOT be treated as page copy.
Two mechanisms:

- **`scaffoldByPattern(t)`** — pattern matches for: SEO/Yoast labels & wrapped char-count
  fragments; intro/meta (`Page Goal(s):`, `Goal CTA(s):` — plural allowed, some client decks use
  "Goal CTAs:" for multiple buttons; slug `/cmmc`; breadcrumb `Services > CMMC`; single-word
  labels); annotations `[Card 1]`, `[[Overview Page]]` (double-bracket page markers, e.g. a Two Six
  deck that uses `[[TrustedKeep Page]]` instead of an SEO box), `[Home] | [Capabilities]`
  (pipe-separated bracket footer quick-links), `Tab 1`, bullets `• • 1`; table-of-contents/index
  (headers, dot-leaders + page numbers, `Page 3`); nav/sitemap (`About Link`, `Data Products Link
  Link`); global `Footer`/`Header` markers; `Copy of Tab 1`; Punch's own **`AddSomePunch.com`**
  watermark (seen stamped on every page of multiple clients' drafts, alone or combined with an
  address/email line); `//` internal comment lines, including one **glued onto a breadcrumb by the
  PDF's own line layout** rather than sitting on its own line (`"Technology>How It Works //Already
  in High Value Pages Doc"` on a real Victus deck — matched by looking for `" //"` anywhere in the
  line, not just at the start); bare page numbers (`23`, `33 (Footer)`) — found by comparing ten
  real client decks (Credence, Fortreum, Muon, Copia, DFIR Report, Diaconia, Swift Group, TST,
  Victus) side by side, see git history / session notes for the analysis.
- **`buildApprovedBlocks(raw, regionSEO)`** — orchestrates. It also handles **regions** (SEO box,
  index, nav) that swallow following short lines, plus color-based kinds. Produces the final
  approved block list. Each block has a `kind`:
  - `normal` — real copy to compare. May carry `.alt` (its green alternate).
  - `alternate` — standalone green text.
  - `cta` — a button. `[Label] (/url)` / `[Label] /contact` / `[Label] (note)`. The BUTTON is only
    the bracket text; the parenthetical/trailing token is the link (verified) or a free-text note,
    never page copy. Detected by `CTA_BRACKET_RE` + `parseCtaNote`. **May also carry `.alt`** — a
    green alternate applies to any element type (heading, paragraph, or a CTA's own label), not
    just body copy; the pairing logic isn't restricted to `kind==="normal"` for this reason (a real
    client deck used a shorter green alternate for a button label specifically).
  - Pink (`instruction`) and scaffold blocks are dropped entirely.
  - **Color only survives from `.docx`.** A PDF loses text color entirely, so a PDF's green
    alternate has no signal distinguishing it from an ordinary adjacent paragraph — it arrives as
    a second `normal` block with no `.alt` link at all. `COMPARE_SYSTEM_PROMPT` (serve.py) covers
    this gap: it asks Claude to also recognize an *unmarked* long/short pair from meaning alone
    (two adjacent blocks unmistakably restating the same message) and apply the same "only one
    needs to be live" rule, so a PDF's alternate copy doesn't produce a false Missing Copy for
    whichever version isn't live.

### 4. Page extraction (URL → page blocks)

- **`fetchPageHtml(url)`** — calls **`serve.py`'s `/render?url=...`** ONLY (same-origin). No raw
  `fetch()` / public-proxy fallback: those return pre-JavaScript HTML and would silently reintroduce
  false "Missing Copy" results for content the site injects client-side. If the tool isn't running
  over `http(s)` (i.e. opened via `file://`), or `/render` errors (server not running, Playwright not
  installed, page timeout), it throws a clear, actionable error — it does not degrade quietly.
- **`extractVisible(html, scope)`** — parses into a detached DOM, strips `script/style/svg/iframe`,
  then, in order:
  1. **`stripHiddenMarkup(doc)`** — drops anything hidden by markup alone: inline
     `display:none`/`visibility:hidden`, the `hidden` attribute, or a common hidden-utility class
     (`sr-only`, `d-none`, `elementor-hidden`, …). Content hidden only via an *external stylesheet*
     (an inactive tab panel, a closed accordion) can't be caught this way — DOMParser never loads
     CSS. On a real Credence page this was the only thing keeping a hidden tab's entire standalone
     SMS privacy policy (TCPA/CCPA/GFE/etc.) out of the comparison. Deliberately does **NOT** touch
     `[aria-hidden="true"]`: that attribute commonly marks content that IS visible on screen but
     redundant for screen readers (e.g. a letter-by-letter text-reveal animation, with the "real"
     accessible label given elsewhere via `aria-label`) — an earlier version removed it on sight,
     which hid three genuine CTA button labels ("Learn More", "Request A Demo", …) on a real Victus
     page (another Avia-themed site) because that's exactly how Avia builds its animated buttons.
  2. Removes `nav`/`footer` unless `scope.nav`/`scope.footer` — **both** the semantic tags AND
     (`stripByRole`) any element whose class/id contains "nav"/"menu"/"footer" as a whole word,
     since page-builder themes often build the real menu/footer without the semantic tag at all
     (WordPress/Avia's mega-menu is a plain `<div id="header"><div class="avia-menu ...
     av-main-nav-wrap">` — a tag-only selector misses it, silently pulling the entire site's page
     tree — contract-vehicle names, legal links, etc. — into the comparison). `stripByRole` never
     touches `<html>`/`<body>` themselves: some themes stamp broad layout-config classes there
     (`html_main_nav_header`, `html_menu_right`) that describe a *preference*, not a menu to strip.
  3. Scans the **whole remaining `<body>`** (deliberately NOT scoped to `<main>`/`<article>` — tried
     and dropped: real sites mark up more than one `<main>`, or put genuine body copy in a wrapper
     that sits outside any `<main>` at all; both silently dropped most of the page on real client
     sites). Collects text from `h1–h6, p, li, …` **and the DIRECT text of `div/span/label/…`**
     (eyebrows, labels, page-builder text that isn't in semantic tags — important: many marketing
     sites put copy in `<div>`). Also extracts CTAs and links. De-dups.
- **`stripDecorativeIcon(t)`** — applied to every button/link label (the CTA collector, the link
  collector, and `button`/`a` entries in the main block collector — never headings/paragraphs).
  Strips a leading or trailing decorative arrow/chevron (`→ ➜ ➔ ➤ ▶ ► » › ➡ ⇒ ⟶ ↠ ⇾` or ASCII
  `->`/`-->`). A real button's accessible text is "Talk to an Expert", not "Talk to an Expert →" —
  without this, the arrow (common on marketing sites for "Learn More →"-style buttons) made an
  exact-label CTA look unmatched and got reported as a missing/wrong button on a real Fortreum
  page. The CTA selector list also matches `a[class*=btn]` now (not just the exact class `.btn`),
  since Bootstrap-style `btn-primary`/`btn-secondary` naming is common and wasn't caught before.
- **`detectCms(html)`** — WordPress / HubSpot / Static.

### 5. Comparison — 100% AI-driven (`compareWithClaude(approvedBlocks, page)`)

There is no text-similarity heuristic deciding matches. `compareWithClaude()` posts the full
approved-block list and the full page-block list to **`serve.py`'s `POST /ai/compare`**, which
calls the Claude Messages API (model from `ANTHROPIC_MODEL` env var, default `claude-sonnet-5`)
with a forced `submit_comparison` tool call (see `COMPARE_SYSTEM_PROMPT` / `SUBMIT_COMPARISON_TOOL`
in `serve.py`) and gets back the full issue list + a 0–100 score in one shot. Claude decides:
  - **normal (+ optional green `alt`) — gray/green rule:** the green alternate REPLACES the full
    (gray) copy; only one should be live. → **Error only when BOTH appear on the page as separate
    blocks** (same section). If only the gray is live → OK. If only the green is live → OK
    (Observation, not missing). If neither → Missing Copy.
  - **cta:** the button label must be on the page; if a URL was given, the link target is verified.
  - Reworded-but-present copy → Copy Mismatch. Entirely absent → Missing Copy. The bar for "reworded"
    is deliberately low: only whitespace/capitalization differences are waved through as a match —
    any actual wording change (a swapped word, an added phrase, a changed number/punctuation mark),
    however small, is reported. A production reviewer wants every discrepancy surfaced, even minor
    ones, rather than have the model decide it "basically" matches and stay quiet.
  - These two types are mutually exclusive by construction — "Copy Mismatch" always carries the
    page's real text in `current`; "Missing Copy" is always `current: "-"` — and `serve.py`'s
    `_fix_issue_type_consistency()` coerces the type to match `current` as a backstop after every
    `/ai/compare` call. Without it, an occasional mislabel (a genuinely-absent sentence returned as
    "Copy Mismatch" with `current: "-"`) surfaces under the wrong summary-tab filter, which reads to
    a reviewer scanning tab-by-tab as "sometimes it catches this, sometimes it doesn't" when Claude
    actually caught it every time — it just filed the finding under the wrong drawer.
  - Whether an approved block that survived the JS scaffold filter is actually still an internal
    note (a second, semantic check on top of `scaffoldByPattern`) — if so, Claude omits it rather
    than reporting Missing Copy/CTA Issue for something that was never meant to be on the page.
- **Extra Section** — page blocks Claude judges don't correspond to any approved block (and aren't
  obvious boilerplate like cookie banners/nav).
- Mechanical checks stay local/regex, NOT sent to Claude (`mechanicalAndLinkChecks()`): **Typo**
  (repeated word), **Spacing Issue** (double space), **Punctuation Issue** (space before
  punctuation), **Link Review** (placeholder hrefs) — these are text hygiene, not a comparison
  judgment call.
- **Score** comes directly from Claude's response (`data.score`), not computed client-side.

Issue types: `Missing Copy`, `Copy Mismatch`, `Extra Section`, `CTA Issue`, `Observation`,
`Typo`, `Spacing Issue`, `Punctuation Issue`, `Link Review`. Priorities: `High`, `Medium`, `Low`,
`Info` (observations only). Observations are NOT counted as errors.

### 6. UI & rendering

**Acronym checking is removed for now (2026-07-02).** It existed as a regex/dictionary feature
(`checkAcronyms`, `ACRONYM_DICTIONARY`, an "Acronym Review" table, an "Acronyms" scope checkbox and
summary card) — pulled because it was noisy (flagged any 2+ capital-letter token not in a small
hardcoded dictionary, e.g. "AI", "SCROLL") and dictionary-bound. A proper AI-driven redesign is
planned for a future pass; don't resurrect the old regex version piecemeal.

- Inputs: **1. Approved Copy** (Site Name, Page Name, PDF/DOCX upload) · **2. Page to Compare**
  (Page URL, the page picker from §2 when the doc has multiple pages, **Scope** checkboxes =
  Content / CTA / Links → which checks to include) · **Run QA Check**.
  - **Site Name auto-fill** (`guessSiteName(url)`): on blur of Page URL, best-effort-guesses the
    Site Name from the URL's hostname (first label, stripping a `-dev`/`-staging`/`-test` env
    suffix, `www.`, Title-Cased) — e.g. `fortreum.com` → `Fortreum`. Only fills the field when
    it's empty; never overwrites a name already typed, same "don't clobber manual input"
    convention as the Page Name auto-fill in §2. It's a rough guess, not a lookup — concatenated
    multi-word domains (`theswiftgroup.com`) or odd staging hosts
    (`muonspaceddev.wpenginepowered.com`) won't split into clean words; the user edits it if wrong.
- **Run QA Check doubles as Cancel** while a check is in flight (`state.isRunning`,
  `state.runCtrl`): the button's label/icon swap to "Cancel" and it stays clickable (not
  `disabled`) instead of being locked out during the run. `fetchPageHtml()` and
  `compareWithClaude()` both run on the SAME shared `AbortController` (`state.runCtrl`) rather
  than their own private one, so a user-triggered `abort("cancelled")` interrupts whichever phase
  is currently in flight; each function's own timeout (`45s`/`120s`) also aborts that same
  controller with reason `"timeout"`, so the two cases are told apart by `signal.reason` and
  surfaced with a distinct message ("Cancelled by user." skips the failure `alert()` — just a
  quiet toast + `#runNote` — vs. the existing timeout/error alert).
- **Summary cards double as the filter tabs** (`#summaryTabs .tab-stat`, `setActiveTab`): click a
  card to filter the issues table; the active card gets a pink border; hover lifts the card. Numbers
  are `#FF1449`; labels are weight-500 `#E8E2DF`. There is no separate tabs row.
  - **Match Score and the tab counts move live as issues are resolved**, without a re-run.
    `countType()`/`renderSummary()` count only OPEN issues (`!state.done.has(issueId(i))`), so a
    tab's number drops the moment a row is marked Done and rises again on Undo. The Match Score
    Claude returns is a one-time snapshot (`state.score`); the displayed score (`liveScore()`)
    interpolates linearly from that snapshot up toward 100% as the fraction of resolved
    error-type issues (Observations excluded) grows — 0 resolved shows the original score exactly,
    all resolved shows 100%. This is a progress indicator assuming "Done" means the team actually
    fixed it live, not a re-verified score — the tool never re-fetches/re-compares on Done/Undo.
- **Issues table** columns: Section · **View** (magnifier) · Issue Type · Approved Copy · Current
  Page Copy · **Observations** · **Done**. No Priority column (that lived only in the now-removed
  Acronym table — `.badge`/`.badge-High` etc. and `.col-pri` were deleted alongside it). The
  "Observations" column (labeled "Suggested Fix" until this session) holds whatever Claude put in
  the issue's `fix` field — the JS/JSON field name is unchanged, only the label shown to the user
  and in CSV/Copy Report exports — since a reviewer wants a plain description of the discrepancy
  there as often as an actionable instruction.
  - **Done button** is an outline pill: pink `#FF1449`, labeled **"In progress"** → click marks
    resolved, dims the row, moves it to the bottom, relabels to green `#15a37a` **"Done"** (click
    again to undo). State lives in `state.done` (a Set keyed by `issueId`); toggling it also
    re-renders the summary cards (previous paragraph), not just the table.
  - **View magnifier** (`locateIssue`) previews where the copy is in the document: for a PDF it
    renders the page to a canvas and paints a pink highlight over the matched line(s) (with a
    timeout → falls back to a text view + page number, because pdf.js canvas render doesn't work in
    the headless preview but works in real browsers); for DOCX it shows the doc text with the block
    highlighted.
- Exports: **Export CSV** and **Copy Report** (issues only, since Acronym Review is gone).

### Color palette (CSS variables, dark theme)

Accent is **`#FF1449`** (`--pink`; hover `--pink-2` `#ff476f`; dark gradient end `#b30e33`).
Also `--bg #0a0a0c`, `--card #161519`, `--input #0c0b0e`, `--border #28272e`, `--amber #f5a524`,
`--slate #7c8aa5`, `--blue #5b8cff`, `--green #2fd6a6`; the Undo green is `#15a37a`; summary label
color is `#E8E2DF`. If the accent changes, update `--pink`, `--pink-2`, the gradient end, and any
literal `#FF1449` / `rgba(255,20,73,…)` occurrences together.

## `serve.py`

No longer stdlib-only — it now depends on **Playwright** (`pip install playwright`) and calls the
**Anthropic API** (stdlib `urllib`, no `anthropic` SDK). Loads `.env` itself on startup (a ~15-line
hand-rolled parser, not `python-dotenv` — keeps the one real dependency to just Playwright) and
prints whether the API key and Playwright were found. Endpoints:

- `GET /fetch?url=...` — raw server-side fetch (no JS execution). Kept for reference/debugging;
  the app itself no longer calls it (see `fetchPageHtml()` above).
- `GET /render?url=...` — `render_page(url)`: launches the machine's installed Chrome via
  Playwright (`channel="chrome"`, so no extra ~300MB browser download), navigates with
  `wait_until="networkidle"`, and falls back to a fixed 2.5s wait if the page never goes idle
  (chat widgets/analytics beacons that poll forever). Returns `page.content()` — HTML with
  JavaScript already executed. Returns 501 with an actionable message if Playwright isn't installed.
- `POST /ai/compare` — `call_claude_compare(payload)`: sends `{approved_blocks, page_blocks,
  page_ctas, page_links}` to the Claude Messages API with `COMPARE_SYSTEM_PROMPT` and a forced
  `submit_comparison` tool call; returns `{issues, score}`. Returns 502 with the error message
  (including Claude API error bodies) if `ANTHROPIC_API_KEY` is missing or the call fails.
- `POST /ai/segment-pages` — `call_claude_segment(lines)`: sends the approved doc's raw
  (pre-scaffold) lines, numbered, to the Claude Messages API with `SEGMENT_SYSTEM_PROMPT` and a
  forced `submit_pages` tool call; returns `{pages: [{title, start_line, end_line}]}`. Biased
  toward returning one page unless a real repeating page-identity marker is present (see
  index.html §2 above).

`end_headers` injects `Cache-Control: no-store`. Runs on port 5500 (override: `py serve.py 8080`).
Console output must stay ASCII (Windows cp1252 crashes on non-ASCII like `→`).

## Conventions & gotchas

- **Single file, dense JS.** The `<script>` uses compact one-liner style. Match it. No frameworks,
  no bundler.
- **Bump the build marker** in the footer on every change (cache verification).
- Libraries load from cdnjs: pdf.js, mammoth.js, JSZip. Keep them.
- **Color coding only works in `.docx`** — PDF loses text color, so green/pink rules degrade to
  pattern-only there. Recommend `.docx` for color-coded copy docs.
- **Comparison has no offline fallback, by design.** Reading the live page and comparing it against
  the approved copy both require `serve.py` + Playwright + `ANTHROPIC_API_KEY`. This was a deliberate
  call: a silent heuristic fallback previously produced false "Missing Copy" results for JS-rendered
  content, which is exactly the bug this architecture removes. Don't reintroduce a text-similarity
  fallback path without discussing it first.
- **Never commit `.env`** (already gitignored). `ANTHROPIC_API_KEY` lives there or as a real env var
  — never in `index.html`, which is client-side JS.
- **Do not re-add the archived `full-build-v0.4/` features** (Google Docs, multi-URL, history,
  dictionaries) unless explicitly asked — they belong to a future phase.
- When verifying in the preview: pdf.js **render** hangs in the headless preview (guard it with a
  timeout); everything else (parsing, DOM) verifies fine there. Driving the actual Run QA Check flow
  (upload → render → AI compare) needs a real browser — Playwright itself (already a project
  dependency) can drive one headlessly for this; see how the feature was verified in git history /
  session notes if you need a repeatable script.

## Current phase

**Phase 1 (MVP), single-file**, now with an **AI-driven comparison core**: PDF/Word upload ·
multi-page document segmentation (§2) · JavaScript-rendered URL fetch (Playwright) · visible-text
extraction · Claude-driven copy comparison (no text-similarity heuristic) · structured report ·
CSV/report export · in-document preview. Acronym consistency checking is **removed for now** (see
§6) pending an AI-driven redesign — not in scope until that redesign lands. Also out of scope:
Google Docs integration and comment review (Phase 2, archived).
