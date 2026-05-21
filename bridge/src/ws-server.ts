import http from "http";
import { WebSocketServer, WebSocket, type RawData } from "ws";
import { randomUUID } from "crypto";
import { ping, type NewPingResult, type OldPingResult } from "minecraft-protocol";
import type { BridgeConfig, BridgeServerProfile, ClientMessage, ServerMessage } from "./types";
import { AuthService, type AuthResult, type DeviceCode } from "./auth";
import type { McSession } from "./mc-session";
import type { SessionManager } from "./session-manager";
import { assertSupportedMcVersion } from "./mc-versions";

const MAX_WS_MESSAGE_BYTES = 64 * 1024;
const PENDING_LOGIN_TTL_MS = 20 * 60 * 1000;
const PENDING_LOGIN_RESULT_TTL_MS = 10 * 60 * 1000;
const CLIENT_TICKET_TTL_MS = 60 * 1000;
const STATUS_STALE_TTL_MS = 60 * 1000;
const RATE_WINDOW_MS = 60 * 1000;
const WS_UPGRADE_RATE_LIMIT = 120;
const CLIENT_TICKET_RATE_LIMIT = 80;
const STATUS_RATE_LIMIT = 240;

interface ClientState {
  ws: WebSocket;
  sessionKey: string;          // unique per WS connection
  userId: string | null;       // populated after auth_ok
  authenticatedUserId: string | null; // retained after temporary bot disconnects
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
  serverId: string;
  name: string;
  host: string;
  port: number;
  updatedAt: number;
  playersOnline?: number;
  playersMax?: number;
  version?: string;
  latencyMs?: number;
  stale?: boolean;
  error?: string;
}

interface BridgeEvent {
  ts: number;
  kind: string;
  detail: string;
}

interface RecentIssue {
  ts: number;
  userId: string | null;
  sessionId: string | null;
  reason: string;
}

interface MemorySample {
  ts: number;
  rssMb: number;
  heapUsedMb: number;
  activeWs: number;
  activeSessions: number;
}

