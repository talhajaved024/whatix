# Whatix VPS deployment context

Last updated 2026-11-26 (Asia/Karachi). Use this as a handoff for the next deployment conversation. The VPS observations below came from commands the operator ran. Recheck live state before changing services.

## Where the conversation stopped

The operator changed the WhatsApp number and requested a clean live ERP while retaining all existing user accounts. The cutover reached these milestones:

- The local Windows container `waha-chrome` held a working `TEST_BULK` session. The operator stopped it and transferred its session archive to the VPS. Keep that Windows copy stopped while the VPS owns the linked login.
- The updater and application services were stopped for the cutover. The operator verified the production ERP backup at `/var/backups/whatix/final-number-sWFKIoJ8/erp-data.tgz`.
- The users-only staging tool verified **six accounts** and empty business tables. The existing production account encryption secret was retained. The cutover installed the staged database under `/opt/whatix/state/data/whatix.db` and kept the previous data directory at `/opt/whatix/state/data-before-final-number-sWFKIoJ8` for rollback.
- The PC login was restored into a **new session volume**, with a separate **empty media volume**. The cutover directory records their names in `new-session-volume` and `new-media-volume`. After the start request, WAHA reported **WORKING**, with the sender ending in **2558**.
- The API and web containers started. An immediate curl received a connection reset. A subsequent request through `127.0.0.1:8081/api/health` returned **HTTP 200** and `{"ok":true}`.

**Still to confirm after this cutover:** public HTTPS health, existing administrator login, six users visible in the UI, old assignments and broadcasts absent, and one outgoing message plus a live reply using the intended number. The chat contains no post-cutover output confirming that the Git timer was restarted. Earlier successful browser and messaging tests predate this number change.

Use a private browser window for acceptance. Existing browsers may retain the previous chats in IndexedDB under `dispatch-history-TEST_BULK`. Clear site data for `whatix.brandmatrix.net` on those browsers before normal use. WhatsApp can independently sync conversations belonging to the newly paired phone.

## Production layout

| Component | Working configuration |
|---|---|
| VPS | Hostinger KVM 4, Ubuntu 24.04 LTS, x86_64, IPv4 `72.62.248.232` |
| Public site and API | `https://whatix.brandmatrix.net` and `https://whatix.brandmatrix.net/api` |
| Public entry point | Host Nginx handles TLS for Whatix and also hosts Frappe. Whatix uses `/etc/nginx/conf.d/whatix.conf` and a Certbot certificate. |
| Request path | Nginx → `127.0.0.1:8081` → Caddy in `web`. Caddy serves compiled React and proxies `/api/*` to `api:8080`, including WebSockets and live event streams. |
| WhatsApp | Node calls `http://waha:3000` on the Compose network. The dashboard port is bound to `127.0.0.1:3000` on the VPS. Use an SSH tunnel for dashboard access. |
| Compose | Project `whatix`, root `/opt/whatix`, services `web`, `api`, `waha`. Effective files are `compose.yaml`, `compose.override.yaml`, `.env`, and `config/Caddyfile`. |
| Source | Windows workspace `E:\Whatsapp ERP\wa-secure-work`. VPS deployment checkout `/opt/whatix/repo`. The original uploaded source remains under `/opt/whatix/app`. |
| Storage | `state/data` is bind-mounted at `/app/data` in the API container. WAHA mounts named volumes at `/app/.sessions` and `/app/.media`. Backups live under `/var/backups/whatix`. |
| Settings | Local development uses `backend/.env`. Production uses `/opt/whatix/.env`. Preserve the production `ADMIN_USERNAME` and effective `WHATIX_PASSWORD_SECRET` when restoring users. |

The owner used Windows PowerShell for local Docker, Git and SCP, and a separate VPS Bash terminal for Compose and systemd. In this workspace direct SSH/SCP and local Docker engine access were restricted during deployment. The operator prefers one actionable step at a time, labeled by terminal, with an expected result. Credentials were previously pasted into chat; their rotation was advised but not confirmed. Keep secret values out of this file and Git.

## Resume with read-only checks

Run in **VPS Bash**:

```bash
cd /opt/whatix
docker compose ps -a
docker compose config --quiet
cid=$(docker compose ps -aq waha)
docker inspect "$cid" --format '{{.Config.Image}} {{.Image}}'
docker inspect "$cid" --format '{{range .Mounts}}{{println .Destination .Name}}{{end}}'
systemctl is-enabled whatix-update.timer
systemctl is-active whatix-update.timer
systemctl list-timers --all whatix-update.timer
cat .update-status
curl -fsS https://whatix.brandmatrix.net/api/health && echo
```

Once the owner confirms the acceptance checks, an inactive timer can be resumed with `systemctl start whatix-update.timer`. Before resuming, check the intended GitHub `main` revision: the timer can pick up commits pushed during maintenance.

