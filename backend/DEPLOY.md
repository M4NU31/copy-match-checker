# DEPLOY.md — Copy Match Checker (single VPS, monorepo)

The whole tool runs on **one VPS**: nginx serves the static `frontend/` and
proxies `/api/*` to `serve.py` (`backend/`), which renders pages with Playwright
and calls Claude. One repo (`copy-match-checker`) with `frontend/` + `backend/`
subfolders is cloned at `/opt/copymatch`.

> Why a VPS (not shared/Cloud hosting): the backend needs a long-lived Python
> process and a headless Chrome (Playwright), which require `apt` + root.
> Hostinger Web/Cloud plans disable `sudo` and jail SSH, so only a VPS works.

Current deploy: `http://191.101.235.160`, **HTTP, open access** (dev). See
"Restricting access" at the end to add auth or a domain+TLS.

---

## 1. Provision

Hostinger VPS KVM (1 vCPU / 4 GB is enough; do not go below 2 GB or headless
Chrome may OOM), template **Ubuntu 24.04 LTS (plain OS)**. SSH in as root.

```bash
apt update
apt install -y python3 python3-venv python3-pip nginx git
adduser --system --group --home /opt/copymatch copymatch
```

## 2. Clone the monorepo (private repo -> deploy key)

Generate a key for the app user and add its **public** half to the repo on GitHub
(Settings -> Deploy keys, read-only):

```bash
install -d -o copymatch -g copymatch -m 700 /opt/copymatch/.ssh
sudo -u copymatch ssh-keygen -t ed25519 -f /opt/copymatch/.ssh/github_deploy -N "" -q
sudo -u copymatch bash -c 'ssh-keyscan -t ed25519 github.com >> /opt/copymatch/.ssh/known_hosts'
printf 'Host github.com\n  IdentityFile /opt/copymatch/.ssh/github_deploy\n  IdentitiesOnly yes\n' \
  > /opt/copymatch/.ssh/config
chown -R copymatch:copymatch /opt/copymatch/.ssh && chmod 600 /opt/copymatch/.ssh/config
cat /opt/copymatch/.ssh/github_deploy.pub   # <- add this to the repo's Deploy keys
```

Then clone into `/opt/copymatch` (which already holds `.ssh`), keeping that dir:

```bash
sudo -H -u copymatch git clone git@github.com:M4NU31/copy-match-checker.git /tmp/mono
cp -a /tmp/mono/. /opt/copymatch/ && rm -rf /tmp/mono
chown -R copymatch:copymatch /opt/copymatch
```

## 3. Python venv + Playwright + Chromium

The venv and browser download live at the repo root (outside the subfolders):

```bash
cd /opt/copymatch
sudo -H -u copymatch python3 -m venv .venv
sudo -H -u copymatch .venv/bin/pip install --upgrade pip -r backend/requirements.txt
sudo -H -u copymatch env PLAYWRIGHT_BROWSERS_PATH=/opt/copymatch/.playwright \
  .venv/bin/playwright install chromium
.venv/bin/playwright install-deps chromium      # needs root (apt)
```

## 4. Environment (`backend/.env`)

```bash
cp /opt/copymatch/backend/.env.example /opt/copymatch/backend/.env
nano /opt/copymatch/backend/.env
```

```
ANTHROPIC_API_KEY=sk-ant-...
ANTHROPIC_MODEL=claude-sonnet-5
# Empty static root so serve.py never serves repo files; nginx serves the front.
FRONTEND_DIR=/opt/copymatch/webroot
# Shared secret nginx injects on /api/* so serve.py's gate passes. openssl rand -hex 32
PROXY_SECRET=<random-hex>
# Local-only Postgres (Phase 2; serve.py does not use it yet).
DATABASE_URL=postgresql://copymatch:<pw>@localhost:5432/copymatch
```

```bash
install -d -o copymatch -g copymatch -m 755 /opt/copymatch/webroot
chown copymatch:copymatch /opt/copymatch/backend/.env && chmod 600 /opt/copymatch/backend/.env
```

## 5. systemd service

```bash
cp /opt/copymatch/backend/deploy/copymatch.service /etc/systemd/system/copymatch.service
systemctl daemon-reload
systemctl enable --now copymatch
systemctl status copymatch        # active (running)
```

## 6. nginx (serve front + proxy /api/*)

```bash
cp /opt/copymatch/backend/deploy/nginx-copymatch.conf /etc/nginx/sites-available/copymatch
# put the real PROXY_SECRET into the X-Proxy-Secret line:
nano /etc/nginx/sites-available/copymatch
ln -sf /etc/nginx/sites-available/copymatch /etc/nginx/sites-enabled/copymatch
rm -f /etc/nginx/sites-enabled/default
# nginx (www-data) must read the front:
chmod o+rx /opt/copymatch && chmod -R o+rX /opt/copymatch/frontend
nginx -t && systemctl reload nginx
```

Smoke test:

```bash
curl -s -o /dev/null -w "%{http_code}\n" http://<vps-ip>/                       # 200 (front)
curl -s "http://<vps-ip>/api/render?url=https://example.com" | grep -o '<title>.*</title>'
```

## 7. Firewall

```bash
ufw allow OpenSSH && ufw allow 80/tcp && ufw allow 443/tcp && ufw --force enable
```

Port 5500 (serve.py) is not opened, so serve.py is reachable only via nginx.

## 8. Postgres (Phase 2 data layer — installed, not used yet)

```bash
apt install -y postgresql postgresql-contrib
sudo -u postgres psql -c "CREATE ROLE copymatch LOGIN PASSWORD '<pw>';"
sudo -u postgres psql -c "CREATE DATABASE copymatch OWNER copymatch;"
sudo -u postgres psql -d copymatch -c "ALTER SCHEMA public OWNER TO copymatch;"
```

Listens on localhost only (not internet-exposed); ufw blocks 5432 anyway. The
connection string goes in `backend/.env` as `DATABASE_URL`.

---

## Updating

```bash
cd /opt/copymatch && sudo -H -u copymatch git pull
# if backend/requirements.txt changed (the auto-deploy on push does NOT do this):
sudo -H -u copymatch .venv/bin/pip install -r backend/requirements.txt
systemctl restart copymatch
# front changes are static; git pull already updated /opt/copymatch/frontend
```

**2026-07-10: added the `/projects` dashboard.** Requires `psycopg2-binary`
(added to `backend/requirements.txt`) and `DATABASE_URL` set in
`backend/.env` (already provisioned per step 8 below). The one-time manual
step above (`pip install -r backend/requirements.txt`) must run once on the
VPS for the dashboard to work — until then `serve.py` still starts and
everything else keeps working, but `/projects` replies with a clear 503.

## Restricting access (currently open)

No domain/TLS/auth yet — anyone with the IP can use it and spend the Claude key.
To lock it down, any of:

- **Basic Auth** (simplest, no domain): `apt install apache2-utils`,
  `htpasswd -c /etc/nginx/.htpasswd <user>`, then add to the nginx `server` block:
  `auth_basic "Copy Match Checker"; auth_basic_user_file /etc/nginx/.htpasswd;`
- **Firewall allowlist:** `ufw` allow 80 only from specific office/home IPs.
- **Domain + TLS + Cloudflare Access:** point a domain here, `certbot --nginx`,
  and put it behind Cloudflare Access for email-based auth.

## Local development

`cd backend && python3 serve.py` (Windows: `py serve.py`), open
`http://localhost:5500`. On localhost the front forces same-origin and serve.py
serves `../frontend/index.html`, so the whole tool runs from one process with no
nginx and no secret.
