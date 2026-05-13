import http from "http";
import { WebSocketServer, WebSocket } from "ws";
import { randomUUID } from "crypto";
import { ping, type NewPingResult, type OldPingResult } from "minecraft-protocol";
import type { BridgeConfig, ClientMessage, ServerMessage } from "./types";
import { AuthService } from "./auth";
import type { McSession } from "./mc-session";
import type { SessionManager } from "./session-manager";
import { assertSupportedMcVersion } from "./mc-versions";

interface ClientState {
  ws: WebSocket;
  sessionKey: string;          // unique per WS connection
  userId: string | null;       // populated after auth_ok
  sessionId: string | null;    // user + version key in SessionManager
  mcSession: McSession | null; // populated after auth_ok
  listener: ((msg: ServerMessage) => void) | null;
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

  const httpServer = http.createServer((req, res) => {
    void handleHttpRequest(req, res, cfg, statusCache);
  });

  const wss = new WebSocketServer({
    server: httpServer,
    verifyClient: (info, done) => {
      if (cfg.bridgeToken) {
        const url = new URL(info.req.url ?? "/", "http://bridge.local");
        if (!isAuthorizedRequest(info.req, cfg, url)) {
          return done(false, 401, "invalid bridge token");
        }
      }
      if (!cfg.allowedOrigins) return done(true);
      const origin = info.origin ?? "";
      if (cfg.allowedOrigins.includes(origin)) return done(true);
      return done(false, 403, "origin not allowed");
    },
  });

  wss.on("connection", (ws) => {
    const state: ClientState = {
      ws,
      sessionKey: randomUUID(),
      userId: null,
      sessionId: null,
      mcSession: null,
      listener: null,
    };

    const send = (msg: ServerMessage) => {
      if (ws.readyState === ws.OPEN) {
        ws.send(JSON.stringify(msg));
      }
    };

    ws.on("message", (data) => {
      let parsed: ClientMessage;
      try {
        parsed = JSON.parse(data.toString());
      } catch {
        send({ type: "error", text: "invalid JSON" });
        return;
      }
      handleMessage(parsed, state, send, cfg, auth, sessions).catch((err) => {
        send({ type: "error", text: err?.message ?? String(err) });
      });
    });

    ws.on("close", () => {
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

  httpServer.listen(cfg.wsPort, () => {
    console.log(`[bridge] WS+HTTP listening on :${cfg.wsPort}`);
  });

  return httpServer;
}

async function handleHttpRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  cfg: BridgeConfig,
  statusCache: StatusCache,
): Promise<void> {
  const url = new URL(req.url ?? "/", "http://bridge.local");
  const headers = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Authorization, Cache-Control, Content-Type",
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
      try {
        const result = await auth.loginWithDeviceCode(state.sessionKey, (code) => {
          send({
            type: "auth_code",
            code: code.user_code,
            verificationUri: code.verification_uri,
            expiresInSec: code.expires_in,
          });
        });
        attachToSession(result, mcVersion, state, send, sessions);
      } catch (err) {
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
