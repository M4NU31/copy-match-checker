# Copy Match Checker - Backend

`serve.py`: the API + local static server for the Punch Toolkit's Copy Match
Checker. Runs on a VPS (root) because it needs a long-lived Python process and a
headless Chrome. Endpoints:

- `GET /render?url=...` - loads the URL in headless Chrome (Playwright) and
  returns the fully JavaScript-rendered HTML.
- `POST /ai/compare` - sends approved + page blocks to the Claude Messages API,
  returns `{issues, score}`.
- `POST /ai/segment-pages` - Claude-driven splitting of a multi-page approved
  document into individual pages.
- `GET /fetch?url=...` - raw server-side fetch (debug only; the app uses
  `/render`).

For local dev it also serves the sibling `../frontend/index.html` so
`python3 serve.py` hosts the whole tool same-origin on `http://localhost:5500`.

## Setup

```bash
python3 -m venv .venv
.venv/bin/pip install playwright
.venv/bin/playwright install chromium
.venv/bin/playwright install-deps chromium   # Linux, needs root
cp .env.example .env                          # set ANTHROPIC_API_KEY
python3 serve.py                              # http://localhost:5500 (or: serve.py 8080)
```

Windows dev: `py serve.py`, or double-click `Iniciar Copy Match Checker.bat`.

## Environment (`.env`)

- `ANTHROPIC_API_KEY` (required) - Claude API key.
- `ANTHROPIC_MODEL` (optional) - defaults to `claude-sonnet-5`.
- `ALLOWED_ORIGIN` (split deploy) - comma-separated front origin(s). When set,
  CORS echoes the exact origin and allows credentials (Cloudflare Access
  cookie). Empty = open `*`, no credentials (same-origin/local dev).
- `FRONTEND_DIR` (optional) - override the static root; defaults to
  `../frontend` when present, else this directory.

Console output must stay ASCII (Windows cp1252 crashes on non-ASCII).

## Deploy

See [DEPLOY.md](DEPLOY.md) for the full VPS + Cloudflare Pages + Access runbook,
plus the systemd unit and nginx config in [deploy/](deploy/).