## Git release workflow and pending local edits

Repository: [talhajaved024/whatix](https://github.com/talhajaved024/whatix). The VPS fetches `main` using a repository-specific read-only deploy key. Developers commit with Git or SourceTree and **push or merge to main**. A Windows commit alone does not deploy.

- The installed `/usr/local/sbin/whatix-update` comes from [deploy/update.sh](deploy/update.sh). The [timer](deploy/whatix-update.timer) runs roughly two minutes after boot and after the previous check finishes. A lock prevents concurrent deployments.
- The [Compose override](deploy/compose.override.yaml) selects `repo/backend` and `repo/frontend` for builds. The updater builds `api web`, recreates changed app containers using `--no-deps`, and checks local API and homepage health. WAHA image selection, session volumes, SQLite storage and host configuration remain server-managed.
- A verified deployment writes `live <SHA>` to `.update-status`. Compare it with `git ls-remote origin refs/heads/main`. If it says `attempt <SHA>`, inspect `journalctl -u whatix-update.service -n 60 --no-pager`. Resolve the failure before explicitly retrying the revision. An API restart can require users to sign in again.
- The initial Git deployment confirmed on the VPS was `6f864d3`. At handoff, the local branch and locally recorded `origin/main` were `bde9ae0`. These are historical observations; a fresh fetch and VPS status check establish the current revisions.
- Two tracked edits remained **uncommitted**: [backend/src/server.js](backend/src/server.js) and [backend/src/team-chat.js](backend/src/team-chat.js). Together they allow additional loopback origins outside production for HTTP and team-chat WebSockets. Targeted development/production origin checks passed against isolated databases. The sandbox blocked child processes for the full backend suite and Vite build. Review and stage the two edits together if the owner wants to release them.

## WAHA recovery and reset lessons

The working engine is WEBJS in `devlikeapro/waha:chrome`; the observed digest was `sha256:1270ff63fae9dacd48408b1abdf83f46c98e57bb4038437ad8e5d95e956cd6f7`. **Image, phone login, and ERP database are separate.** Changing a linked device's display name on the phone does not change the WAHA session name. Changes on the PC do not automatically propagate to the VPS.

1. During the earlier incident the VPS session returned `422` for sends and eventually `FAILED`. Logs showed Chrome/Puppeteer navigation timeouts. A fresh Chrome process on the same VPS image could load WhatsApp Web; the PC session could send and receive. The exact fault in the former profile was never proven.
2. The successful recovery stopped both senders, mounted the PC session read-only, archived it with Linux tar excluding Chrome's transient Singleton files, verified SHA-256 on the VPS, restored into a new volume, and recreated only WAHA. A running container initially reported session `STOPPED`; starting the existing `TEST_BULK` session made it `WORKING`.
3. The earlier recovered volume was `whatix_waha_sessions_c5095e0b`. The later final-number cutover superseded it. **Discover the current mounts** before any backup, restore, or image change. A script hard-coded to the original volume could silently back up stale data.
4. The [users-only staging script](deploy/stage-users-only.py) creates a fresh v1 database in a new directory, preserves user rows and their ID sequence, verifies integrity, and checks that business tables are empty. Copying legacy workbooks, JSON or queues into the new live data directory can reintroduce old data. Backups intentionally still contain historical data. Do not reactivate the old backend against the final sender without checking for pending broadcasts.

## Known production issues and references

- **API 502 with React 200:** a prebuilt SQLite module required `GLIBC_2.38`. The [backend Dockerfile](backend/Dockerfile) compiles SQLite in the Node 22 Bookworm image and verifies it loads.
- **Browser TLS failed while curl passed:** the Frappe HTTPS block restricted key exchange to P-384. Backing up its Nginx configuration, enabling `X25519:prime256v1:secp384r1`, validating and reloading restored browser access. Verify both sites after shared Nginx changes.
- **Same IP recorded for logins:** Nginx forwards its client IP. The [reference Caddyfile](deploy/reference/Caddyfile) trusts the observed gateway `172.18.0.1/32` and forwards the resolved IP to Express. The local change was prepared; application to the VPS and two-network login verification were not confirmed.
- **Mobile clients:** use the public HTTPS API and the ERP login/refresh cookie flow. WAHA credentials stay server-side. The backend allows one active login session per username.

For shell-by-shell instructions, start with the [maintainer handover](Whatix-Maintainer-Handover.pdf), [WAHA recovery guide](Whatix-WAHA-Session-Recovery.pdf), or [production runbook](Whatix-Production-Runbook.pdf). The [original deployment guide](Hostinger-KVM4-Deployment-Guide.pdf) predates discovery of the existing Frappe listener; its public Caddy port example conflicts with the working host layout.
