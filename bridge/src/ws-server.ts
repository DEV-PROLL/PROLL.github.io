import http from "http";
import { WebSocketServer, WebSocket, type RawData } from "ws";
import { randomUUID } from "crypto";
import { ping, type NewPingResult, type OldPingResult } from "minecraft-protocol";
import type { BridgeConfig, ClientMessage, ServerMessage } from "./types";
import { AuthService, type AuthResult, type DeviceCode } from "./auth";
import type { McSession } from "./mc-session";
import type { SessionManager } from "./session-manager";
import { assertSupportedMcVersion } from "./mc-versions";

const MAX_WS_MESSAGE_BYTES = 64 * 1024;
const PENDING_LOGIN_TTL_MS = 20 * 60 * 1000;
const PENDING_LOGIN_RESULT_TTL_MS = 10 * 60 * 1000;

interface ClientState {
  ws: WebSocket;
  sessionKey: string;          // unique per WS connection
  userId: string | null;       // populated after auth_ok
  sessionId: string | null;    // user + version key in SessionManager
  mcSession: McSession | null; // populated after auth_ok
  listener: ((msg: ServerMessage) => void) | null;
  pendingLoginRequestId: string | null;
}

interface StatusCache {
  expiresAt: number;
  promise: Promise<ServerStatusBody> | null;
  value: ServerStatusBody | null;
}

interface ServerStatusBody {
  ok: boolean;
  host: string;
  port: number;
  updatedAt: number;
  playersOnline?: number;
  playersMax?: number;
  version?: string;
  latencyMs?: number;
  error?: string;
}

interface BridgeEvent {
  ts: number;
  kind: string;
  detail: string;
}

interface RuntimeStats {
  startedAt: number;
  activeWs: number;
  totalWs: number;
  rejectedToken: number;
  rejectedOrigin: number;
  messagesIn: number;
  messagesRejected: number;
  errorsOut: number;
  recentEvents: BridgeEvent[];
}

interface PendingLogin {
  requestId: string;
  startedAt: number;
  updatedAt: number;
  expiresAt: number;
  code: DeviceCode | null;
  promise: Promise<AuthResult>;
}

export function startWsServer(
  cfg: BridgeConfig,
  auth: AuthService,
  sessions: SessionManager,
): http.Server {
  const statusCache: StatusCache = {
    expiresAt: 0,
    promise: null,
    value: null,
  };
  const stats: RuntimeStats = {
    startedAt: Date.now(),
    activeWs: 0,
    totalWs: 0,
    rejectedToken: 0,
    rejectedOrigin: 0,
    messagesIn: 0,
    messagesRejected: 0,
    errorsOut: 0,
    recentEvents: [],
  };
  const pendingLogins = new Map<string, PendingLogin>();

  const httpServer = http.createServer((req, res) => {
    void handleHttpRequest(req, res, cfg, statusCache, stats, sessions, pendingLogins);
  });

  const wss = new WebSocketServer({
    server: httpServer,
    verifyClient: (info, done) => {
      if (cfg.bridgeToken) {
        const url = new URL(info.req.url ?? "/", "http://bridge.local");
        if (!isAuthorizedRequest(info.req, cfg, url)) {
          stats.rejectedToken += 1;
          recordEvent(stats, "ws_reject", `invalid token from ${maskedClientIp(info.req)}`);
          return done(false, 401, "invalid bridge token");
        }
      }
      if (!cfg.allowedOrigins) return done(true);
      const origin = info.origin ?? "";
      if (cfg.allowedOrigins.includes(origin)) return done(true);
      stats.rejectedOrigin += 1;
      recordEvent(stats, "ws_reject", `origin ${origin || "(none)"}`);
      return done(false, 403, "origin not allowed");
    },
  });

  wss.on("connection", (ws) => {
    stats.activeWs += 1;
    stats.totalWs += 1;
    recordEvent(stats, "ws_open", maskedClientIp(wsRemoteAddress(ws)));
    const state: ClientState = {
      ws,
      sessionKey: randomUUID(),
      userId: null,
      sessionId: null,
      mcSession: null,
      listener: null,
      pendingLoginRequestId: null,
    };

    const send = (msg: ServerMessage) => {
      if (ws.readyState === ws.OPEN) {
        if (msg.type === "error" || msg.type === "auth_failed" || msg.type === "kicked") {
          stats.errorsOut += 1;
        }
        ws.send(JSON.stringify(msg));
      }
    };

    ws.on("message", (data) => {
      const size = rawDataSize(data);
      if (size > MAX_WS_MESSAGE_BYTES) {
        stats.messagesRejected += 1;
        recordEvent(stats, "ws_reject", `message too large (${size} bytes)`);
        ws.close(1009, "message too large");
        return;
      }
      stats.messagesIn += 1;
      let parsed: ClientMessage;
      try {
        parsed = JSON.parse(rawDataToString(data));
      } catch {
        stats.messagesRejected += 1;
        send({ type: "error", text: "invalid JSON" });
        return;
      }
      recordEvent(stats, "ws_message", parsed.type);
      handleMessage(parsed, state, send, cfg, auth, sessions, pendingLogins).catch((err) => {
        send({ type: "error", text: err?.message ?? String(err) });
      });
    });

    ws.on("close", () => {
      stats.activeWs = Math.max(0, stats.activeWs - 1);
      recordEvent(stats, "ws_close", state.userId ? "authenticated" : "anonymous");
      if (state.sessionId && state.listener) {
        sessions.detach(state.sessionId, state.listener);
      }
    });

    ws.on("error", () => {
      // Mirror close cleanup; ws will fire 'close' too but be defensive.
      if (state.sessionId && state.listener) {
        sessions.detach(state.sessionId, state.listener);
        state.listener = null;
      }
    });
  });

  httpServer.listen(cfg.wsPort, cfg.bindHost, () => {
    console.log(`[bridge] WS+HTTP listening on ${cfg.bindHost}:${cfg.wsPort}`);
  });

  return httpServer;
}

