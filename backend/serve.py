#!/usr/bin/env python3
"""
Copy Match Checker — local server.

Serves the tool AND provides a server-side fetch endpoint so the page can read
any URL without CORS / public-proxy limitations (works with WP Engine staging,
HubSpot, etc.). The tool calls /fetch?url=... first; if this server isn't
running it falls back to public proxies automatically.

Run:
    py serve.py            # http://localhost:5500
    py serve.py 8080       # custom port
"""
import http.server
import socketserver
import urllib.request
import urllib.parse
import urllib.error
import sys
import os
import re
import gzip
import io
import json
import base64
import functools

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 5500


def load_dotenv(path):
    """Minimal .env loader (stdlib only, no python-dotenv dependency).
    Lines look like KEY=VALUE or KEY="VALUE"; # starts a comment; existing
    env vars are never overwritten."""
    if not os.path.isfile(path):
        return
    with open(path, "r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, _, value = line.partition("=")
            key, value = key.strip(), value.strip().strip('"').strip("'")
            if key and key not in os.environ:
                os.environ[key] = value


load_dotenv(os.path.join(os.path.dirname(os.path.abspath(__file__)), ".env"))
ANTHROPIC_API_KEY = os.environ.get("ANTHROPIC_API_KEY")
ANTHROPIC_MODEL = os.environ.get("ANTHROPIC_MODEL", "claude-sonnet-5")
ANTHROPIC_API_URL = "https://api.anthropic.com/v1/messages"

# When the front is deployed on its own origin (Cloudflare Pages) and this
# server is the standalone API, the browser calls it cross-origin. Set
# ALLOWED_ORIGIN to the front origin(s) — comma-separated — so CORS echoes the
# exact origin and allows credentials (the Cloudflare Access cookie). Left empty
# (same-origin/local dev) it falls back to an open "*" with no credentials.
ALLOWED_ORIGINS = [o.strip() for o in os.environ.get("ALLOWED_ORIGIN", "").split(",") if o.strip()]

# Shared secret gating /render and /ai/* . In the split deploy the browser never
# reaches this server directly: a Cloudflare Pages Function proxies /api/* and
# injects this secret as X-Proxy-Secret. Requests without the matching header are
# rejected, so a scanner hitting the VPS IP cannot spend the Claude key. Empty
# (local dev, where serve.py is same-origin) disables the check.
PROXY_SECRET = os.environ.get("PROXY_SECRET", "").strip()

# Static root for local dev. After the frontend/backend split, index.html lives
# in a sibling ../frontend folder; serve it from there so `python3 serve.py`
# still hosts the whole tool same-origin on localhost. Falls back to serve.py's
# own directory (combined layout) and is overridable via FRONTEND_DIR.
_HERE = os.path.dirname(os.path.abspath(__file__))
FRONTEND_DIR = os.environ.get("FRONTEND_DIR") or (
    os.path.join(_HERE, "..", "frontend")
    if os.path.isfile(os.path.join(_HERE, "..", "frontend", "index.html"))
    else _HERE
)

# ---- Claude comparison engine: the entire approved-vs-page comparison is decided
# by Claude (no similarity-score heuristic making the call). It receives the
# approved blocks (scaffolding/SEO/nav already stripped upstream) and every block
# visible on the FULLY RENDERED page (JavaScript already executed via /render),
# and returns the complete list of QA issues. See CLAUDE.md for the full design.
COMPARE_SYSTEM_PROMPT = """You are the copy-QA comparison engine for the Punch Toolkit's Copy Match
Checker. You compare an approved-copy document (already parsed into blocks,
with obvious scaffolding like SEO labels, page-goal notes, and
table-of-contents entries already removed upstream) against the fully
rendered content of a live web page, and produce the QA findings a reviewer
would act on. Do not rely on exact string matching — judge meaning, reworded
sentences, and partial matches the way a careful human reviewer would.

You receive:
- approved_blocks: the copy that should be on the page, in reading order.
  Each has a kind: normal (must appear), alternate (a green/color-coded
  stand-in for the previous block — only ONE of the pair should be live),
  or cta (a button/link; only the bracketed label is copy, any url/note is
  the link target, never visible text). A block of any kind, including
  cta, may carry an "alt" field: a shorter alternate wording of that same
  heading/paragraph/button label the copywriter left for when the page
  layout doesn't fit the full version. The gray/green rule below applies to
  it exactly the same way regardless of block kind.
- page_blocks: every visible text block extracted from the fully rendered
  page (JavaScript already executed), in reading order.
- page_ctas / page_links: buttons and links found on the page, with href
  where relevant.

For every approved block, decide one of:
- Present on the page, matching exactly or differing only in whitespace or
  capitalization -> no issue, skip it.
- Present but with ANY actual wording difference from the approved text —
  a substituted or dropped word, an added or missing phrase, a changed
  number, date, or punctuation mark, even a small one -> Copy Mismatch (set
  "current" to the page's actual text). Err toward flagging: a QA reviewer
  would rather see a minor discrepancy called out than have it pass
  silently because it "basically" matches.
- Entirely absent from the page -> Missing Copy ("current": "-"). These two
  are mutually exclusive by definition: "Copy Mismatch" ALWAYS has the
  page's real (non-"-") text in "current" — it means "present but altered".
  If nothing on the page corresponds to the block at all, the type MUST be
  "Missing Copy" and "current" MUST be "-", never the reverse.
- Block with an alt: only flag Copy Mismatch if BOTH the full version and
  its alternate are live on the page as separate blocks (only one should
  be). If only one of the pair is live, that is correct - do not flag it as
  an issue (you may add it as an Info-priority Observation). This applies
  to headings, paragraphs, and cta labels alike.
- Cta block: the bracketed label (or its alt, per the rule above) must
  appear as visible button/link text. If a url was given and the label is
  correct but the link target doesn't match, that's a Medium-priority CTA
  Issue. A missing or wrong label is a High-priority CTA Issue.
- Two adjacent approved blocks with no "alt" link that clearly restate the
  same message — one longer, one a short punchy version of it — should be
  treated as an unmarked alternate pair under the same rule (only one needs
  to be live): PDFs lose the green color-coding that would normally mark
  this explicitly, so the pairing has to be judged from meaning alone. Only
  apply this when the semantic overlap is unmistakable, not for two blocks
  that merely discuss a related topic.

Then look at page_blocks that don't correspond to any approved block and
flag the ones that look like real reviewable copy (not boilerplate like
cookie banners, nav, or footer legal text) as Extra Section.

Before flagging Missing Copy or CTA Issue on an approved block, double
check: is this actually an internal instruction rather than real page copy
(a page-goal note, an SEO field, a bracketed layout annotation, a
breadcrumb) that slipped through the upstream filter? If so, do not report
it as an issue at all - it was never meant to be on the page.

For every issue: "section" is a short (<=40 char) label a human would
recognize for where this is (use the block's own text if short, or a
nearby heading if you can infer one, otherwise a generic label like
"Body"). "fix" is one plain-language sentence telling a copy editor
exactly what to do.

Finally compute "score": the percentage (0-100 integer) of normal/cta
approved blocks that are correctly live on the page.

Call the submit_comparison tool once with the full list of issues (omit
blocks with no issue) and the score, and nothing else."""

SUBMIT_COMPARISON_TOOL = {
    "name": "submit_comparison",
    "description": "Return the full list of QA issues found and an overall match score.",
    "input_schema": {
        "type": "object",
        "properties": {
            "issues": {
                "type": "array",
                "items": {
                    "type": "object",
                    "properties": {
                        "type": {"type": "string", "enum": [
                            "Missing Copy", "Copy Mismatch", "Extra Section",
                            "CTA Issue", "Observation",
                        ]},
                        "priority": {"type": "string", "enum": ["High", "Medium", "Low", "Info"]},
                        "section": {"type": "string"},
                        "approved": {"type": "string", "description": "Approved copy text, or '-' if none"},
                        "current": {"type": "string", "description": "Current page text, or '-' if absent"},
                        "fix": {"type": "string"},
                    },
                    "required": ["type", "priority", "section", "approved", "current", "fix"],
                },
            },
            "score": {"type": "integer", "description": "0-100 match score"},
        },
        "required": ["issues", "score"],
    },
}


def _coerce_list_field(value, key):
    """Defends against an occasional model quirk where a tool argument comes back
    as a JSON-encoded string instead of the native array the schema asked for
    (seen on both /ai/compare's "issues" and /ai/segment-pages's "pages")."""
    if isinstance(value, str):
        try:
            parsed = json.loads(value)
            value = parsed.get(key, []) if isinstance(parsed, dict) else parsed
        except (json.JSONDecodeError, AttributeError):
            value = []
    return value if isinstance(value, list) else []


def call_claude_compare(payload):
    if not ANTHROPIC_API_KEY:
        raise RuntimeError("ANTHROPIC_API_KEY is not set on the server")
    body = json.dumps({
        "model": ANTHROPIC_MODEL,
        "max_tokens": 8192,
        "system": COMPARE_SYSTEM_PROMPT,
        "tools": [SUBMIT_COMPARISON_TOOL],
        "tool_choice": {"type": "tool", "name": "submit_comparison"},
        "messages": [{"role": "user", "content": json.dumps(payload)}],
    }).encode("utf-8")
    req = urllib.request.Request(ANTHROPIC_API_URL, data=body, method="POST", headers={
        "content-type": "application/json",
        "x-api-key": ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
    })
    try:
        with urllib.request.urlopen(req, timeout=120) as resp:
            data = json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        detail = e.read().decode("utf-8", "ignore")
        raise RuntimeError(f"Claude API error {e.code}: {detail}") from e
    for block in data.get("content", []):
        if block.get("type") == "tool_use" and block.get("name") == "submit_comparison":
            out = block["input"]
            issues = _coerce_list_field(out.get("issues", []), "issues")
            score = out.get("score", 0)
            return _fix_issue_type_consistency(issues), score if isinstance(score, (int, float)) else 0
    raise RuntimeError("Claude did not return a submit_comparison tool call")


def _fix_issue_type_consistency(issues):
    """"Copy Mismatch" and "Missing Copy" are mutually exclusive by
    definition (present-but-altered vs. entirely-absent) — belt-and-suspenders
    against the model occasionally mislabeling one as the other despite the
    prompt instruction, which surfaces a real discrepancy under the wrong
    filter tab and reads as "sometimes recognized, sometimes not"."""
    for issue in issues:
        if not isinstance(issue, dict):
            continue
        current = (issue.get("current") or "").strip()
        if issue.get("type") == "Copy Mismatch" and current in ("", "-"):
            issue["type"] = "Missing Copy"
            issue["current"] = "-"
        elif issue.get("type") == "Missing Copy" and current not in ("", "-"):
            issue["type"] = "Copy Mismatch"
    return issues


# ---- Claude page-segmentation: approved-copy decks often bundle the copy for an
# entire site into one document with no consistent marker between pages (sometimes
# a heading, sometimes an SEO box, sometimes just a topic change, sometimes
# nothing explicit). Claude reads the whole document and proposes page boundaries
# so the UI can offer a "which page is this?" picker instead of comparing the
# entire multi-page document against a single URL.
SEGMENT_SYSTEM_PROMPT = """You are splitting an approved-copy document for the Punch Toolkit's Copy
Match Checker into the individual website pages it contains. Marketing and
compliance copy decks often bundle the copy for an entire site into one
file, with no consistent structural marker between pages: sometimes a big
heading, sometimes an SEO/meta box (Page Goal, Goal CTA, SEO Title, Meta
Description, Focus Keyphrase), sometimes a URL slug or breadcrumb, sometimes
just a clear change in topic with nothing explicit at all.

You receive the document's text as a numbered list of lines/paragraphs, in
reading order (numbering starts at 0). Identify where each page's content
starts and ends using whatever signal is actually present: a page title or
heading, a slug/URL reference, a breadcrumb, an SEO box, or another clear,
repeating marker that a new page's copy is starting.

Default to ONE page. Most documents you receive are a single page's copy —
an intro, supporting detail, and a call to action, which can *read* like
different topics but are still one page. A plain change in subject or tone
partway through, with no repeating structural marker (heading/slug/SEO
box/breadcrumb) announcing a fresh page, is NOT enough to split. Only
report more than one page when you see that kind of marker appear again
later in the document, clearly starting a new page. If you are not
confident there are multiple pages, return a single page spanning the
whole document (start_line 0, end_line = last line number).

For each page, give a short, human-recognizable title: use the page's own
heading/name if present — its own name only, not a parent/child breadcrumb
lineage (e.g. "Pricing", not "Platform>XRAMP>Pricing") — otherwise infer a
short label (2-6 words) from its content (e.g. "FedRAMP Compliance", "About
Us"). Pages must be listed in order and must not overlap.

Skip document front matter entirely rather than returning it as a page: a
cover/title block, a table of contents, or a sitemap/site-navigation listing
(a list of every page's name, sometimes with "Link" or "Edits" annotations)
is never real site content, no matter how long it is. Start the first
returned page at the first line that is genuine page copy; if front matter
precedes it, the first page's start_line will be greater than 0, and that's
correct — do not report the front matter as its own page.

Call the submit_pages tool once with the ordered list of real pages, and
nothing else."""

SUBMIT_PAGES_TOOL = {
    "name": "submit_pages",
    "description": "Return the ordered list of pages detected in the document.",
    "input_schema": {
        "type": "object",
        "properties": {
            "pages": {
                "type": "array",
                "items": {
                    "type": "object",
                    "properties": {
                        "title": {"type": "string"},
                        "start_line": {"type": "integer"},
                        "end_line": {"type": "integer"},
                    },
                    "required": ["title", "start_line", "end_line"],
                },
            },
        },
        "required": ["pages"],
    },
}


def call_claude_segment(lines):
    if not ANTHROPIC_API_KEY:
        raise RuntimeError("ANTHROPIC_API_KEY is not set on the server")
    numbered = "\n".join(f"{i}: {t}" for i, t in enumerate(lines))
    body = json.dumps({
        "model": ANTHROPIC_MODEL,
        "max_tokens": 4096,
        "system": SEGMENT_SYSTEM_PROMPT,
        "tools": [SUBMIT_PAGES_TOOL],
        "tool_choice": {"type": "tool", "name": "submit_pages"},
        "messages": [{"role": "user", "content": numbered}],
    }).encode("utf-8")
    req = urllib.request.Request(ANTHROPIC_API_URL, data=body, method="POST", headers={
        "content-type": "application/json",
        "x-api-key": ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
    })
    try:
        with urllib.request.urlopen(req, timeout=90) as resp:
            data = json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        detail = e.read().decode("utf-8", "ignore")
        raise RuntimeError(f"Claude API error {e.code}: {detail}") from e
    for block in data.get("content", []):
        if block.get("type") == "tool_use" and block.get("name") == "submit_pages":
            return _coerce_list_field(block["input"].get("pages", []), "pages")
    raise RuntimeError("Claude did not return a submit_pages tool call")


# ---- Page rendering: loads the URL in a real (headless) Chrome so JavaScript-
# inserted content is present before extraction, instead of only the raw HTML
# the server would otherwise download.
try:
    from playwright.sync_api import sync_playwright
    PLAYWRIGHT_AVAILABLE = True
except ImportError:
    PLAYWRIGHT_AVAILABLE = False


def render_page(url, timeout_ms=30000):
    with sync_playwright() as p:
        try:
            browser = p.chromium.launch(channel="chrome", headless=True)
        except Exception:
            browser = p.chromium.launch(headless=True)
        try:
            page = browser.new_page(user_agent=BROWSER_HEADERS["User-Agent"])
            try:
                page.goto(url, wait_until="networkidle", timeout=timeout_ms)
            except Exception:
                # some pages never go network-idle (chat widgets, analytics beacons,
                # polling) — fall back to whatever has rendered after a fixed wait.
                page.wait_for_timeout(2500)
            return page.content()
        finally:
            browser.close()


# ---- Projects data layer: the dashboard (grid of projects, each with its last
# match score and resolved/total issue counts) is shared across the whole team,
# so it lives in Postgres rather than the browser (localStorage would give each
# teammate a different list). Reserved DATABASE_URL from Phase 2 planning is now
# actually used. Degrades explicitly (503, no silent fallback — see CLAUDE.md's
# philosophy on the AI endpoints) when psycopg2 isn't installed or DATABASE_URL
# isn't set, instead of crashing serve.py on startup.
try:
    import psycopg2
    PSYCOPG2_AVAILABLE = True
except ImportError:
    PSYCOPG2_AVAILABLE = False

DATABASE_URL = os.environ.get("DATABASE_URL", "").strip()
DB_AVAILABLE = PSYCOPG2_AVAILABLE and bool(DATABASE_URL)


def get_db_conn():
    return psycopg2.connect(DATABASE_URL)


def init_db():
    if not DB_AVAILABLE:
        return
    conn = get_db_conn()
    try:
        with conn.cursor() as cur:
            cur.execute("""
                CREATE TABLE IF NOT EXISTS projects (
                    id SERIAL PRIMARY KEY,
                    name TEXT NOT NULL,
                    site_name TEXT NOT NULL DEFAULT '',
                    page_name TEXT NOT NULL DEFAULT '',
                    page_url TEXT NOT NULL DEFAULT '',
                    score INTEGER,
                    issues JSONB NOT NULL DEFAULT '[]'::jsonb,
                    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
                    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
                    last_run_at TIMESTAMPTZ
                );
            """)
            # One row per "Run QA Check" click — an immutable snapshot (score,
            # issues, and the exact approved-copy file used), so the team can
            # answer "which version of the copy did we compare on July 5th?"
            # without overwriting the previous answer on the next run. Separate
            # from `projects` (the mutable "current" state the dashboard/grid
            # reads) so this table only ever grows, never gets rewritten.
            cur.execute("""
                CREATE TABLE IF NOT EXISTS project_runs (
                    id SERIAL PRIMARY KEY,
                    project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
                    ran_at TIMESTAMPTZ NOT NULL DEFAULT now(),
                    site_name TEXT NOT NULL DEFAULT '',
                    page_name TEXT NOT NULL DEFAULT '',
                    page_url TEXT NOT NULL DEFAULT '',
                    score INTEGER,
                    issues JSONB NOT NULL DEFAULT '[]'::jsonb,
                    doc_filename TEXT,
                    doc_content_type TEXT,
                    doc_bytes BYTEA,
                    ran_by TEXT NOT NULL DEFAULT ''
                );
            """)
            # ADD COLUMN IF NOT EXISTS so an already-deployed table (created
            # before ran_by existed) picks it up without a manual migration.
            cur.execute("ALTER TABLE project_runs ADD COLUMN IF NOT EXISTS ran_by TEXT NOT NULL DEFAULT '';")
            cur.execute("CREATE INDEX IF NOT EXISTS idx_project_runs_project_id ON project_runs(project_id, ran_at DESC);")
        conn.commit()
    finally:
        conn.close()


def db_query(sql, params=(), fetch=None):
    """fetch: None (no result), "one", or "all". Commits on success, always closes."""
    conn = get_db_conn()
    try:
        with conn.cursor() as cur:
            cur.execute(sql, params)
            result = cur.fetchone() if fetch == "one" else cur.fetchall() if fetch == "all" else None
        conn.commit()
        return result
    finally:
        conn.close()


PROJECT_COLUMNS = "id,name,site_name,page_name,page_url,score,issues,created_at,updated_at,last_run_at"


def _issue_stats(issues, score):
    """Observations are never counted as errors (matches index.html's countType()).
    live_score interpolates from Claude's snapshot score toward 100% as the team
    marks issues Done, the same formula as the single-project view's liveScore()
    — so the dashboard card and the project page never show two different numbers."""
    errors = [i for i in issues if isinstance(i, dict) and i.get("type") != "Observation"]
    total = len(errors)
    resolved = len([i for i in errors if i.get("done")])
    if total == 0:
        live = 100
    else:
        base = score if isinstance(score, (int, float)) else 0
        live = round(base + (100 - base) * (1 - (total - resolved) / total))
    return total, resolved, live


def _project_summary(row):
    (pid, name, site_name, page_name, page_url, score, issues, created_at, updated_at, last_run_at) = row
    total, resolved, live = _issue_stats(issues or [], score)
    return {
        "id": pid, "name": name, "site_name": site_name, "page_name": page_name,
        "page_url": page_url, "score": score, "live_score": live,
        "issues_total": total, "issues_resolved": resolved,
        "last_run_at": last_run_at.isoformat() if last_run_at else None,
        "updated_at": updated_at.isoformat() if updated_at else None,
    }


def _project_full(row):
    d = _project_summary(row)
    d["issues"] = row[6] or []
    return d


BROWSER_HEADERS = {
    "User-Agent": ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
                   "(KHTML, like Gecko) Chrome/120.0 Safari/537.36"),
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9",
}


