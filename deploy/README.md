# Self-hosting the MCP server

The hosted mode is a small Node process that holds no data. It listens on `127.0.0.1:8787` (configurable) and a reverse proxy such as nginx publishes it over https. Callers send `POST /mcp` with `Authorization: Bearer cck_...` (a developer API key; optional for public streams) and optionally `X-Confcap-Stream` (default stream) and `X-Confcap-Auth` (a secured stream's code). It is stateless: no sessions, nothing stored. 60 requests a minute per key (per address without a key). You normally do not need to host it yourself: the ConferenceCaptioning team runs one (see the main README).

Files here: `confcap-mcp.service` (systemd unit with memory and CPU caps), `nginx-mcp.conf` (reverse proxy with a rate limit), `update.sh` plus `confcap-mcp-update.service` / `.timer` (optional pull-based auto-update), `test-update.sh` (tests for the update script).

## Install (once)
Needs Node 22 or newer. Replace the paths and domain to taste.
```bash
sudo useradd --system --home /opt/confcap-mcp --shell /usr/sbin/nologin confcap-mcp
sudo git clone https://github.com/TheFirstPrototype/ConfCapMcp.git /opt/confcap-mcp && cd /opt/confcap-mcp
sudo npm ci && sudo npm run build && sudo npm prune --omit=dev
sudo chown -R root:root /opt/confcap-mcp                       # the service only needs to read it
sudo cp deploy/confcap-mcp.service /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now confcap-mcp
curl -s http://127.0.0.1:8787/healthz                          # {"ok":true}
```
Edit the `Environment=` lines in the unit to change the port, the rate limit, or `CONFCAP_API_URL` (must be https, or localhost).

## Publish with nginx
1. DNS: an `A` record for your host name pointing at the server.
2. Install `deploy/nginx-mcp.conf` as an nginx site and change `server_name`.
3. Add the rate-limit zone at the `http` level (not inside `server {}`), so it goes in its own file. Keep the single quotes so the shell does not expand `$binary_remote_addr`:
   ```bash
   echo 'limit_req_zone $binary_remote_addr zone=confcap_mcp:10m rate=5r/s;' | sudo tee /etc/nginx/conf.d/confcap-mcp-limit.conf
   ```
4. `sudo nginx -t && sudo systemctl reload nginx` and a certificate (for example `sudo certbot --nginx -d your.host.name`).

## Updates
Manual: `cd /opt/confcap-mcp && sudo git pull --ff-only && sudo npm ci && sudo npm run build && sudo npm prune --omit=dev && sudo systemctl restart confcap-mcp`.

Automatic (optional): `.github/workflows/ci.yml` tests every push and, when a push to `main` passes, moves the `production` branch to it. On the server, `update.sh` (run by the systemd timer every 2 minutes) follows that branch: it pulls, rebuilds, restarts, checks `/healthz`, and puts the previous version back if anything fails. Nothing connects into the server.
```bash
cd /opt/confcap-mcp && sudo git fetch origin production && sudo git checkout -B production origin/production
sudo cp deploy/confcap-mcp-update.service deploy/confcap-mcp-update.timer /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now confcap-mcp-update.timer
```
Roll back with `git push -f origin <good-commit>:production`. Logs: `journalctl -u confcap-mcp-update -n 30`. Test the script: `bash deploy/test-update.sh`.

## Check it works
```bash
curl -s https://your.host.name/healthz
curl -s https://your.host.name/mcp -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' \
  -H "Authorization: Bearer $CONFCAP_KEY" -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' | head -c 300
```
`HOSTED_URL=https://your.host.name FIREBASE_API_KEY=... T_EMAIL=... T_PASS=... node scripts/live-smoke.mjs` runs the full smoke test.

## Not covered
Clients that only support OAuth sign-in cannot send a static `Authorization` header; they would need an OAuth layer in front.
