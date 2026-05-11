import http from "http";
import { WebSocketServer, WebSocket } from "ws";
import { randomUUID } from "crypto";
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

export function startWsServer(
  cfg: BridgeConfig,
  auth: AuthService,
  sessions: SessionManager,
): http.Server {
  const httpServer = http.createServer((req, res) => {
    if (req.url === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    res.writeHead(404);
    res.end();
  });

  const wss = new WebSocketServer({
    server: httpServer,
    verifyClient: (info, done) => {
      if (cfg.bridgeToken) {
        const url = new URL(info.req.url ?? "/", "http://bridge.local");
        const authHeader = info.req.headers.authorization;
        const bearerToken =
          typeof authHeader === "string" && authHeader.startsWith("Bearer ")
            ? authHeader.slice("Bearer ".length).trim()
            : null;
        const queryToken = url.searchParams.get("token");
        if (queryToken !== cfg.bridgeToken && bearerToken !== cfg.bridgeToken) {
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
  const listener = (m: ServerMessage) => {
    send(m);
    if (m.type === "status" && !m.connected) {
      state.mcSession = null;
      state.userId = null;
      state.sessionId = null;
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

function resolveMcVersion(requested: string | undefined, cfg: BridgeConfig): string {
  return assertSupportedMcVersion(requested?.trim() || cfg.mcVersion);
}