class Handler(http.server.SimpleHTTPRequestHandler):
    def do_GET(self):
        if self.path.startswith("/fetch?") or self.path.startswith("/fetch/?"):
            return self.handle_fetch()
        if self.path.startswith("/render?") or self.path.startswith("/render/?"):
            return self.handle_render()
        if self.path == "/projects":
            return self.handle_projects_list()
        m = re.match(r"^/projects/(\d+)$", self.path)
        if m:
            return self.handle_project_get(int(m.group(1)))
        m = re.match(r"^/projects/(\d+)/runs$", self.path)
        if m:
            return self.handle_runs_list(int(m.group(1)))
        m = re.match(r"^/projects/(\d+)/runs/(\d+)/document$", self.path)
        if m:
            return self.handle_run_document(int(m.group(1)), int(m.group(2)))
        m = re.match(r"^/projects/(\d+)/runs/(\d+)$", self.path)
        if m:
            return self.handle_run_get(int(m.group(1)), int(m.group(2)))
        return super().do_GET()

    def do_POST(self):
        if self.path == "/ai/compare":
            return self.handle_ai_compare()
        if self.path == "/ai/segment-pages":
            return self.handle_ai_segment()
        if self.path == "/projects":
            return self.handle_project_create()
        return self._send(404, "text/plain", b"Not found")

    def do_PUT(self):
        m = re.match(r"^/projects/(\d+)/run$", self.path)
        if m:
            return self.handle_project_run(int(m.group(1)))
        return self._send(404, "text/plain", b"Not found")

    def do_PATCH(self):
        m = re.match(r"^/projects/(\d+)/issues/([^/]+)$", self.path)
        if m:
            return self.handle_issue_toggle(int(m.group(1)), urllib.parse.unquote(m.group(2)))
        return self._send(404, "text/plain", b"Not found")

    def do_OPTIONS(self):
        # CORS preflight for cross-origin POSTs (json content-type) from the
        # standalone front. Same-origin/local dev never sends this.
        self.send_response(204)
        self._write_cors_headers()
        self.send_header("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.send_header("Access-Control-Max-Age", "86400")
        self.send_header("Content-Length", "0")
        self.end_headers()

    def _write_cors_headers(self):
        """Echo the caller's Origin when it is in the allowlist (required to
        allow credentials); fall back to open '*' with no credentials when no
        allowlist is configured (same-origin/local dev)."""
        origin = self.headers.get("Origin")
        if not ALLOWED_ORIGINS:
            self.send_header("Access-Control-Allow-Origin", "*")
            return
        allowed = origin if origin in ALLOWED_ORIGINS else ALLOWED_ORIGINS[0]
        self.send_header("Access-Control-Allow-Origin", allowed)
        self.send_header("Access-Control-Allow-Credentials", "true")
        self.send_header("Vary", "Origin")

    def _secret_ok(self):
        """True when the proxy secret matches (or none is configured). Rejects
        with 403 otherwise so a direct hit on the VPS can't reach the paid
        endpoints."""
        if not PROXY_SECRET:
            return True
        if self.headers.get("X-Proxy-Secret") == PROXY_SECRET:
            return True
        self._send(403, "application/json", json.dumps({"error": "forbidden"}).encode("utf-8"))
        return False

    def handle_ai_segment(self):
        if not self._secret_ok():
            return
        length = int(self.headers.get("Content-Length") or 0)
        raw = self.rfile.read(length) if length else b"{}"
        try:
            payload = json.loads(raw.decode("utf-8"))
            lines = payload.get("lines") or []
            if not lines:
                return self._send(400, "application/json",
                                   json.dumps({"error": "lines is required"}).encode("utf-8"))
            pages = call_claude_segment(lines)
            self._send(200, "application/json", json.dumps({"pages": pages}).encode("utf-8"))
        except Exception as e:  # noqa: BLE001
            self._send(502, "application/json", json.dumps({"error": str(e)}).encode("utf-8"))

    def handle_ai_compare(self):
        if not self._secret_ok():
            return
        length = int(self.headers.get("Content-Length") or 0)
        raw = self.rfile.read(length) if length else b"{}"
        try:
            payload = json.loads(raw.decode("utf-8"))
            if not payload.get("approved_blocks") or not payload.get("page_blocks"):
                return self._send(400, "application/json",
                                   json.dumps({"error": "approved_blocks and page_blocks are required"}).encode("utf-8"))
            issues, score = call_claude_compare(payload)
            self._send(200, "application/json", json.dumps({"issues": issues, "score": score}).encode("utf-8"))
        except Exception as e:  # noqa: BLE001
            self._send(502, "application/json", json.dumps({"error": str(e)}).encode("utf-8"))

    def _db_unavailable(self):
        self._send(503, "application/json", json.dumps({
            "error": "Database not configured on the server (DATABASE_URL / psycopg2 missing). "
                     "Ask a dev to set DATABASE_URL in backend/.env and install psycopg2-binary.",
        }).encode("utf-8"))

    def handle_projects_list(self):
        if not self._secret_ok():
            return
        if not DB_AVAILABLE:
            return self._db_unavailable()
        try:
            rows = db_query(f"SELECT {PROJECT_COLUMNS} FROM projects ORDER BY updated_at DESC", fetch="all")
            self._send(200, "application/json", json.dumps({"projects": [_project_summary(r) for r in rows]}).encode("utf-8"))
        except Exception as e:  # noqa: BLE001
            self._send(502, "application/json", json.dumps({"error": str(e)}).encode("utf-8"))

    def handle_project_get(self, pid):
        if not self._secret_ok():
            return
        if not DB_AVAILABLE:
            return self._db_unavailable()
        try:
            row = db_query(f"SELECT {PROJECT_COLUMNS} FROM projects WHERE id=%s", (pid,), fetch="one")
            if not row:
                return self._send(404, "application/json", json.dumps({"error": "Project not found"}).encode("utf-8"))
            self._send(200, "application/json", json.dumps(_project_full(row)).encode("utf-8"))
        except Exception as e:  # noqa: BLE001
            self._send(502, "application/json", json.dumps({"error": str(e)}).encode("utf-8"))

    def handle_project_create(self):
        if not self._secret_ok():
            return
        if not DB_AVAILABLE:
            return self._db_unavailable()
        length = int(self.headers.get("Content-Length") or 0)
        raw = self.rfile.read(length) if length else b"{}"
        try:
            payload = json.loads(raw.decode("utf-8"))
            name = (payload.get("name") or "").strip()
            if not name:
                return self._send(400, "application/json", json.dumps({"error": "name is required"}).encode("utf-8"))
            row = db_query(
                f"INSERT INTO projects (name) VALUES (%s) RETURNING {PROJECT_COLUMNS}", (name,), fetch="one")
            self._send(200, "application/json", json.dumps(_project_full(row)).encode("utf-8"))
        except Exception as e:  # noqa: BLE001
            self._send(502, "application/json", json.dumps({"error": str(e)}).encode("utf-8"))

    def handle_project_run(self, pid):
        if not self._secret_ok():
            return
        if not DB_AVAILABLE:
            return self._db_unavailable()
        length = int(self.headers.get("Content-Length") or 0)
        raw = self.rfile.read(length) if length else b"{}"
        try:
            payload = json.loads(raw.decode("utf-8"))
            issues = payload.get("issues")
            issues = issues if isinstance(issues, list) else []
            score = payload.get("score")
            score = score if isinstance(score, (int, float)) else None
            site_name = payload.get("site_name") or ""
            page_name = payload.get("page_name") or ""
            page_url = payload.get("page_url") or ""
            doc = payload.get("document") or {}
            doc_filename = doc.get("filename")
            doc_content_type = doc.get("content_type")
            ran_by = (payload.get("ran_by") or "").strip()
            doc_bytes = None
            if doc.get("data_base64"):
                try:
                    doc_bytes = base64.b64decode(doc["data_base64"])
                except Exception:  # noqa: BLE001
                    doc_bytes = None
            row = db_query(
                f"""UPDATE projects SET site_name=%s, page_name=%s, page_url=%s, score=%s,
                    issues=%s::jsonb, last_run_at=now(), updated_at=now()
                    WHERE id=%s RETURNING {PROJECT_COLUMNS}""",
                (site_name, page_name, page_url, score, json.dumps(issues), pid),
                fetch="one")
            if not row:
                return self._send(404, "application/json", json.dumps({"error": "Project not found"}).encode("utf-8"))
            # Every run also lands as a new, immutable project_runs row — the
            # history/version trail. Never updated afterward, unlike `projects`.
            db_query(
                """INSERT INTO project_runs (project_id, site_name, page_name, page_url, score, issues,
                    doc_filename, doc_content_type, doc_bytes, ran_by)
                   VALUES (%s,%s,%s,%s,%s,%s::jsonb,%s,%s,%s,%s)""",
                (pid, site_name, page_name, page_url, score, json.dumps(issues),
                 doc_filename, doc_content_type, doc_bytes, ran_by))
            self._send(200, "application/json", json.dumps(_project_full(row)).encode("utf-8"))
        except Exception as e:  # noqa: BLE001
            self._send(502, "application/json", json.dumps({"error": str(e)}).encode("utf-8"))

    def handle_runs_list(self, pid):
        if not self._secret_ok():
            return
        if not DB_AVAILABLE:
            return self._db_unavailable()
        try:
            rows = db_query(
                "SELECT id, ran_at, score, issues, doc_filename, ran_by FROM project_runs "
                "WHERE project_id=%s ORDER BY ran_at DESC", (pid,), fetch="all")
            runs = []
            for (rid, ran_at, score, issues, doc_filename, ran_by) in rows:
                issues = issues or []
                total = len([i for i in issues if isinstance(i, dict) and i.get("type") != "Observation"])
                runs.append({
                    "id": rid, "ran_at": ran_at.isoformat() if ran_at else None,
                    "score": score, "issues_total": total, "doc_filename": doc_filename,
                    "ran_by": ran_by or None,
                })
            self._send(200, "application/json", json.dumps({"runs": runs}).encode("utf-8"))
        except Exception as e:  # noqa: BLE001
            self._send(502, "application/json", json.dumps({"error": str(e)}).encode("utf-8"))

    def handle_run_get(self, pid, run_id):
        if not self._secret_ok():
            return
        if not DB_AVAILABLE:
            return self._db_unavailable()
        try:
            row = db_query(
                "SELECT id, ran_at, site_name, page_name, page_url, score, issues, doc_filename, ran_by "
                "FROM project_runs WHERE id=%s AND project_id=%s", (run_id, pid), fetch="one")
            if not row:
                return self._send(404, "application/json", json.dumps({"error": "Run not found"}).encode("utf-8"))
            (rid, ran_at, site_name, page_name, page_url, score, issues, doc_filename, ran_by) = row
            self._send(200, "application/json", json.dumps({
                "id": rid, "ran_at": ran_at.isoformat() if ran_at else None,
                "site_name": site_name, "page_name": page_name, "page_url": page_url,
                "score": score, "issues": issues or [], "doc_filename": doc_filename,
                "ran_by": ran_by or None,
            }).encode("utf-8"))
        except Exception as e:  # noqa: BLE001
            self._send(502, "application/json", json.dumps({"error": str(e)}).encode("utf-8"))

    def handle_run_document(self, pid, run_id):
        if not self._secret_ok():
            return
        if not DB_AVAILABLE:
            return self._db_unavailable()
        try:
            row = db_query(
                "SELECT doc_filename, doc_content_type, doc_bytes FROM project_runs "
                "WHERE id=%s AND project_id=%s", (run_id, pid), fetch="one")
            if not row or not row[2]:
                return self._send(404, "application/json",
                                   json.dumps({"error": "No document stored for this run"}).encode("utf-8"))
            filename, content_type, data = row
            filename = (filename or "approved-copy").replace('"', "")
            self.send_response(200)
            self.send_header("Content-Type", content_type or "application/octet-stream")
            self.send_header("Content-Disposition", f'attachment; filename="{filename}"')
            self._write_cors_headers()
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)
        except Exception as e:  # noqa: BLE001
            self._send(502, "application/json", json.dumps({"error": str(e)}).encode("utf-8"))

    def handle_issue_toggle(self, pid, issue_id):
        if not self._secret_ok():
            return
        if not DB_AVAILABLE:
            return self._db_unavailable()
        length = int(self.headers.get("Content-Length") or 0)
        raw = self.rfile.read(length) if length else b"{}"
        try:
            payload = json.loads(raw.decode("utf-8"))
            done = bool(payload.get("done"))
            row = db_query("SELECT issues FROM projects WHERE id=%s", (pid,), fetch="one")
            if not row:
                return self._send(404, "application/json", json.dumps({"error": "Project not found"}).encode("utf-8"))
            issues = row[0] or []
            found = False
            for issue in issues:
                if isinstance(issue, dict) and issue.get("id") == issue_id:
                    issue["done"] = done
                    found = True
            db_query("UPDATE projects SET issues=%s::jsonb, updated_at=now() WHERE id=%s", (json.dumps(issues), pid))
            total, resolved, _ = _issue_stats(issues, None)
            self._send(200, "application/json", json.dumps({
                "ok": found, "issues_total": total, "issues_resolved": resolved,
            }).encode("utf-8"))
        except Exception as e:  # noqa: BLE001
            self._send(502, "application/json", json.dumps({"error": str(e)}).encode("utf-8"))

    def handle_render(self):
        if not self._secret_ok():
            return
        if not PLAYWRIGHT_AVAILABLE:
            return self._send(501, "application/json", json.dumps({
                "error": "Playwright is not installed on the server. Run: py -m pip install playwright",
            }).encode("utf-8"))
        qs = urllib.parse.urlparse(self.path).query
        url = (urllib.parse.parse_qs(qs).get("url") or [""])[0]
        if not url or not url.lower().startswith(("http://", "https://")):
            return self._send(400, "text/plain", b"Missing or invalid 'url' parameter")
        try:
            html = render_page(url)
            self._send(200, "text/html; charset=utf-8", html.encode("utf-8"))
        except Exception as e:  # noqa: BLE001
            self._send(502, "application/json", json.dumps({"error": f"Render failed: {e}"}).encode("utf-8"))

    def handle_fetch(self):
        qs = urllib.parse.urlparse(self.path).query
        url = (urllib.parse.parse_qs(qs).get("url") or [""])[0]
        if not url or not url.lower().startswith(("http://", "https://")):
            return self._send(400, "text/plain", b"Missing or invalid 'url' parameter")
        try:
            req = urllib.request.Request(url, headers=BROWSER_HEADERS)
            with urllib.request.urlopen(req, timeout=25) as resp:
                raw = resp.read()
                # transparently de-gzip if the host returned compressed bytes
                if resp.headers.get("Content-Encoding") == "gzip":
                    try:
                        raw = gzip.GzipFile(fileobj=io.BytesIO(raw)).read()
                    except OSError:
                        pass
                ctype = resp.headers.get("Content-Type", "text/html; charset=utf-8")
            self._send(200, ctype, raw)
        except Exception as e:  # noqa: BLE001
            self._send(502, "text/plain", f"Fetch failed: {e}".encode("utf-8"))

    def end_headers(self):
        # never cache the tool files, so reloads always pick up the latest version
        self.send_header("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0")
        self.send_header("Pragma", "no-cache")
        super().end_headers()

    def _send(self, code, ctype, body):
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self._write_cors_headers()
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, fmt, *args):  # keep the console quiet
        pass


