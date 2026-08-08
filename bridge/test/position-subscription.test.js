const assert = require("node:assert/strict");
const { EventEmitter, once } = require("node:events");
const test = require("node:test");
const WebSocket = require("ws");
const { startWsServer } = require("../dist/ws-server.js");

class FakeMcSession extends EventEmitter {
  constructor() {
    super();
    this.positionSubscribers = new Map();
    this.stoppedMovementClients = [];
    this.stoppedPositionClients = [];
  }

  history50() {
    return [];
  }

  statusSnapshot() {
    return {
      type: "status",
      connected: true,
      server: "example.invalid:25565",
      ign: "tester",
    };
  }

  playerListSnapshot() {
    return null;
  }

  bossBarsSnapshot() {
    return null;
  }

  playerStateSnapshot() {
    return null;
  }

  startPositionSubscriptionForClient(clientId, listener) {
    this.positionSubscribers.set(clientId, listener);
    listener({
      type: "position",
      x: 1,
      y: 64,
      z: 2,
      yaw: 0,
      direction: "N",
      ts: 10_000,
    });
  }

  stopPositionSubscriptionForClient(clientId) {
    this.positionSubscribers.delete(clientId);
    this.stoppedPositionClients.push(clientId);
    this.emit("position-stopped", clientId);
  }

  stopMovementForClient(clientId) {
    this.stoppedMovementClients.push(clientId);
  }

  stopMapSubscriptionForClient() {}
}

function bridgeFixture() {
  const session = new FakeMcSession();
  const listenerBySessionId = new Map();
  const sessions = {
    attach(_userId, _cacheUserId, _profilesFolder, _target, listener) {
      listenerBySessionId.set("tester@main@1.21.11", listener);
      session.on("message", listener);
      return {
        sessionId: "tester@main@1.21.11",
        session,
        created: true,
        resumedFromGrace: false,
        refCount: 1,
      };
    },
    detach(sessionId, listener) {
      session.off("message", listener);
      listenerBySessionId.delete(sessionId);
    },
    forceClose() {},
    forceCloseUser() {},
    stats() {
      return { active: 1, movementActive: 0, max: 2, sessions: [] };
    },
  };
  const auth = {
    async loadCached() {
      return {
        userId: "tester",
        cacheUserId: "tester@example.invalid",
        ign: "tester",
        uuid: "00000000-0000-0000-0000-000000000001",
        profilesFolder: "/tmp/proll-position-test",
      };
    },
  };
  const cfg = {
    mcHost: "example.invalid",
    mcPort: 25565,
    mcVersion: "1.21.11",
    serverProfiles: [
      {
        id: "main",
        name: "Main",
        host: "example.invalid",
        port: 25565,
        version: "1.21.11",
        publicAddress: "example.invalid",
      },
    ],
    bindHost: "127.0.0.1",
    wsPort: 0,
    bridgeToken: null,
    tokensDir: "/tmp/proll-position-test",
    allowedOrigins: null,
    maxSessions: 2,
    chatRateLimit: 5,
    sessionGraceMs: 1_000,
    movementAllowedIgns: ["tester"],
    headMetadataEnabled: false,
    headDebugEnabled: false,
  };
  return { auth, cfg, session, sessions };
}

async function openAuthenticatedClient(server) {
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const ws = new WebSocket(`ws://127.0.0.1:${address.port}`);
  await once(ws, "open");
  const messages = [];
  ws.on("message", (data) => {
    messages.push(JSON.parse(data.toString()));
  });
  const authenticated = waitForMessage(ws, (message) => message.type === "auth_ok");
  ws.send(JSON.stringify({
    type: "auth_cached",
    userId: "tester",
    serverId: "main",
    mcVersion: "1.21.11",
  }));
  await authenticated;
  return { messages, ws };
}

function waitForMessage(ws, predicate) {
  return new Promise((resolve) => {
    const onMessage = (data) => {
      const message = JSON.parse(data.toString());
      if (!predicate(message)) return;
      ws.off("message", onMessage);
      resolve(message);
    };
    ws.on("message", onMessage);
  });
}

test("position protocol subscribes, unsubscribes, and cleans up on close", async (t) => {
  // Given
  const { auth, cfg, session, sessions } = bridgeFixture();
  const server = startWsServer(cfg, auth, sessions);
  t.after(() => server.close());
  await once(server, "listening");
  const { ws } = await openAuthenticatedClient(server);
  t.after(() => ws.close());

  // When
  const position = waitForMessage(ws, (message) => message.type === "position");
  ws.send(JSON.stringify({ type: "position_subscribe" }));
  const firstPosition = await position;
  const unsubscribed = once(session, "position-stopped");
  ws.send(JSON.stringify({ type: "position_unsubscribe" }));
  await unsubscribed;
  const cleanedUp = once(session, "position-stopped");
  ws.send(JSON.stringify({ type: "position_subscribe" }));
  await waitForMessage(ws, (message) => message.type === "position");
  ws.close();
  await cleanedUp;

  // Then
  assert.equal(firstPosition.type, "position");
  assert.equal(session.positionSubscribers.size, 0);
  assert.equal(session.stoppedMovementClients.length, 1);
  assert.equal(session.stoppedPositionClients.length, 2);
});
