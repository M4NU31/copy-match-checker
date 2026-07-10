# DEPLOY.md — Copy Match Checker (split deploy)

How to run the tool as **two pieces** instead of one local process:

- **Front** (`index.html` + CDN libs) — static, on **Cloudflare Pages**.
- **Backend** (`serve.py`: `/render` + `/ai/*`) — on a **Hostinger VPS KVM**
  (Ubuntu 24.04 LTS, plain OS), behind nginx + TLS, DNS proxied by Cloudflare.

This mirrors the eventual production split (front on Cloudflare Pages, backend on
a droplet with Postgres), so everything here transfers when you migrate.

> **Why a VPS and not Cloud/shared hosting:** the backend needs a long-lived
> Python process and a headless Chrome (Playwright), which require `apt` + root.
> Hostinger Web/Cloud plans disable `sudo` and jail SSH to the home dir, so the
> render + AI core cannot run there. Only a VPS (root) works.

---

## Part A — Backend on the VPS

### A0. Provision

Hostinger hPanel: create a **VPS KVM** (KVM 1, 1 vCPU / 4 GB is enough — do not go
below 2 GB or headless Chrome may OOM on heavy pages), template **Plain OS ->
Ubuntu 24.04 LTS** (no control panel). Note the public IP. SSH in as root.

### A1. System packages + app user

```bash
apt update && apt upgrade -y
apt install -y python3 python3-venv python3-pip nginx git
adduser --system --group --home /opt/copymatch copymatch
```

### A2. Get the code onto the server

```bash
cd /opt/copymatch
# clone the BACKEND repo (serve.py + deploy/ + .env.example live at its root).
git clone <your-backend-repo-url> .
chown -R copymatch:copymatch /opt/copymatch
```

### A3. Python venv + Playwright + Chromium

```bash
cd /opt/copymatch
python3 -m venv .venv
.venv/bin/pip install --upgrade pip playwright
# Download Chromium into the app dir (matches PLAYWRIGHT_BROWSERS_PATH in the unit)
sudo -u copymatch PLAYWRIGHT_BROWSERS_PATH=/opt/copymatch/.playwright \
  .venv/bin/playwright install chromium
# Install the OS libraries Chromium needs (needs root; this is the step Cloud
# hosting cannot do):
.venv/bin/playwright install-deps chromium
```

> Note: on Linux the code launches bundled Chromium, not the machine's Chrome —
> `serve.py` already falls back from `channel="chrome"` to plain Chromium.

### A4. Environment file

```bash
cp .env.example .env
nano .env
```

Set:

```
ANTHROPIC_API_KEY=sk-ant-...
ANTHROPIC_MODEL=claude-sonnet-5
# The front origin(s) — fill in after you know the Pages URL (Part B):
ALLOWED_ORIGIN=https://<your-pages-project>.pages.dev,https://copyqa.yourdomain.com
```

`chown copymatch:copymatch .env && chmod 600 .env`

### A5. systemd service

```bash
cp deploy/copymatch.service /etc/systemd/system/copymatch.service
systemctl daemon-reload
systemctl enable --now copymatch
systemctl status copymatch          # should be active (running)
journalctl -u copymatch -f          # watch startup log; confirm key + Playwright + CORS lines
```

The backend now listens on `127.0.0.1:5500`.

### A6. nginx + TLS

Point a DNS record `api.yourdomain.com` at the VPS IP first (Part C covers the
Cloudflare side). Then:

```bash
cp deploy/nginx-copymatch.conf /etc/nginx/sites-available/copymatch
# edit server_name to your real api subdomain:
nano /etc/nginx/sites-available/copymatch
ln -s /etc/nginx/sites-available/copymatch /etc/nginx/sites-enabled/
nginx -t && systemctl reload nginx
apt install -y certbot python3-certbot-nginx
certbot --nginx -d api.yourdomain.com   # adds the 443 block + auto-renew
```

Smoke test from your laptop:

```bash
curl -i "https://api.yourdomain.com/render?url=https://example.com" | head -20
```

