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
sudo git clone <repo url> /opt/confcap-mcp && cd /opt/confcap-mcp
sudo npm ci && sudo npm run build && sudo npm prune --omit=dev
sudo chown -R root:root /opt/confcap-mcp                       # the service only needs to read it
sudo cp deploy/confcap-mcp.service /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now confcap-mcp
curl -s http://127.0.0.1:8787/healthz                          # {"ok":true}
```

## Publish with nginx
1. DNS: add an `A` record `mcp.deafassistant.com` pointing at the server (wherever deafassistant.com's DNS is managed).
2. `sudo cp deploy/nginx-mcp.conf /etc/nginx/sites-available/confcap-mcp && sudo ln -s /etc/nginx/sites-available/confcap-mcp /etc/nginx/sites-enabled/`
3. Add the `limit_req_zone` line from the top of that file to `/etc/nginx/conf.d/confcap-mcp-limit.conf`.
4. `sudo nginx -t && sudo systemctl reload nginx && sudo certbot --nginx -d mcp.deafassistant.com`

## Update
```bash
cd /opt/confcap-mcp && sudo git pull --ff-only && sudo npm ci && sudo npm run build && sudo npm prune --omit=dev && sudo systemctl restart confcap-mcp
```

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
