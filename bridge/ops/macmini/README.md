# Mac mini bridge operation

Use this when the bridge should run continuously on a Mac mini.

## Shape

```text
PWA / iPhone / iPad
  -> https://web app
  -> wss://bridge domain
  -> Mac mini bridge on localhost:8080
  -> Minecraft Java server
```

The web app can live on GitHub Pages. The bridge must keep running because it
owns the Microsoft token cache and the mineflayer sessions.

## Recommended exposure

Prefer one of these in order:

1. Cloudflare Tunnel: public `wss://bridge.proit.kr` without opening router ports.
2. Tailscale Funnel: simple if all deployment constraints fit Tailscale.
3. Router port forward + reverse proxy: works, but more manual security work.

Do not expose raw `ws://mac-mini-ip:8080` to normal users.

## One-time setup

On the Mac mini:

```bash
git clone https://github.com/DEV-PROLL/PROLL.github.io.git
cd PROLL.github.io
npm install
cp bridge/.env.example bridge/.env
```

Edit `bridge/.env`:

```ini
MC_HOST=99999.kr
MC_PORT=25565
MC_VERSION=1.21.11
WS_PORT=8080
BRIDGE_TOKEN=<long-random-secret>
TOKENS_DIR=./bridge/tokens
ALLOWED_ORIGINS=https://<your-web-domain>
MAX_SESSIONS=20
CHAT_RATE_LIMIT=2
```

Build and test:

```bash
npm run bridge:build
npm run bridge:start
```

In another terminal:

```bash
curl http://localhost:8080/health
```

Cloudflare Tunnel production check:

```bash
curl https://bridge.proit.kr/health
# {"ok":true}
```

Stop the manual bridge, then install launchd:

```bash
bridge/ops/macmini/install-launchd.zsh
```

## Daily commands

```bash
# status
launchctl print gui/$(id -u)/com.proll.minecraft-bridge

# logs
tail -f ~/Library/Logs/proll-bridge.out.log
tail -f ~/Library/Logs/proll-bridge.err.log

# restart after deploy/config change
launchctl kickstart -k gui/$(id -u)/com.proll.minecraft-bridge

# public health
curl https://bridge.proit.kr/health

# uninstall
bridge/ops/macmini/uninstall-launchd.zsh
```

## Update deploy

```bash
cd PROLL.github.io
git pull
npm install
npm run bridge:build
launchctl kickstart -k gui/$(id -u)/com.proll.minecraft-bridge
```

## Mac settings

- Disable sleep while plugged in.
- Keep the Mac mini on wired Ethernet if possible.
- Enable automatic restart after power failure.
- Keep `bridge/.env` and `bridge/tokens` out of Git.
