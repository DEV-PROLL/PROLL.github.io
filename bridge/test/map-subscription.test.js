const assert = require("node:assert/strict");
const { EventEmitter, once } = require("node:events");
const test = require("node:test");
const WebSocket = require("ws");
const { startWsServer } = require("../dist/ws-server.js");

class FakeMcSession extends EventEmitter {
  constructor() {
    super();
    this.mapSubscribers = new Map();
    this.stoppedMapClients = [];
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

  stopMovementForClient() {}

  stopPositionSubscriptionForClient() {}

  startMapSubscriptionForClient(clientId, listener, radius) {
    this.mapSubscribers.set(clientId, { listener, radius });
    listener({ type: "map_state", state: "loading", ts: 10_000 });
  }

  stopMapSubscriptionForClient(clientId) {
    if (!this.mapSubscribers.delete(clientId)) return;
    this.stoppedMapClients.push(clientId);
    this.emit("map-stopped", clientId);
  }
}

function bridgeFixture(mapEnabled = true) {
  const session = new FakeMcSession();
  const sessions = {
    attach(userId, _cacheUserId, _profilesFolder, target, listener) {
      const sessionId = `${userId}@${target.id}@${target.version}`;
      session.on("message", listener);
      return {
        sessionId,
        session,
        created: true,
        resumedFromGrace: false,
        refCount: 1,
      };
    },
    detach(_sessionId, listener) {
      session.off("message", listener);
    },
    forceClose() {},
    forceCloseUser() {},
    stats() {
      return { active: 1, movementActive: 0, max: 4, sessions: [] };
    },
  };
  const auth = {
    async loadCached(userId) {
      return {
        userId,
        cacheUserId: `${userId}@example.invalid`,
        ign: userId,
        uuid: "00000000-0000-0000-0000-000000000001",
        profilesFolder: `/tmp/proll-map-${userId}`,
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
    tokensDir: "/tmp/proll-map-test",
    allowedOrigins: null,
    maxSessions: 4,
    chatRateLimit: 5,
    sessionGraceMs: 1_000,
    movementAllowedIgns: ["tester"],
    headMetadataEnabled: false,
    headDebugEnabled: false,
    mapEnabled,
    mapMaxSubscribers: 2,
  };
  return { auth, cfg, session, sessions };
}

async function openAuthenticatedClient(server, userId) {
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const ws = new WebSocket(`ws://127.0.0.1:${address.port}`);
  await once(ws, "open");
  const authenticated = waitForMessage(
    ws,
    (message) => message.type === "auth_ok",
  );
  ws.send(
    JSON.stringify({
      type: "auth_cached",
      userId,
      serverId: "main",
      mcVersion: "1.21.11",
    }),
  );
  await authenticated;
  return ws;
}

function waitForMessage(ws, predicate) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      ws.off("message", onMessage);
      reject(new Error("timed out waiting for websocket message"));
    }, 1_000);
    const onMessage = (data) => {
      const message = JSON.parse(data.toString());
      if (!predicate(message)) return;
      clearTimeout(timeout);
      ws.off("message", onMessage);
      resolve(message);
    };
    ws.on("message", onMessage);
  });
}

test("map protocol preserves two subscribers when a third reaches capacity", async (t) => {
  // Given
  const { auth, cfg, session, sessions } = bridgeFixture();
  const server = startWsServer(cfg, auth, sessions);
  await once(server, "listening");
  const first = await openAuthenticatedClient(server, "first");
  const second = await openAuthenticatedClient(server, "second");
  const third = await openAuthenticatedClient(server, "third");
  t.after(() => {
    first.terminate();
    second.terminate();
    third.terminate();
    server.close();
  });

  // When
  const firstLoading = waitForMessage(
    first,
    (message) => message.type === "map_state",
  );
  first.send(JSON.stringify({ type: "map_subscribe", radius: 24 }));
  await firstLoading;
  const secondLoading = waitForMessage(
    second,
    (message) => message.type === "map_state",
  );
  second.send(JSON.stringify({ type: "map_subscribe" }));
  await secondLoading;
  const unsupported = waitForMessage(
    third,
    (message) => message.type === "map_state",
  );
  third.send(JSON.stringify({ type: "map_subscribe", radius: 12 }));
  const capacity = await unsupported;

  // Then
  assert.equal(capacity.state, "unsupported");
  assert.equal(capacity.reason, "capacity");
  assert.equal(session.mapSubscribers.size, 2);
  assert.deepEqual(
    [...session.mapSubscribers.values()].map(({ radius }) => radius),
    [24, undefined],
  );
});

