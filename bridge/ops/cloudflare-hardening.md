# Cloudflare hardening notes

This bridge is designed to stay private behind Cloudflare Tunnel and Tailscale.
The app-facing path should expose only:

- `https://bridge.proit.kr/health`
- `https://bridge.proit.kr/status`
- `https://bridge.proit.kr/client-ticket`
- `wss://bridge.proit.kr`

The bridge already enforces:

- `ALLOWED_ORIGINS=https://app.99999.kr`
- short-lived WebSocket client tickets, currently 60 seconds
- no static bridge token in the public PWA bundle
- local-only `/admin/status` and `/admin/dashboard`
- per-client rate limits:
  - WebSocket upgrade: 120/min
  - `/client-ticket`: 80/min
  - `/status`: 240/min

Recommended Cloudflare rules:

1. Keep `bridge.proit.kr` on Cloudflare Tunnel only.
2. Add a WAF custom rule to block public `/admin/*` paths on `bridge.proit.kr`.
3. Add rate limiting on `bridge.proit.kr/client-ticket`.
   - Suggested starting point: 60-80 requests per minute per client IP.
4. Add rate limiting on `bridge.proit.kr/status`.
   - Suggested starting point: 180-240 requests per minute per client IP.
5. Add a WebSocket connection rate limit on `bridge.proit.kr`.
   - Suggested starting point: 60-120 upgrade requests per minute per client IP.
6. Do not expose `127.0.0.1:8080` directly through a public route other than the tunnel.

Operational checks:

```sh
curl https://bridge.proit.kr/health
curl -H 'Origin: https://app.99999.kr' https://bridge.proit.kr/client-ticket
curl -H 'Origin: https://evil.example' https://bridge.proit.kr/client-ticket
ssh podomini 'curl -s http://127.0.0.1:8080/admin/status'
```

The dashboard should be accessed through SSH/Tailscale only:

```sh
ssh -N -L 18080:127.0.0.1:8080 podomini
open http://127.0.0.1:18080/admin/dashboard
```
