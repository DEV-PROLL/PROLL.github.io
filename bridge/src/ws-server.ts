import http from "http";
import { WebSocketServer, WebSocket } from "ws";
import { randomUUID } from "crypto";
import type { BridgeConfig, ClientMessage, ServerMessage } from "./types";
import { AuthService } from "./auth";
import type { McSession } from "./mc-session";
import type { SessionManager } from "./session-manager";

interface ClientState {
  ws: WebSocket;
  sessionKey: string;          // unique per WS connection
  userId: string | null;       // populated after auth_ok
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
      if (state.userId && state.listener) {
        sessions.detach(state.userId, state.listener);
      }
    });

    ws.on("error", () => {
      // Mirror close cleanup; ws will fire 'close' too but be defensive.
      if (state.userId && state.listener) {
        sessions.detach(state.userId, state.listener);
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
      try {
        const result = await auth.loginWithDeviceCode(state.sessionKey, (code) => {
          send({
            type: "auth_code",
            code: code.user_code,
            verificationUri: code.verification_uri,
            expiresInSec: code.expires_in,
          });
        });
        attachToSession(result.userId, result.profilesFolder, state, send, sessions);
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
      const cached = await auth.loadCached(msg.userId);
      if (!cached) {
        send({ type: "auth_failed", reason: "no cached login for this user" });
        return;
      }
      attachToSession(cached.userId, cached.profilesFolder, state, send, sessions);
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

    case "logout": {
      if (state.userId && state.listener) {
        sessions.detach(state.userId, state.listener);
        sessions.forceClose(state.userId);
        state.listener = null;
        state.mcSession = null;
        state.userId = null;
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
  userId: string,
  profilesFolder: string,
  state: ClientState,
  send: (m: ServerMessage) => void,
  sessions: SessionManager,
): void {
  const listener = (m: ServerMessage) => send(m);
  try {
    const mc = sessions.attach(userId, profilesFolder, listener);
    state.userId = userId;
    state.listener = listener;
    state.mcSession = mc;
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    send({ type: "auth_failed", reason });
  }
}