interface RuntimeStats {
  startedAt: number;
  activeWs: number;
  activeAnonymousWs: number;
  totalWs: number;
  anonymousWsOpens: number;
  anonymousWsCloses: number;
  authenticatedWsCloses: number;
  rejectedToken: number;
  rejectedOrigin: number;
  rateLimited: number;
  clientTicketsIssued: number;
  clientTicketsAccepted: number;
  clientTicketsRejected: number;
  clientTicketsExpired: number;
  statusRequests: number;
  statusOk: number;
  statusStale: number;
  statusRejected: number;
  messagesIn: number;
  messagesRejected: number;
  errorsOut: number;
  cachedAuths: number;
  deviceLoginStarts: number;
  deviceLoginCompletions: number;
  sessionCreates: number;
  sessionReuses: number;
  graceReconnects: number;
  kicked: number;
  recentKicks: RecentIssue[];
  recentErrors: RecentIssue[];
  memorySamples: MemorySample[];
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

interface ClientTicket {
  origin: string;
  expiresAt: number;
}

interface RateLimitBucket {
  resetAt: number;
  count: number;
}

export function startWsServer(
  cfg: BridgeConfig,
  auth: AuthService,
  sessions: SessionManager,
): http.Server {
  const statusCaches = new Map<string, StatusCache>();
  const stats: RuntimeStats = {
    startedAt: Date.now(),
    activeWs: 0,
    activeAnonymousWs: 0,
    totalWs: 0,
    anonymousWsOpens: 0,
    anonymousWsCloses: 0,
    authenticatedWsCloses: 0,
    rejectedToken: 0,
    rejectedOrigin: 0,
    rateLimited: 0,
    clientTicketsIssued: 0,
    clientTicketsAccepted: 0,
    clientTicketsRejected: 0,
    clientTicketsExpired: 0,
    statusRequests: 0,
    statusOk: 0,
    statusStale: 0,
    statusRejected: 0,
    messagesIn: 0,
    messagesRejected: 0,
    errorsOut: 0,
    cachedAuths: 0,
    deviceLoginStarts: 0,
    deviceLoginCompletions: 0,
    sessionCreates: 0,
    sessionReuses: 0,
    graceReconnects: 0,
    kicked: 0,
    recentKicks: [],
    recentErrors: [],
    memorySamples: [],
    recentEvents: [],
  };
  const pendingLogins = new Map<string, PendingLogin>();
  const clientTickets = new Map<string, ClientTicket>();
  const rateLimits = new Map<string, RateLimitBucket>();

  const httpServer = http.createServer((req, res) => {
    void handleHttpRequest(
      req,
      res,
      cfg,
      statusCaches,
      stats,
      sessions,
      pendingLogins,
      clientTickets,
      rateLimits,
    );
  });

  const wss = new WebSocketServer({
    server: httpServer,
    verifyClient: (info, done) => {
      if (isRateLimited(stats, rateLimits, info.req, "ws", WS_UPGRADE_RATE_LIMIT)) {
        recordEvent(stats, "rate_limit", `ws ${maskedClientIp(info.req)}`);
        return done(false, 429, "rate limited");
      }
      if (cfg.allowedOrigins) {
        const origin = info.origin ?? "";
        if (!isAllowedOrigin(origin, cfg)) {
          stats.rejectedOrigin += 1;
          recordEvent(stats, "ws_reject", `origin ${origin || "(none)"}`);
          return done(false, 403, "origin not allowed");
        }
      }
      if (cfg.bridgeToken) {
        const url = new URL(info.req.url ?? "/", "http://bridge.local");
        const ticket = url.searchParams.get("ticket");
        if (
          !isAuthorizedRequest(info.req, cfg, url) &&
          !consumeClientTicket(stats, clientTickets, ticket, info.origin ?? "")
        ) {
          if (ticket) stats.clientTicketsRejected += 1;
          stats.rejectedToken += 1;
          recordEvent(stats, "ws_reject", `invalid token from ${maskedClientIp(info.req)}`);
          return done(false, 401, "invalid bridge token");
        }
      }
      return done(true);
    },
  });

  wss.on("connection", (ws) => {
    stats.activeWs += 1;
    stats.activeAnonymousWs += 1;
    stats.totalWs += 1;
    stats.anonymousWsOpens += 1;
    const state: ClientState = {
      ws,
      sessionKey: randomUUID(),
      userId: null,
      authenticatedUserId: null,
      sessionId: null,
      mcSession: null,
      listener: null,
      pendingLoginRequestId: null,
    };

    const send = (msg: ServerMessage) => {
      if (ws.readyState === ws.OPEN) {
        if (msg.type === "error" || msg.type === "auth_failed" || msg.type === "kicked") {
          stats.errorsOut += 1;
          recordRecentIssue(stats, state, msg);
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
      handleMessage(parsed, state, send, cfg, auth, sessions, pendingLogins, stats).catch((err) => {
        send({ type: "error", text: err?.message ?? String(err) });
      });
    });

    ws.on("close", () => {
      stats.activeWs = Math.max(0, stats.activeWs - 1);
      if (state.authenticatedUserId) {
        stats.authenticatedWsCloses += 1;
        recordEvent(stats, "ws_close", state.authenticatedUserId);
      } else {
        stats.activeAnonymousWs = Math.max(0, stats.activeAnonymousWs - 1);
        stats.anonymousWsCloses += 1;
      }
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
  statusCaches: Map<string, StatusCache>,
  stats: RuntimeStats,
  sessions: SessionManager,
  pendingLogins: Map<string, PendingLogin>,
  clientTickets: Map<string, ClientTicket>,
  rateLimits: Map<string, RateLimitBucket>,
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
    const origin = headerValue(req.headers.origin);
    const corsHeaders =
      url.pathname === "/client-ticket" || url.pathname === "/status"
        ? protectedCorsHeaders(headers, origin, cfg)
        : headers;
    res.writeHead(204, { ...corsHeaders, "Vary": "Origin" });
    res.end();
    return;
  }

  if (url.pathname === "/health") {
    res.writeHead(200, { ...headers, "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  if (url.pathname === "/client-ticket") {
    if (req.method !== "GET") {
      const origin = headerValue(req.headers.origin);
      res.writeHead(405, {
        ...protectedCorsHeaders(headers, origin, cfg),
        "Content-Type": "application/json",
        "Vary": "Origin",
      });
      res.end(JSON.stringify({ ok: false, error: "method not allowed" }));
      return;
    }
    const origin = headerValue(req.headers.origin);
    if (isRateLimited(stats, rateLimits, req, "ticket", CLIENT_TICKET_RATE_LIMIT)) {
      res.writeHead(429, {
        ...protectedCorsHeaders(headers, origin, cfg),
        "Content-Type": "application/json",
        "Vary": "Origin",
      });
      res.end(JSON.stringify({ ok: false, error: "rate limited" }));
      return;
    }
    if (cfg.allowedOrigins && !isAllowedOrigin(origin, cfg)) {
      stats.clientTicketsRejected += 1;
      recordEvent(stats, "ticket_reject", `origin ${origin || "(none)"}`);
      res.writeHead(403, {
        ...protectedCorsHeaders(headers, origin, cfg),
        "Content-Type": "application/json",
        "Vary": "Origin",
      });
      res.end(JSON.stringify({ ok: false, error: "origin not allowed" }));
      return;
    }

    const ticket = createClientTicket(stats, clientTickets, origin);
    res.writeHead(200, {
      ...protectedCorsHeaders(headers, origin, cfg),
      "Cache-Control": "no-store",
      "Content-Type": "application/json",
      "Vary": "Origin",
    });
    res.end(
      JSON.stringify({
        ok: true,
        ticket,
        expiresAt: Date.now() + CLIENT_TICKET_TTL_MS,
      }),
    );
    return;
  }

  if (url.pathname === "/status") {
    stats.statusRequests += 1;
    const origin = headerValue(req.headers.origin);
    if (isRateLimited(stats, rateLimits, req, "status", STATUS_RATE_LIMIT)) {
      res.writeHead(429, {
        ...protectedCorsHeaders(headers, origin, cfg),
        "Content-Type": "application/json",
        "Vary": "Origin",
      });
      res.end(JSON.stringify({ ok: false, error: "rate limited" }));
      return;
    }
    if (
      !isAuthorizedRequest(req, cfg, url) &&
      !isAllowedOrigin(origin, cfg)
    ) {
      stats.statusRejected += 1;
      recordEvent(stats, "status_reject", `origin ${origin || "(none)"}`);
      res.writeHead(401, {
        ...protectedCorsHeaders(headers, origin, cfg),
        "Content-Type": "application/json",
        "Vary": "Origin",
      });
      res.end(JSON.stringify({ ok: false, error: "invalid bridge token" }));
      return;
    }

    let target: BridgeServerProfile;
    try {
      target = resolveServerProfile(url.searchParams.get("serverId") ?? undefined, cfg);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      stats.statusRejected += 1;
      res.writeHead(404, {
        ...protectedCorsHeaders(headers, origin, cfg),
        "Content-Type": "application/json",
        "Vary": "Origin",
      });
      res.end(JSON.stringify({ ok: false, error: reason }));
      return;
    }
    const status = await getServerStatus(target, statusCaches);
    if (status.ok) stats.statusOk += 1;
    if (status.stale) stats.statusStale += 1;
    res.writeHead(200, {
      ...protectedCorsHeaders(headers, origin, cfg),
      "Cache-Control": "no-store",
      "Content-Type": "application/json",
      "Vary": "Origin",
    });
    res.end(JSON.stringify(status));
    return;
  }

  if (url.pathname === "/admin/status") {
    if (!isLocalAdminRequest(req)) {
      res.writeHead(404, { ...headers, "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: "not found" }));
      return;
    }
    res.writeHead(200, {
      ...headers,
      "Cache-Control": "no-store",
      "Content-Type": "application/json",
    });
    res.end(JSON.stringify(buildAdminStatus(cfg, stats, sessions, pendingLogins, clientTickets)));
    return;
  }

  if (url.pathname === "/admin/dashboard") {
    if (!isLocalAdminRequest(req)) {
      res.writeHead(404, { ...headers, "Content-Type": "text/plain; charset=utf-8" });
      res.end("not found");
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

function isAllowedOrigin(origin: string, cfg: BridgeConfig): boolean {
  if (!cfg.allowedOrigins) return true;
  return cfg.allowedOrigins.includes(origin);
}

function protectedCorsHeaders(
  headers: Record<string, string>,
  origin: string,
  cfg: BridgeConfig,
): Record<string, string> {
  if (!cfg.allowedOrigins) return headers;
  if (!origin || !isAllowedOrigin(origin, cfg)) {
    const { "Access-Control-Allow-Origin": _ignored, ...withoutOrigin } = headers;
    return withoutOrigin;
  }
  return {
    ...headers,
    "Access-Control-Allow-Origin": origin,
  };
}

function createClientTicket(
  stats: RuntimeStats,
  tickets: Map<string, ClientTicket>,
  origin: string,
): string {
  stats.clientTicketsExpired += cleanupClientTickets(tickets);
  const ticket = randomUUID();
  tickets.set(ticket, {
    origin,
    expiresAt: Date.now() + CLIENT_TICKET_TTL_MS,
  });
  stats.clientTicketsIssued += 1;
  return ticket;
}

function consumeClientTicket(
  stats: RuntimeStats,
  tickets: Map<string, ClientTicket>,
  ticket: string | null,
  origin: string,
): boolean {
  if (!ticket) return false;
  const entry = tickets.get(ticket);
  tickets.delete(ticket);
  if (!entry) return false;
  if (entry.expiresAt < Date.now()) {
    stats.clientTicketsExpired += 1;
    return false;
  }
  if (entry.origin !== origin) return false;
  stats.clientTicketsAccepted += 1;
  return true;
}

function cleanupClientTickets(tickets: Map<string, ClientTicket>): number {
  const now = Date.now();
  let expired = 0;
  for (const [ticket, entry] of tickets) {
    if (entry.expiresAt < now) {
      tickets.delete(ticket);
      expired += 1;
    }
  }
  return expired;
}

function isRateLimited(
  stats: RuntimeStats,
  buckets: Map<string, RateLimitBucket>,
  req: http.IncomingMessage,
  area: string,
  limit: number,
): boolean {
  const now = Date.now();
  if (buckets.size > 2000) {
    for (const [key, bucket] of buckets) {
      if (bucket.resetAt <= now) buckets.delete(key);
    }
  }
  const key = `${area}:${clientIpKey(req)}`;
  const current = buckets.get(key);
  if (!current || current.resetAt <= now) {
    buckets.set(key, { resetAt: now + RATE_WINDOW_MS, count: 1 });
    return false;
  }
  current.count += 1;
  if (current.count <= limit) return false;
  stats.rateLimited += 1;
  return true;
}

function clientIpKey(req: http.IncomingMessage): string {
  const cfConnectingIp = headerValue(req.headers["cf-connecting-ip"]).trim();
  if (cfConnectingIp) return cfConnectingIp;
  const xRealIp = headerValue(req.headers["x-real-ip"]).trim();
  if (xRealIp) return xRealIp;
  const forwarded = headerValue(req.headers["x-forwarded-for"]).trim();
  if (forwarded) return forwarded.split(",")[0]?.trim() || "unknown";
  return req.socket.remoteAddress ?? "unknown";
}

function headerValue(value: string | string[] | undefined): string {
  if (Array.isArray(value)) return value[0] ?? "";
  return value ?? "";
}

function isLocalAdminRequest(req: http.IncomingMessage): boolean {
  return (
    isLoopbackAddress(req.socket.remoteAddress) &&
    hasLocalHostHeader(req.headers.host) &&
    !hasProxyForwardingHeaders(req.headers)
  );
}

function isLoopbackAddress(address: string | undefined): boolean {
  if (!address) return false;
  return address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1";
}

function hasLocalHostHeader(host: string | undefined): boolean {
  if (!host) return false;
  const normalized = host.trim().toLowerCase();
  return (
    normalized === "localhost" ||
    normalized.startsWith("localhost:") ||
    normalized === "127.0.0.1" ||
    normalized.startsWith("127.0.0.1:") ||
    normalized === "[::1]" ||
    normalized.startsWith("[::1]:")
  );
}

function hasProxyForwardingHeaders(headers: http.IncomingHttpHeaders): boolean {
  return [
    "cf-connecting-ip",
    "cf-ray",
    "cf-visitor",
    "cdn-loop",
    "forwarded",
    "x-forwarded-for",
    "x-forwarded-host",
    "x-forwarded-proto",
    "x-real-ip",
  ].some((name) => headers[name] !== undefined);
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

function recordRecentIssue(
  stats: RuntimeStats,
  state: ClientState,
  msg: Extract<ServerMessage, { type: "error" | "auth_failed" | "kicked" }>,
): void {
  const issue: RecentIssue = {
    ts: Date.now(),
    userId: state.userId,
    sessionId: state.sessionId,
    reason: msg.type === "error" ? msg.text : msg.reason,
  };
  if (msg.type === "kicked") {
    stats.kicked += 1;
    stats.recentKicks.push(issue);
    trimArray(stats.recentKicks, 20);
    recordEvent(stats, "kicked", issue.reason);
    return;
  }
  stats.recentErrors.push(issue);
  trimArray(stats.recentErrors, 20);
}

function trimArray<T>(items: T[], max: number): void {
  if (items.length > max) {
    items.splice(0, items.length - max);
  }
}

function recordMemorySample(
  stats: RuntimeStats,
  mem: NodeJS.MemoryUsage,
  activeSessions: number,
): MemorySample[] {
  const rssMb = Math.round(mem.rss / 1024 / 1024);
  const heapUsedMb = Math.round(mem.heapUsed / 1024 / 1024);
  const last = stats.memorySamples.at(-1);
  if (!last || Date.now() - last.ts >= 60_000 || last.rssMb !== rssMb) {
    stats.memorySamples.push({
      ts: Date.now(),
      rssMb,
      heapUsedMb,
      activeWs: stats.activeWs,
      activeSessions,
    });
    trimArray(stats.memorySamples, 120);
  }
  return stats.memorySamples.slice(-60);
}

function maskedClientIp(source: unknown): string {
  const req = source as {
    headers?: http.IncomingHttpHeaders;
    socket?: { remoteAddress?: string };
    remoteAddress?: string;
  };
  const cfConnectingIp = headerValue(req.headers?.["cf-connecting-ip"]).trim();
  const xRealIp = headerValue(req.headers?.["x-real-ip"]).trim();
  const forwarded = headerValue(req.headers?.["x-forwarded-for"]).trim();
  const ip =
    cfConnectingIp ||
    xRealIp ||
    (forwarded
      ? forwarded.split(",")[0]?.trim()
      : req.socket?.remoteAddress ?? req.remoteAddress);
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

function buildAdminStatus(
  cfg: BridgeConfig,
  stats: RuntimeStats,
  sessions: SessionManager,
  pendingLogins: Map<string, PendingLogin>,
  clientTickets: Map<string, ClientTicket>,
) {
  purgePendingLogins(pendingLogins);
  stats.clientTicketsExpired += cleanupClientTickets(clientTickets);
  const mem = process.memoryUsage();
  const sessionStats = sessions.stats();
  const memorySamples = recordMemorySample(stats, mem, sessionStats.active);
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
    serverProfiles: cfg.serverProfiles.map((profile) => ({
      id: profile.id,
      name: profile.name,
      publicAddress: profile.publicAddress,
      version: profile.version,
    })),
    security: {
      bindHost: cfg.bindHost,
      tokenRequired: Boolean(cfg.bridgeToken),
      allowedOrigins: cfg.allowedOrigins ?? ["*"],
      maxMessageBytes: MAX_WS_MESSAGE_BYTES,
      rateWindowMs: RATE_WINDOW_MS,
      rateLimits: {
        wsUpgrade: WS_UPGRADE_RATE_LIMIT,
        clientTicket: CLIENT_TICKET_RATE_LIMIT,
        status: STATUS_RATE_LIMIT,
      },
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
      activeAnonymous: stats.activeAnonymousWs,
      total: stats.totalWs,
      anonymousOpens: stats.anonymousWsOpens,
      anonymousCloses: stats.anonymousWsCloses,
      authenticatedCloses: stats.authenticatedWsCloses,
      rejectedToken: stats.rejectedToken,
      rejectedOrigin: stats.rejectedOrigin,
      rateLimited: stats.rateLimited,
      messagesIn: stats.messagesIn,
      messagesRejected: stats.messagesRejected,
      errorsOut: stats.errorsOut,
    },
    auth: {
      pendingLogins: pendingLogins.size,
    },
    clientTickets: {
      active: clientTickets.size,
      issued: stats.clientTicketsIssued,
      accepted: stats.clientTicketsAccepted,
      rejected: stats.clientTicketsRejected,
      expired: stats.clientTicketsExpired,
      ttlMs: CLIENT_TICKET_TTL_MS,
    },
    status: {
      requests: stats.statusRequests,
      ok: stats.statusOk,
      stale: stats.statusStale,
      rejected: stats.statusRejected,
    },
    counters: {
      cachedAuths: stats.cachedAuths,
      deviceLoginStarts: stats.deviceLoginStarts,
      deviceLoginCompletions: stats.deviceLoginCompletions,
      sessionCreates: stats.sessionCreates,
      sessionReuses: stats.sessionReuses,
      graceReconnects: stats.graceReconnects,
      kicked: stats.kicked,
    },
    sessions: sessionStats,
    memory: {
      samples: memorySamples,
    },
    recentKicks: stats.recentKicks.slice(-20),
    recentErrors: stats.recentErrors.slice(-20),
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
    .card h2 { margin: 0 0 12px; font-size: 18px; }
    .label { color: #8b949e; font-size: 12px; font-weight: 700; text-transform: uppercase; }
    .value { font-size: 24px; font-weight: 800; margin-top: 6px; }
    .subvalue { color: #8b949e; font-size: 12px; margin-top: 5px; }
    table { width: 100%; border-collapse: collapse; overflow: hidden; border-radius: 12px; }
    th, td { padding: 10px 9px; border-bottom: 1px solid rgba(240,246,252,.08); text-align: left; font-size: 13px; }
    th { color: #8b949e; font-size: 12px; }
    .ok { color: #3fb950; font-weight: 800; }
    .warn { color: #f2cc60; font-weight: 800; }
    .section-grid { display: grid; grid-template-columns: 1.25fr .75fr; gap: 12px; margin-top: 12px; }
    .list { display: grid; gap: 8px; }
    .issue { display: grid; gap: 3px; padding: 10px; border: 1px solid rgba(240,246,252,.08); border-radius: 10px; background: rgba(255,255,255,.025); }
    .issue strong { color: #f2cc60; }
    .spark { display: flex; align-items: end; gap: 3px; height: 58px; padding-top: 8px; }
    .bar { flex: 1; min-width: 4px; border-radius: 4px 4px 0 0; background: linear-gradient(180deg, #3fb950, #1f6f3f); opacity: .9; }
    .chips { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 8px; }
    .chip { border: 1px solid rgba(240,246,252,.12); background: rgba(255,255,255,.04); color: #c9d1d9; border-radius: 999px; padding: 5px 8px; font-size: 12px; }
    pre { white-space: pre-wrap; word-break: break-word; margin: 0; color: #c9d1d9; font-size: 12px; line-height: 1.55; }
    @media (max-width: 760px) { body { padding: 14px; } .section-grid { grid-template-columns: 1fr; } }
  </style>
</head>
<body>
  <main>
    <h1>루둘기 브릿지</h1>
    <div class="muted" id="subtitle">상태를 불러오는 중...</div>
    <section class="grid" id="cards"></section>
    <section class="section-grid">
      <div class="card">
        <h2>세션</h2>
        <div id="sessions"></div>
      </div>
      <div class="card">
        <h2>메모리 추이</h2>
        <div id="memory"></div>
      </div>
    </section>
    <section class="section-grid">
      <div class="card">
        <h2>최근 킥 / 오류</h2>
        <div id="issues"></div>
      </div>
      <div class="card">
        <h2>최근 이벤트</h2>
        <pre id="events"></pre>
      </div>
    </section>
  </main>
  <script>
    const fmtTime = (ts) => ts ? new Date(ts).toLocaleString("ko-KR") : "-";
    const el = (tag, text, className) => {
      const node = document.createElement(tag);
      if (text != null) node.textContent = String(text);
      if (className) node.className = className;
      return node;
    };
    function card(label, value, subtext) {
      const wrap = el("div", null, "card");
      wrap.append(el("div", label, "label"), el("div", value, "value"));
      if (subtext) wrap.append(el("div", subtext, "subvalue"));
      return wrap;
    }
    const fmtDuration = (sec) => {
      const h = Math.floor(sec / 3600);
      const m = Math.floor((sec % 3600) / 60);
      return h > 0 ? h + "시간 " + m + "분" : m + "분";
    };
    function empty(text) {
      return el("div", text, "muted");
    }
    function render(data) {
      document.getElementById("subtitle").textContent =
        data.target.host + ":" + data.target.port + " · MC " + data.target.version +
        " · " + fmtTime(data.now);
      const cards = document.getElementById("cards");
      const reconnects = data.counters.sessionReuses + data.counters.graceReconnects;
      const activeNames = data.sessions.sessions.map((session) => session.ign || session.userId).join(", ");
      const profileNames = (data.serverProfiles || [])
        .map((profile) => profile.name + " " + profile.publicAddress)
        .join(", ");
      cards.replaceChildren(
        card("Active WS", data.websocket.active, "총 " + data.websocket.total + "회 연결"),
        card("Pre-auth WS", data.websocket.activeAnonymous, "open " + data.websocket.anonymousOpens + " · close " + data.websocket.anonymousCloses),
        card("Sessions", data.sessions.active + "/" + data.sessions.max, activeNames || "활성 계정 없음"),
        card("Profiles", (data.serverProfiles || []).length, profileNames || "기본 서버"),
        card("Reconnects", reconnects, "재사용 " + data.counters.sessionReuses + " · 유예복구 " + data.counters.graceReconnects),
        card("Kicks", data.counters.kicked, "최근 " + data.recentKicks.length + "건 보관"),
        card("Memory RSS", data.process.rssMb + " MB", "heap " + data.process.heapUsedMb + "/" + data.process.heapTotalMb + " MB"),
        card("Tickets", data.clientTickets.active, "issued " + data.clientTickets.issued + " · accepted " + data.clientTickets.accepted),
        card("Status API", data.status.requests, "ok " + data.status.ok + " · stale " + data.status.stale + " · reject " + data.status.rejected),
        card("Rejected", data.websocket.rejectedToken + data.websocket.rejectedOrigin + data.websocket.messagesRejected, "token/origin/message"),
        card("Rate limit", data.websocket.rateLimited, "ticket " + data.security.rateLimits.clientTicket + "/min · ws " + data.security.rateLimits.wsUpgrade + "/min"),
        card("Auth", data.counters.cachedAuths, "device " + data.counters.deviceLoginCompletions + "/" + data.counters.deviceLoginStarts),
        card("Uptime", fmtDuration(data.uptimeSec), "pid " + data.process.pid)
      );
      const sessions = document.getElementById("sessions");
      if (!data.sessions.sessions.length) {
        sessions.textContent = "활성 세션 없음";
      } else {
        const table = el("table");
        const head = el("tr");
        ["IGN", "Server", "Version", "Ref", "Players", "State", "Age", "Last attach"].forEach((name) => head.append(el("th", name)));
        table.append(head);
        data.sessions.sessions.forEach((session) => {
          const row = el("tr");
          row.append(
            el("td", session.ign || session.userId),
            el("td", session.serverName || session.serverId || "-"),
            el("td", session.mcVersion || "-"),
            el("td", session.refCount),
            el("td", session.playersOnline ?? "-"),
            el("td", session.connected ? "online" : session.closing ? "closing" : "offline", session.connected ? "ok" : "warn"),
            el("td", fmtDuration(Math.max(0, Math.floor((data.now - session.createdAt) / 1000)))),
            el("td", fmtTime(session.lastAttachedAt))
          );
          table.append(row);
        });
        sessions.replaceChildren(table);
      }
      renderMemory(data);
      renderIssues(data);
      document.getElementById("events").textContent = data.recentEvents
        .slice().reverse()
        .map((event) => "[" + fmtTime(event.ts) + "] " + event.kind + " · " + event.detail)
        .join("\\n") || "이벤트 없음";
    }
    function renderMemory(data) {
      const wrap = document.getElementById("memory");
      const samples = data.memory.samples || [];
      if (!samples.length) {
        wrap.replaceChildren(empty("샘플 없음"));
        return;
      }
      const values = samples.map((sample) => sample.rssMb);
      const min = Math.min(...values);
      const max = Math.max(...values);
      const latest = samples[samples.length - 1];
      const spark = el("div", null, "spark");
      const range = Math.max(1, max - min);
      samples.slice(-40).forEach((sample) => {
        const bar = el("div", null, "bar");
        bar.style.height = Math.max(8, 12 + ((sample.rssMb - min) / range) * 42) + "px";
        bar.title = fmtTime(sample.ts) + " · " + sample.rssMb + " MB";
        spark.append(bar);
      });
      const chips = el("div", null, "chips");
      chips.append(
        el("span", "현재 " + latest.rssMb + " MB", "chip"),
        el("span", "범위 " + min + "-" + max + " MB", "chip"),
        el("span", "샘플 " + samples.length + "개", "chip")
      );
      wrap.replaceChildren(spark, chips);
    }
    function renderIssues(data) {
      const wrap = document.getElementById("issues");
      const issues = [
        ...(data.recentKicks || []).map((issue) => ({ ...issue, kind: "kick" })),
        ...(data.recentErrors || []).map((issue) => ({ ...issue, kind: "error" })),
      ].sort((a, b) => b.ts - a.ts).slice(0, 8);
      if (!issues.length) {
        wrap.replaceChildren(empty("최근 킥/오류 없음"));
        return;
      }
      const list = el("div", null, "list");
      issues.forEach((issue) => {
        const item = el("div", null, "issue");
        const title = el("strong", (issue.kind === "kick" ? "KICK" : "ERROR") + " · " + (issue.userId || issue.sessionId || "unknown"));
        item.append(title, el("span", issue.reason), el("span", fmtTime(issue.ts), "muted"));
        list.append(item);
      });
      wrap.replaceChildren(list);
    }
    async function refresh() {
      try {
        const res = await fetch("/admin/status", { cache: "no-store" });
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
  target: BridgeServerProfile,
  caches: Map<string, StatusCache>,
): Promise<ServerStatusBody> {
  let cache = caches.get(target.id);
  if (!cache) {
    cache = {
      expiresAt: 0,
      promise: null,
      value: null,
    };
    caches.set(target.id, cache);
  }
  const now = Date.now();
  if (cache.value && cache.expiresAt > now) return cache.value;
  if (cache.promise) return cache.promise;

  const previous = cache.value;
  cache.promise = pingMinecraftServer(target)
    .then((status) => {
      if (
        !status.ok &&
        previous?.ok &&
        Date.now() - previous.updatedAt <= STATUS_STALE_TTL_MS
      ) {
        const staleStatus = {
          ...previous,
          stale: true,
          error: status.error,
        };
        cache.value = staleStatus;
        cache.expiresAt = Date.now() + 5_000;
        return staleStatus;
      }
      cache.value = status;
      cache.expiresAt = Date.now() + (status.ok ? 5_000 : 2_000);
      return status;
    })
    .finally(() => {
      cache.promise = null;
    });

  return cache.promise;
}

async function pingMinecraftServer(target: BridgeServerProfile): Promise<ServerStatusBody> {
  try {
    const result = await ping({
      host: target.host,
      port: target.port,
      version: target.version,
      closeTimeout: 4_000,
      noPongTimeout: 4_000,
    });
    const normalized = normalizePingResult(result);
    return {
      ok: true,
      serverId: target.id,
      name: target.name,
      host: target.host,
      port: target.port,
      updatedAt: Date.now(),
      ...normalized,
    };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      serverId: target.id,
      name: target.name,
      host: target.host,
      port: target.port,
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
  stats: RuntimeStats,
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
      stats.deviceLoginStarts += 1;
      let target: BridgeServerProfile;
      try {
        target = resolveTarget(msg.serverId, msg.mcVersion, cfg);
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
        stats.deviceLoginCompletions += 1;
        state.pendingLoginRequestId = null;
        attachToSession(result, target, state, send, sessions, stats, {
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
      let target: BridgeServerProfile;
      try {
        target = resolveTarget(msg.serverId, msg.mcVersion, cfg);
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
      stats.cachedAuths += 1;
      attachToSession(cached, target, state, send, sessions, stats);
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
  target: BridgeServerProfile,
  state: ClientState,
  send: (m: ServerMessage) => void,
  sessions: SessionManager,
  stats: RuntimeStats,
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
      recordEvent(stats, "session_rebuild", `${userId}@${target.id}@${target.version}`);
    }
    const attach = sessions.attach(userId, cacheUserId, profilesFolder, target, listener);
    const { sessionId } = attach;
    if (attach.created) {
      stats.sessionCreates += 1;
      recordEvent(stats, "session_create", sessionId);
    } else {
      stats.sessionReuses += 1;
      recordEvent(stats, "session_reuse", `${sessionId} refs=${attach.refCount}`);
    }
    if (attach.resumedFromGrace) {
      stats.graceReconnects += 1;
      recordEvent(stats, "session_resume", sessionId);
    }
    if (!state.authenticatedUserId) {
      stats.activeAnonymousWs = Math.max(0, stats.activeAnonymousWs - 1);
    }
    state.userId = userId;
    state.authenticatedUserId = userId;
    state.sessionId = sessionId;
    state.listener = listener;
    state.mcSession = attach.session;
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

function resolveTarget(
  requestedServerId: string | undefined,
  requestedMcVersion: string | undefined,
  cfg: BridgeConfig,
): BridgeServerProfile {
  const profile = resolveServerProfile(requestedServerId, cfg);
  const version = resolveMcVersion(requestedMcVersion, profile.version);
  if (version === profile.version) return profile;
  return { ...profile, version };
}

function resolveServerProfile(
  requestedServerId: string | undefined,
  cfg: BridgeConfig,
): BridgeServerProfile {
  const id = requestedServerId?.trim().toLowerCase();
  const fallback = cfg.serverProfiles[0];
  if (!fallback) throw new Error("no server profiles configured");
  if (!id) return fallback;
  const profile = cfg.serverProfiles.find((candidate) => candidate.id === id);
  if (profile) return profile;
  if (id === "rudulgi") {
    const renamedProfile = cfg.serverProfiles.find((candidate) => candidate.id === "ludulgi");
    if (renamedProfile) return renamedProfile;
  }
  throw new Error(`unknown server profile: ${id}`);
}

function resolveMcVersion(requested: string | undefined, fallback: string): string {
  return assertSupportedMcVersion(requested?.trim() || fallback);
}
