#!/bin/zsh
set -euo pipefail

ROOT_DIR="${ROOT_DIR:-$(cd "$(dirname "$0")/../../.." && pwd)}"
ENV_FILE="${ENV_FILE:-$ROOT_DIR/bridge/.env}"
PUBLIC_BRIDGE_URL="${PUBLIC_BRIDGE_URL:-https://bridge.proit.kr}"
APP_ORIGIN="${APP_ORIGIN:-https://app.99999.kr}"
SERVER_ID="${SERVER_ID:-ludulgi}"

export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"

if [[ -f "$ENV_FILE" ]]; then
  set -a
  source "$ENV_FILE"
  set +a
fi

WS_PORT="${WS_PORT:-8080}"

print_section() {
  printf "\n== %s ==\n" "$1"
}

json_summary() {
  node -e '
    let raw = "";
    process.stdin.on("data", (chunk) => raw += chunk);
    process.stdin.on("end", () => {
      try {
        const data = JSON.parse(raw);
        const pick = process.argv[1];
        if (pick === "health") {
          console.log(`ok=${data.ok === true}`);
        } else if (pick === "status") {
          console.log(`ok=${data.ok === true} server=${data.serverId || "-"} players=${data.playersOnline ?? "-"} max=${data.playersMax ?? "-"} version=${data.version || "-"} stale=${data.stale === true}`);
        } else if (pick === "admin") {
          console.log(`ok=${data.ok === true} pid=${data.process?.pid ?? "-"} uptime=${data.uptimeSec ?? "-"}s ws=${data.websocket?.active ?? "-"} sessions=${data.sessions?.active ?? "-"}/${data.sessions?.max ?? "-"} rss=${data.process?.rssMb ?? "-"}MB`);
          console.log(`status requests=${data.status?.requests ?? "-"} ok=${data.status?.ok ?? "-"} stale=${data.status?.stale ?? "-"} rejected=${data.status?.rejected ?? "-"}`);
          console.log(`security bind=${data.security?.bindHost ?? "-"} origins=${(data.security?.allowedOrigins || []).join(",") || "-"}`);
        }
      } catch (err) {
        console.log(`parse_error=${err.message}`);
        console.log(raw.slice(0, 500));
        process.exitCode = 1;
      }
    });
  ' "$1"
}

print_section "launchd"
if launchctl print "gui/$(id -u)/com.proll.minecraft-bridge" >/tmp/proll-bridge-launchd.txt 2>&1; then
  grep -E "state =|pid =" /tmp/proll-bridge-launchd.txt || true
else
  cat /tmp/proll-bridge-launchd.txt
fi

print_section "local health"
curl -fsS "http://127.0.0.1:${WS_PORT}/health" | json_summary health

print_section "public health"
curl -fsS "${PUBLIC_BRIDGE_URL}/health" | json_summary health

print_section "public status"
curl -fsS -H "Origin: ${APP_ORIGIN}" "${PUBLIC_BRIDGE_URL}/status?serverId=${SERVER_ID}" | json_summary status

print_section "admin"
curl -fsS "http://127.0.0.1:${WS_PORT}/admin/status" | json_summary admin

print_section "recent bridge errors"
tail -n 12 "$HOME/Library/Logs/proll-bridge.err.log" 2>/dev/null || true