You should get HTML back (or a clear JSON error if something is misconfigured).

### A7. Updating the backend later

```bash
cd /opt/copymatch && sudo -u copymatch git pull
# if serve.py deps changed: .venv/bin/pip install ...
systemctl restart copymatch
```

---

## Part B — Front on Cloudflare Pages

The front is pure static (`index.html` loads pdf.js / mammoth / JSZip from cdnjs).
It needs to know the backend origin via one `<meta>` tag.

### B1. Point the front at the backend

In the **frontend repo**, edit the head of `index.html`:

```html
<meta name="api-base" content="https://api.yourdomain.com" />
```

This is safe to commit: `localhost`/`file://` always force same-origin, so local
dev with `serve.py` keeps working regardless of what the meta says.

### B2. Create the Pages project

Cloudflare dashboard -> Workers & Pages -> Create -> Pages -> Connect to Git
(or Direct Upload of just `index.html`).

- **Build command:** *(none)* — there is no build step.
- **Build output directory:** the repo root (it serves `index.html`).
- Deploy. You get `https://<project>.pages.dev`. Optionally add a custom domain
  `copyqa.yourdomain.com` under the Pages project's Custom domains.

### B3. Register the front origin with the backend

Put the exact Pages origin(s) into `ALLOWED_ORIGIN` in the VPS `.env` (A4) and
`systemctl restart copymatch`. The origin must match byte-for-byte (scheme +
host, no trailing slash), e.g. `https://copyqa.yourdomain.com`.

---

## Part C — Cloudflare (DNS + Access auth)

### C1. DNS

In the Cloudflare zone for `yourdomain.com`:

- `A  api      -> <VPS IP>`   (Proxied / orange cloud)
- `copyqa` -> managed automatically when you add it as a Pages custom domain.

### C2. Access policies (who can use the tool)

Zero Trust -> Access -> Applications. Add a **self-hosted application** and an
allowlist policy (e.g. `emails ending in @punchteam.com`) for each hostname:

1. `copyqa.yourdomain.com` (the front) — gates who can load the tool at all.
2. `api.yourdomain.com` (the backend) — gates the API so nobody but your team can
   spend the Claude key.

### C3. Make the cross-origin API calls work under Access

Because the front and API are on different hostnames, the browser calls the API
cross-origin **with credentials** (the front already sends `credentials:"include"`,
and `serve.py` echoes the exact origin + `Access-Control-Allow-Credentials` when
`ALLOWED_ORIGIN` is set). For the Cloudflare Access cookie to ride along, in the
**API application's** Access settings enable **CORS**:

- Allowed origins: the front origin (`https://copyqa.yourdomain.com`)
- Allow credentials: **on**
- Allowed methods: `GET, POST, OPTIONS`
- Allowed headers: `Content-Type`

> **If the cross-origin cookie gives you trouble** (an XHR 302-redirecting to the
> Access login on first call is the classic symptom), use the bulletproof
> alternative: serve the API under the **same hostname** as the front via a
> Cloudflare Pages Function proxy at `/api/*`, and set the meta to
> `content="/api"`. One Access app, same-origin fetches, zero CORS. The code
> already supports this (`API_BASE="/api"`); only the Pages Function proxy needs
> adding.

---

## Verifying the whole chain

1. Open `https://copyqa.yourdomain.com` -> Cloudflare Access login -> the tool.
2. Confirm the footer build tag is the version you deployed (hard-refresh
   `Ctrl+Shift+R` if stale).
3. Upload an approved PDF/DOCX -> "Loaded N copy blocks".
4. Enter a page URL -> **Run QA Check**. If render + compare return results, the
   split is working end to end. A CORS error in the browser console means
   `ALLOWED_ORIGIN` / Access CORS (C3) is not matching your front origin.

---

## Local development still works unchanged

`py serve.py` (Windows) or `python3 serve.py` (Linux/Mac) + open
`http://localhost:5500`. On localhost the front forces same-origin, so it ignores
the `api-base` meta and talks to the local `serve.py` exactly as before.