test("map unsubscribe and websocket close release bridge capacity", async (t) => {
  // Given
  const { auth, cfg, session, sessions } = bridgeFixture();
  const server = startWsServer(cfg, auth, sessions);
  await once(server, "listening");
  const first = await openAuthenticatedClient(server, "first");
  const second = await openAuthenticatedClient(server, "second");
  const third = await openAuthenticatedClient(server, "third");
  t.after(() => {
    first.terminate();
    second.terminate();
    third.terminate();
    server.close();
  });
  for (const ws of [first, second]) {
    const loading = waitForMessage(
      ws,
      (message) => message.type === "map_state",
    );
    ws.send(JSON.stringify({ type: "map_subscribe" }));
    await loading;
  }

  // When
  const unsubscribed = once(session, "map-stopped");
  first.send(JSON.stringify({ type: "map_unsubscribe" }));
  await unsubscribed;
  const admitted = waitForMessage(
    third,
    (message) => message.type === "map_state",
  );
  third.send(JSON.stringify({ type: "map_subscribe" }));
  assert.equal((await admitted).state, "loading");
  const closed = once(session, "map-stopped");
  second.close();
  await closed;

  // Then
  assert.equal(session.mapSubscribers.size, 1);
  assert.equal(session.stoppedMapClients.length, 2);
});

test("map subscribe is feature-gated and limited to four attempts per minute", async (t) => {
  // Given
  const disabledFixture = bridgeFixture(false);
  const disabledServer = startWsServer(
    disabledFixture.cfg,
    disabledFixture.auth,
    disabledFixture.sessions,
  );
  await once(disabledServer, "listening");
  const disabledClient = await openAuthenticatedClient(disabledServer, "disabled");
  t.after(() => {
    disabledClient.terminate();
    disabledServer.close();
  });
  const disabledState = waitForMessage(
    disabledClient,
    (message) => message.type === "map_state",
  );
  disabledClient.send(JSON.stringify({ type: "map_subscribe" }));
  const disabledResult = await disabledState;

  const enabledFixture = bridgeFixture();
  const enabledServer = startWsServer(
    enabledFixture.cfg,
    enabledFixture.auth,
    enabledFixture.sessions,
  );
  await once(enabledServer, "listening");
  const enabledClient = await openAuthenticatedClient(enabledServer, "limited");
  t.after(() => {
    enabledClient.terminate();
    enabledServer.close();
  });

  // When
  const enabledStates = [];
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const state = waitForMessage(
      enabledClient,
      (message) => message.type === "map_state",
    );
    enabledClient.send(JSON.stringify({ type: "map_subscribe" }));
    enabledStates.push(await state);
  }

  // Then
  assert.deepEqual(disabledResult, {
    type: "map_state",
    state: "unsupported",
    reason: "disabled",
    ts: disabledResult.ts,
  });
  assert.deepEqual(
    enabledStates.map(({ state, reason }) => ({ state, reason })),
    [
      { state: "loading", reason: undefined },
      { state: "loading", reason: undefined },
      { state: "loading", reason: undefined },
      { state: "loading", reason: undefined },
      { state: "unsupported", reason: "rate-limit" },
    ],
  );
  assert.equal(enabledFixture.session.mapSubscribers.size, 1);
});
