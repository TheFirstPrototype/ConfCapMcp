# Hosting the MCP server (separate service on the existing EC2 box)

The hosted server is a small Node process (about 60 to 100 MB) that holds no data. It listens on `127.0.0.1:8787` and nginx publishes it at `https://mcp.deafassistant.com/mcp`. It is **not** part of the .NET API: a deploy or a bug here can never stop live captions, and the API's deploy never restarts it. It is capped by systemd (`MemoryMax=150M`, `CPUQuota=20%`).

Callers send `POST /mcp` with `Authorization: Bearer cck_...` (a developer API key, optional for public streams), and optionally `X-Confcap-Stream` (default stream) and `X-Confcap-Auth` (a secured stream's code). It is stateless: no sessions, nothing stored. 60 requests a minute per key (per address without a key).

## Check the box first
```bash
free -m                      # want >= 300 MB "available" with the API running
node -v                      # needs >= 22; if missing: curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash - && sudo apt-get install -y nodejs
```

## Install (once)
```bash
sudo useradd --system --home /opt/confcap-mcp --shell /usr/sbin/nologin confcap-mcp
# The repo is private, so the server needs a read-only deploy key (a plain `sudo git clone https://...` has no credentials and fails):
sudo ssh-keygen -t ed25519 -N "" -C confcap-mcp-deploy -f /root/.ssh/confcap_mcp_deploy
sudo cat /root/.ssh/confcap_mcp_deploy.pub        # paste into GitHub: ConfCapMcp > Settings > Deploy keys > Add (leave "Allow write access" OFF)
sudo GIT_SSH_COMMAND='ssh -i /root/.ssh/confcap_mcp_deploy -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new' \
  git clone git@github.com:TheFirstPrototype/ConfCapMcp.git /opt/confcap-mcp && cd /opt/confcap-mcp
sudo git config core.sshCommand 'ssh -i /root/.ssh/confcap_mcp_deploy -o IdentitiesOnly=yes'   # so "git pull" in Update works too
sudo npm ci && sudo npm run build && sudo npm prune --omit=dev
sudo chown -R root:root /opt/confcap-mcp                       # the service only needs to read it
sudo cp deploy/confcap-mcp.service /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now confcap-mcp
curl -s http://127.0.0.1:8787/healthz                          # {"ok":true}
```

## Publish with nginx
1. DNS (Hostinger > deafassistant.com > DNS records): type `A`, name `mcp`, content = the server's IP (the same as the `api` record, 18.117.193.30), TTL 300. Wait until `dig +short mcp.deafassistant.com` shows it before running certbot.
2. `sudo cp deploy/nginx-mcp.conf /etc/nginx/sites-available/confcap-mcp && sudo ln -s /etc/nginx/sites-available/confcap-mcp /etc/nginx/sites-enabled/`
3. Add the rate-limit zone. It must sit at the `http` level (not inside `server {}`), so it goes in its own file in `conf.d/`. Keep the single quotes so the shell does not expand `$binary_remote_addr`:
   ```bash
   echo 'limit_req_zone $binary_remote_addr zone=confcap_mcp:10m rate=5r/s;' | sudo tee /etc/nginx/conf.d/confcap-mcp-limit.conf
   ```
   If `nginx -t` then says `zone "confcap_mcp" is already bound`, the line exists twice: `sudo grep -r confcap_mcp /etc/nginx`. If it says `unknown "confcap_mcp" zone`, check that `/etc/nginx/nginx.conf` has `include /etc/nginx/conf.d/*.conf;` inside `http {}`.
4. `sudo nginx -t && sudo systemctl reload nginx && sudo certbot --nginx -d mcp.deafassistant.com`

## Update (automatic, no SSH)
A push to `main` is built and tested by GitHub Actions (`.github/workflows/ci.yml`). If the tests pass, the workflow points the `production` branch at that commit. The server runs `deploy/update.sh` every 2 minutes (a systemd timer); when `production` has moved it pulls, rebuilds, restarts the service and checks `/healthz`. If the build or the health check fails it puts the previous version back, so a bad commit cannot leave the server down. Nothing connects into the server: it only reads from GitHub with the read-only deploy key.

One-time setup on the server (after the install above):
```bash
cd /opt/confcap-mcp && sudo git fetch origin production && sudo git checkout -B production origin/production
sudo cp deploy/confcap-mcp-update.service deploy/confcap-mcp-update.timer /etc/systemd/system/
sudo chmod +x deploy/update.sh
sudo systemctl daemon-reload && sudo systemctl enable --now confcap-mcp-update.timer
systemctl list-timers confcap-mcp-update.timer          # shows the next run
```
(The first push to `main` after adding the workflow creates the `production` branch; until then `git fetch origin production` fails.)

Day to day:
- Watch it: `journalctl -u confcap-mcp-update -n 30` (lines start with `[confcap-mcp-update]`). Update right now: `sudo systemctl start confcap-mcp-update`.
- Roll back: `git push -f origin <good-commit>:production` from anywhere. The server follows within 2 minutes.
- Want an approval click before anything goes live? GitHub: Settings > Environments > production > Required reviewers.
- Pause deploys: `sudo systemctl stop confcap-mcp-update.timer`.
- Test the update script itself (no server needed): `bash deploy/test-update.sh`.

Manual update, if you ever need it: `cd /opt/confcap-mcp && sudo ./deploy/update.sh`.

## Check it works from anywhere
```bash
curl -s https://mcp.deafassistant.com/healthz
curl -s https://mcp.deafassistant.com/mcp -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' \
  -H "Authorization: Bearer $CONFCAP_KEY" -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' | head -c 300
```
Or point an MCP client at the URL with the header `Authorization: Bearer cck_...`. `HOSTED_URL=https://mcp.deafassistant.com node scripts/live-smoke.mjs` runs the full smoke test through it.

## Watch it
`systemctl status confcap-mcp`, `journalctl -u confcap-mcp -n 50`, and `systemctl show confcap-mcp -p MemoryCurrent`. If it keeps hitting `MemoryMax`, move it to its own host (the code does not change).

## Not covered
Clients that only support OAuth sign-in (some hosted connectors) cannot send a static `Authorization` header. They would need an OAuth layer in front; that is a separate piece of work.