async function handleHttpRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  cfg: BridgeConfig,
  statusCache: StatusCache,
  stats: RuntimeStats,
  sessions: SessionManager,
  pendingLogins: Map<string, PendingLogin>,
): Promise<void> {
  const url = new URL(req.url ?? "/", "http://bridge.local");
  const headers: Record<string, string> = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Authorization, Cache-Control, Content-Type",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
  };

  if (req.method === "OPTIONS") {
    res.writeHead(204, headers);
    res.end();
    return;
  }

  if (url.pathname === "/health") {
    res.writeHead(200, { ...headers, "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  if (url.pathname === "/status") {
    if (!isAuthorizedRequest(req, cfg, url)) {
      res.writeHead(401, { ...headers, "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: "invalid bridge token" }));
      return;
    }

    const status = await getServerStatus(cfg, statusCache);
    res.writeHead(200, {
      ...headers,
      "Cache-Control": "no-store",
      "Content-Type": "application/json",
    });
    res.end(JSON.stringify(status));
    return;
  }

  if (url.pathname === "/admin/status") {
    if (!isAuthorizedRequest(req, cfg, url)) {
      res.writeHead(401, { ...headers, "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: "invalid bridge token" }));
      return;
    }
    res.writeHead(200, {
      ...headers,
      "Cache-Control": "no-store",
      "Content-Type": "application/json",
    });
    res.end(JSON.stringify(buildAdminStatus(cfg, stats, sessions, pendingLogins)));
    return;
  }

  if (url.pathname === "/admin/dashboard") {
    if (!isAuthorizedRequest(req, cfg, url)) {
      res.writeHead(401, { ...headers, "Content-Type": "text/plain; charset=utf-8" });
      res.end("invalid bridge token");
      return;
    }
    res.writeHead(200, {
      ...headers,
      "Cache-Control": "no-store",
      "Content-Security-Policy": "default-src 'self'; connect-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src 'self' data:; base-uri 'none'; frame-ancestors 'none'",
      "Content-Type": "text/html; charset=utf-8",
    });
    res.end(renderAdminDashboard());
    return;
  }

  res.writeHead(404, headers);
  res.end();
}

function isAuthorizedRequest(
  req: http.IncomingMessage,
  cfg: BridgeConfig,
  url: URL,
): boolean {
  if (!cfg.bridgeToken) return true;
  const authHeader = req.headers.authorization;
  const bearerToken =
    typeof authHeader === "string" && authHeader.startsWith("Bearer ")
      ? authHeader.slice("Bearer ".length).trim()
      : null;
  const queryToken = url.searchParams.get("token");
  return queryToken === cfg.bridgeToken || bearerToken === cfg.bridgeToken;
}

function rawDataSize(data: RawData): number {
  if (typeof data === "string") return Buffer.byteLength(data);
  if (Buffer.isBuffer(data)) return data.byteLength;
  if (Array.isArray(data)) return data.reduce((sum, item) => sum + item.byteLength, 0);
  if (data instanceof ArrayBuffer) return data.byteLength;
  return 0;
}

function rawDataToString(data: RawData): string {
  if (typeof data === "string") return data;
  if (Buffer.isBuffer(data)) return data.toString("utf8");
  if (Array.isArray(data)) return Buffer.concat(data).toString("utf8");
  return Buffer.from(data).toString("utf8");
}

function recordEvent(stats: RuntimeStats, kind: string, detail: string): void {
  stats.recentEvents.push({ ts: Date.now(), kind, detail });
  if (stats.recentEvents.length > 80) {
    stats.recentEvents.splice(0, stats.recentEvents.length - 80);
  }
}

function maskedClientIp(source: unknown): string {
  const req = source as {
    headers?: http.IncomingHttpHeaders;
    socket?: { remoteAddress?: string };
    remoteAddress?: string;
  };
  const forwarded = req.headers?.["x-forwarded-for"];
  const ip =
    typeof forwarded === "string" && forwarded.trim()
      ? forwarded.split(",")[0]?.trim()
      : req.socket?.remoteAddress ?? req.remoteAddress;
  if (!ip) return "unknown";
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(ip)) {
    return ip.replace(/\.\d{1,3}$/, ".0");
  }
  if (ip.startsWith("::ffff:")) {
    return maskedClientIp({ remoteAddress: ip.slice("::ffff:".length) });
  }
  const parts = ip.split(":").filter(Boolean);
  return parts.length > 2 ? `${parts.slice(0, 2).join(":")}::` : ip;
}

function wsRemoteAddress(ws: WebSocket): { remoteAddress?: string } {
  return (ws as unknown as { _socket?: { remoteAddress?: string } })._socket ?? {};
}

function buildAdminStatus(
  cfg: BridgeConfig,
  stats: RuntimeStats,
  sessions: SessionManager,
  pendingLogins: Map<string, PendingLogin>,
) {
  purgePendingLogins(pendingLogins);
  const mem = process.memoryUsage();
  return {
    ok: true,
    now: Date.now(),
    startedAt: stats.startedAt,
    uptimeSec: Math.round((Date.now() - stats.startedAt) / 1000),
    target: {
      host: cfg.mcHost,
      port: cfg.mcPort,
      version: cfg.mcVersion,
    },
    security: {
      bindHost: cfg.bindHost,
      tokenRequired: Boolean(cfg.bridgeToken),
      allowedOrigins: cfg.allowedOrigins ?? ["*"],
      maxMessageBytes: MAX_WS_MESSAGE_BYTES,
    },
    process: {
      pid: process.pid,
      node: process.version,
      rssMb: Math.round(mem.rss / 1024 / 1024),
      heapUsedMb: Math.round(mem.heapUsed / 1024 / 1024),
      heapTotalMb: Math.round(mem.heapTotal / 1024 / 1024),
    },
    websocket: {
      active: stats.activeWs,
      total: stats.totalWs,
      rejectedToken: stats.rejectedToken,
      rejectedOrigin: stats.rejectedOrigin,
      messagesIn: stats.messagesIn,
      messagesRejected: stats.messagesRejected,
      errorsOut: stats.errorsOut,
    },
    auth: {
      pendingLogins: pendingLogins.size,
    },
    sessions: sessions.stats(),
    recentEvents: stats.recentEvents.slice(-50),
  };
}

function renderAdminDashboard(): string {
  return `<!doctype html>
<html lang="ko">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>루둘기 브릿지 대시보드</title>
  <style>
    :root { color-scheme: dark; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background: #080c12; color: #edf2f7; }
    body { margin: 0; padding: 24px; background: radial-gradient(circle at top, rgba(46,160,67,.18), transparent 32rem), #080c12; }
    main { max-width: 1120px; margin: 0 auto; }
    h1 { margin: 0 0 4px; font-size: 28px; }
    .muted { color: #8b949e; }
    .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(210px, 1fr)); gap: 12px; margin: 18px 0; }
    .card { border: 1px solid rgba(240,246,252,.12); background: rgba(13,17,23,.82); border-radius: 14px; padding: 14px; box-shadow: 0 14px 40px rgba(0,0,0,.24); }
    .label { color: #8b949e; font-size: 12px; font-weight: 700; text-transform: uppercase; }
    .value { font-size: 24px; font-weight: 800; margin-top: 6px; }
    table { width: 100%; border-collapse: collapse; overflow: hidden; border-radius: 12px; }
    th, td { padding: 10px 9px; border-bottom: 1px solid rgba(240,246,252,.08); text-align: left; font-size: 13px; }
    th { color: #8b949e; font-size: 12px; }
    .ok { color: #3fb950; font-weight: 800; }
    .warn { color: #f2cc60; font-weight: 800; }
    pre { white-space: pre-wrap; word-break: break-word; margin: 0; color: #c9d1d9; font-size: 12px; line-height: 1.55; }
  </style>
</head>
<body>
  <main>
    <h1>루둘기 브릿지</h1>
    <div class="muted" id="subtitle">상태를 불러오는 중...</div>
    <section class="grid" id="cards"></section>
    <section class="card">
      <h2>세션</h2>
      <div id="sessions"></div>
    </section>
    <section class="card" style="margin-top:12px">
      <h2>최근 이벤트</h2>
      <pre id="events"></pre>
    </section>
  </main>
  <script>
    const params = window.location.search || "";
    const fmtTime = (ts) => ts ? new Date(ts).toLocaleString("ko-KR") : "-";
    const el = (tag, text, className) => {
      const node = document.createElement(tag);
      if (text != null) node.textContent = String(text);
      if (className) node.className = className;
      return node;
    };
    function card(label, value) {
      const wrap = el("div", null, "card");
      wrap.append(el("div", label, "label"), el("div", value, "value"));
      return wrap;
    }
    function render(data) {
      document.getElementById("subtitle").textContent =
        data.target.host + ":" + data.target.port + " · MC " + data.target.version +
        " · " + fmtTime(data.now);
      const cards = document.getElementById("cards");
      cards.replaceChildren(
        card("Active WS", data.websocket.active),
        card("Sessions", data.sessions.active + "/" + data.sessions.max),
        card("Pending Login", data.auth.pendingLogins),
        card("Memory RSS", data.process.rssMb + " MB"),
        card("Rejected", data.websocket.rejectedToken + data.websocket.rejectedOrigin + data.websocket.messagesRejected),
        card("Messages", data.websocket.messagesIn),
        card("Uptime", Math.floor(data.uptimeSec / 60) + "분")
      );
      const sessions = document.getElementById("sessions");
      if (!data.sessions.sessions.length) {
        sessions.textContent = "활성 세션 없음";
      } else {
        const table = el("table");
        const head = el("tr");
        ["IGN", "Version", "Ref", "Players", "State", "Last attach"].forEach((name) => head.append(el("th", name)));
        table.append(head);
        data.sessions.sessions.forEach((session) => {
          const row = el("tr");
          row.append(
            el("td", session.ign || session.userId),
            el("td", session.mcVersion || "-"),
            el("td", session.refCount),
            el("td", session.playersOnline ?? "-"),
            el("td", session.connected ? "online" : session.closing ? "closing" : "offline", session.connected ? "ok" : "warn"),
            el("td", fmtTime(session.lastAttachedAt))
          );
          table.append(row);
        });
        sessions.replaceChildren(table);
      }
      document.getElementById("events").textContent = data.recentEvents
        .slice().reverse()
        .map((event) => "[" + fmtTime(event.ts) + "] " + event.kind + " · " + event.detail)
        .join("\\n") || "이벤트 없음";
    }
    async function refresh() {
      try {
        const res = await fetch("/admin/status" + params, { cache: "no-store" });
        render(await res.json());
      } catch (err) {
        document.getElementById("subtitle").textContent = "상태 조회 실패: " + err;
      }
    }
    refresh();
    setInterval(refresh, 5000);
  </script>
</body>
</html>`;
}

async function getServerStatus(
  cfg: BridgeConfig,
  cache: StatusCache,
): Promise<ServerStatusBody> {
  const now = Date.now();
  if (cache.value && cache.expiresAt > now) return cache.value;
  if (cache.promise) return cache.promise;

  cache.promise = pingMinecraftServer(cfg)
    .then((status) => {
      cache.value = status;
      cache.expiresAt = Date.now() + (status.ok ? 5_000 : 2_000);
      return status;
    })
    .finally(() => {
      cache.promise = null;
    });

  return cache.promise;
}

async function pingMinecraftServer(cfg: BridgeConfig): Promise<ServerStatusBody> {
  try {
    const result = await ping({
      host: cfg.mcHost,
      port: cfg.mcPort,
      version: cfg.mcVersion,
      closeTimeout: 4_000,
      noPongTimeout: 4_000,
    });
    const normalized = normalizePingResult(result);
    return {
      ok: true,
      host: cfg.mcHost,
      port: cfg.mcPort,
      updatedAt: Date.now(),
      ...normalized,
    };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      host: cfg.mcHost,
      port: cfg.mcPort,
      updatedAt: Date.now(),
      error: reason,
    };
  }
}

function normalizePingResult(
  result: OldPingResult | NewPingResult,
): Partial<ServerStatusBody> {
  if ("players" in result) {
    return {
      playersOnline: result.players.online,
      playersMax: result.players.max,
      version: result.version.name,
      latencyMs: Math.round(result.latency),
    };
  }

  return {
    playersOnline: result.playerCount,
    playersMax: result.maxPlayers,
    version: result.version,
  };
}

async function handleMessage(
  msg: ClientMessage,
  state: ClientState,
  send: (m: ServerMessage) => void,
  cfg: BridgeConfig,
  auth: AuthService,
  sessions: SessionManager,
  pendingLogins: Map<string, PendingLogin>,
): Promise<void> {
  switch (msg.type) {
    case "ping":
      send({ type: "pong" });
      return;

    case "auth_start": {
      if (state.userId) {
        send({ type: "error", text: "already authenticated" });
        return;
      }
      let mcVersion: string;
      try {
        mcVersion = resolveMcVersion(msg.mcVersion, cfg);
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        send({ type: "auth_failed", reason });
        return;
      }
      const requestId = normalizeLoginRequestId(msg.loginRequestId) ?? state.sessionKey;
      const pending = getOrCreatePendingLogin(pendingLogins, auth, requestId);
      if (state.pendingLoginRequestId === requestId) {
        replayPendingLoginCode(pending, send);
        return;
      }
      state.pendingLoginRequestId = requestId;
      replayPendingLoginCode(pending, send);
      try {
        const result = await pending.promise;
        pending.expiresAt = Date.now() + PENDING_LOGIN_RESULT_TTL_MS;
        if (!isClientOpen(state)) return;
        state.pendingLoginRequestId = null;
        attachToSession(result, mcVersion, state, send, sessions, {
          rebuildExisting: true,
        });
      } catch (err) {
        pending.expiresAt = Date.now() + PENDING_LOGIN_RESULT_TTL_MS;
        if (!isClientOpen(state)) return;
        state.pendingLoginRequestId = null;
        const reason = err instanceof Error ? err.message : String(err);
        send({ type: "auth_failed", reason });
      }
      return;
    }

    case "auth_cached": {
      let mcVersion: string;
      try {
        mcVersion = resolveMcVersion(msg.mcVersion, cfg);
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        send({ type: "auth_failed", reason });
        return;
      }
      const cached = await auth.loadCached(msg.userId);
      if (!cached) {
        send({ type: "auth_failed", reason: "no cached login for this user" });
        return;
      }
      attachToSession(cached, mcVersion, state, send, sessions);
      return;
    }

    case "send": {
      if (!state.mcSession) {
        send({ type: "error", text: "not authenticated" });
        return;
      }
      const result = state.mcSession.sendChat(msg.text, cfg.chatRateLimit);
      if (!result.ok) {
        send({ type: "error", text: result.reason });
      }
      return;
    }

    case "complete": {
      if (!state.mcSession) {
        send({
          type: "completion",
          requestId: msg.requestId,
          text: msg.text,
          matches: [],
        });
        return;
      }
      const matches = await state.mcSession.complete(msg.text);
      send({
        type: "completion",
        requestId: msg.requestId,
        text: msg.text,
        matches,
      });
      return;
    }

    case "window_click": {
      if (!state.mcSession) {
        send({ type: "error", text: "not authenticated" });
        return;
      }
      const mouseButton = msg.mouseButton === 1 ? 1 : 0;
      const result = await state.mcSession.clickWindow(msg.slot, mouseButton);
      if (!result.ok) {
        send({ type: "error", text: result.reason });
      }
      return;
    }

    case "window_close": {
      if (!state.mcSession) {
        send({ type: "error", text: "not authenticated" });
        return;
      }
      const result = state.mcSession.closeWindow();
      if (!result.ok) {
        send({ type: "error", text: result.reason });
      }
      return;
    }

    case "forget_account": {
      const userId = msg.userId.trim();
      if (!userId) {
        send({ type: "error", text: "invalid account id" });
        return;
      }
      if (state.sessionId && state.listener) {
        sessions.detach(state.sessionId, state.listener);
        state.listener = null;
        state.mcSession = null;
        state.userId = null;
        state.sessionId = null;
      }
      sessions.forceCloseUser(userId);
      try {
        await auth.removeCached(userId);
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        send({ type: "error", text: reason });
      }
      return;
    }

    case "logout": {
      if (state.sessionId && state.listener) {
        sessions.detach(state.sessionId, state.listener);
        sessions.forceClose(state.sessionId);
        state.listener = null;
        state.mcSession = null;
        state.userId = null;
        state.sessionId = null;
      }
      return;
    }

    default: {
      const _exhaustive: never = msg;
      void _exhaustive;
      send({ type: "error", text: "unknown message type" });
    }
  }
}

function getOrCreatePendingLogin(
  pendingLogins: Map<string, PendingLogin>,
  auth: AuthService,
  requestId: string,
): PendingLogin {
  purgePendingLogins(pendingLogins);
  const existing = pendingLogins.get(requestId);
  if (existing) {
    existing.updatedAt = Date.now();
    return existing;
  }

  const now = Date.now();
  const entry: PendingLogin = {
    requestId,
    startedAt: now,
    updatedAt: now,
    expiresAt: now + PENDING_LOGIN_TTL_MS,
    code: null,
    promise: Promise.resolve(null as never),
  };

  entry.promise = auth.loginWithDeviceCode(requestId, (code) => {
    entry.code = code;
    entry.updatedAt = Date.now();
    entry.expiresAt = Date.now() + Math.max(30_000, code.expires_in * 1000);
  });
  entry.promise.finally(() => {
    entry.updatedAt = Date.now();
    entry.expiresAt = Date.now() + PENDING_LOGIN_RESULT_TTL_MS;
  }).catch(() => {
    // The caller awaiting `entry.promise` surfaces the normalized auth error.
  });
  pendingLogins.set(requestId, entry);
  return entry;
}

function purgePendingLogins(pendingLogins: Map<string, PendingLogin>): void {
  const now = Date.now();
  for (const [requestId, entry] of pendingLogins) {
    if (entry.expiresAt < now) {
      pendingLogins.delete(requestId);
    }
  }
}

function replayPendingLoginCode(
  pending: PendingLogin,
  send: (m: ServerMessage) => void,
): void {
  const code = pending.code;
  if (!code) return;
  send({
    type: "auth_code",
    code: code.user_code,
    verificationUri: code.verification_uri,
    expiresInSec: Math.max(1, Math.ceil((pending.expiresAt - Date.now()) / 1000)),
  });
}

function normalizeLoginRequestId(value: string | undefined): string | null {
  const trimmed = value?.trim();
  if (!trimmed) return null;
  return /^[A-Za-z0-9_-]{12,80}$/.test(trimmed) ? trimmed : null;
}

function isClientOpen(state: ClientState): boolean {
  return state.ws.readyState === WebSocket.OPEN;
}

function attachToSession(
  authResult: {
    userId: string;
    cacheUserId: string;
    ign: string;
    uuid: string;
    profilesFolder: string;
  },
  mcVersion: string,
  state: ClientState,
  send: (m: ServerMessage) => void,
  sessions: SessionManager,
  options: { rebuildExisting?: boolean } = {},
): void {
  detachClientSession(state, sessions);

  const listener = (m: ServerMessage) => {
    send(m);
    if (m.type === "status" && !m.connected) {
      state.mcSession = null;
      state.userId = null;
      // Keep sessionId/listener until the next attach or WS close so the
      // listener can be detached cleanly even after a bot-side disconnect.
    }
  };
  try {
    const { userId, cacheUserId, ign, uuid, profilesFolder } = authResult;
    if (options.rebuildExisting) {
      sessions.forceCloseUser(userId);
    }
    const sessionId = `${userId}@${mcVersion}`;
    const mc = sessions.attach(userId, cacheUserId, profilesFolder, mcVersion, listener);
    state.userId = userId;
    state.sessionId = sessionId;
    state.listener = listener;
    state.mcSession = mc;
    send({ type: "auth_ok", userId, ign, uuid });
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    send({ type: "auth_failed", reason });
  }
}

function detachClientSession(state: ClientState, sessions: SessionManager): void {
  if (!state.sessionId || !state.listener) return;
  sessions.detach(state.sessionId, state.listener);
  state.listener = null;
  state.mcSession = null;
  state.userId = null;
  state.sessionId = null;
}

function resolveMcVersion(requested: string | undefined, cfg: BridgeConfig): string {
  return assertSupportedMcVersion(requested?.trim() || cfg.mcVersion);
}