class Server(socketserver.ThreadingTCPServer):
    allow_reuse_address = True
    daemon_threads = True


if __name__ == "__main__":
    if DB_AVAILABLE:
        try:
            init_db()
        except Exception as e:  # noqa: BLE001
            print(f"DATABASE_URL set but could not initialize the projects table: {e}")
            DB_AVAILABLE = False
    handler = functools.partial(Handler, directory=FRONTEND_DIR)
    with Server(("", PORT), handler) as httpd:
        print(f"Copy Match Checker  ->  http://localhost:{PORT}")
        print(f"Serving frontend from  ->  {os.path.normpath(FRONTEND_DIR)}")
        print("Server-side fetch enabled at /fetch?url=...  (Ctrl+C to stop)")
        if PLAYWRIGHT_AVAILABLE:
            print("Playwright available  ->  /render?url=... (JavaScript-rendered pages) enabled")
        else:
            print("Playwright NOT installed  ->  /render disabled. Run: py -m pip install playwright")
        if ANTHROPIC_API_KEY:
            print("ANTHROPIC_API_KEY loaded  ->  AI comparison endpoint enabled")
        else:
            print("ANTHROPIC_API_KEY not set  ->  AI comparison disabled (add it to .env)")
        if ALLOWED_ORIGINS:
            print("CORS allowlist  ->  " + ", ".join(ALLOWED_ORIGINS) + " (credentials enabled)")
        else:
            print("CORS open (*)  ->  same-origin/local dev (set ALLOWED_ORIGIN for split deploy)")
        if PROXY_SECRET:
            print("Proxy secret set  ->  /render + /ai/* require X-Proxy-Secret")
        else:
            print("Proxy secret NOT set  ->  endpoints open (fine for local dev)")
        if DB_AVAILABLE:
            print("DATABASE_URL loaded  ->  /projects endpoints enabled (dashboard)")
        elif not PSYCOPG2_AVAILABLE:
            print("psycopg2 NOT installed  ->  /projects disabled. Run: py -m pip install psycopg2-binary")
        else:
            print("DATABASE_URL not set  ->  /projects disabled (add it to .env)")
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            print("\nStopped.")
