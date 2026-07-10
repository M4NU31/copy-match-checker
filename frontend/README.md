# Copy Match Checker - Frontend

Static front for the Punch Toolkit's Copy Match Checker. Single self-contained
`index.html` (HTML + CSS + JS): document parsing (PDF/DOCX -> copy blocks),
scaffolding filter, page picker, results UI, and exports. Deploys to Cloudflare
Pages.

## Backend dependency

Reading a live page and comparing it against the approved copy require the
backend (`serve.py` in the sibling `backend` repo): `/render` (Playwright) and
`/ai/*` (Claude). The front points at the backend via one tag in `<head>`:

```html
<meta name="api-base" content="https://api.yourdomain.com" />
```

Leave it empty for same-origin/local dev. `localhost` and `file://` always force
same-origin, so local dev never hits a remote backend regardless of the meta.

## Local development

Run the backend, which also serves this `index.html` on `http://localhost:5500`:

```bash
cd ../backend && python3 serve.py     # Windows: py serve.py
```

Then open http://localhost:5500. Opening `index.html` directly via `file://`
still parses uploads, but Run QA Check needs the backend.

## Deploy

Cloudflare Pages, no build step, output = repo root. See `../backend/DEPLOY.md`
for the full split-deploy runbook (front on Pages, backend on a VPS).

## `test/`

Sample approved-copy generators (stdlib Python) used to exercise the PDF/DOCX
parser: `py test/make_samples.py`, `py test/make_color_sample.py`.

The build tag in the footer (e.g. `build 2026-07-08a`) must be bumped on every
change so a hard refresh can confirm the new version loaded.
