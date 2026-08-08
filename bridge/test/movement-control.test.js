const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const test = require("node:test");
const {
  MOVEMENT_HOLD_MAX_MS,
  MOVEMENT_RATE_LIMIT,
  MovementLeaseBook,
  MovementRateGate,
  isMovementAllowed,
  parseMovementControlMessage,
  toPlayerInputFlags,
} = require("../dist/movement-control.js");
const {
  headingFromMineflayerYaw,
} = require("../dist/position-direction.js");
const { McSession } = require("../dist/mc-session.js");
const { SessionManager } = require("../dist/session-manager.js");

function movementSession() {
  let now = 10_000;
  const writes = [];
  const controls = new Map();
  const bot = {
    _client: {
      write(name, params) {
        writes.push({ name, params });
      },
    },
    physicsEnabled: false,
    supportFeature(feature) {
      return feature === "newPlayerInputPacket";
    },
    clearControlStates() {
      controls.clear();
    },
    setControlState(control, active) {
      if (active) controls.set(control, true);
      else controls.delete(control);
    },
    getControlState(control) {
      return controls.get(control) === true;
    },
    quit() {},
  };
  const session = new McSession(
    {
      host: "example.invalid",
      port: 25565,
      version: "1.21.11",
      username: "tester",
      profilesFolder: "/tmp/proll-test-auth",
    },
    () => now,
  );
  session.bot = bot;
  session.connected = true;
  return {
    session,
    bot,
    writes,
    setNow(value) {
      now = value;
    },
  };
}

function lastPlayerInput(writes) {
  return writes.filter(({ name }) => name === "player_input").at(-1)?.params?.inputs;
}

function diagnosticSession() {
  let now = 10_000;
  const client = new EventEmitter();
  client.state = "play";
  client.write = () => {};
  const controls = new Map();
  const bot = new EventEmitter();
  Object.assign(bot, {
    _client: client,
    username: "tester",
    players: {},
    physicsEnabled: false,
    game: { gameMode: "survival", dimension: "overworld" },
    world: {
      getColumns() {
        return [{}, {}, {}];
      },
    },
    entity: {
      position: { x: 0, y: 64, z: 0 },
      velocity: { x: 0, y: 0, z: 0 },
      yaw: 0,
      onGround: true,
    },
    blockAt() {
      return {};
    },
    supportFeature() {
      return false;
    },
    clearControlStates() {
      controls.clear();
    },
    setControlState(control, active) {
      if (active) controls.set(control, true);
      else controls.delete(control);
    },
    getControlState(control) {
      return controls.get(control) === true;
    },
    quit() {},
  });
  const session = new McSession(
    {
      host: "example.invalid",
      port: 25565,
      version: "1.21.11",
      username: "tester",
      profilesFolder: "/tmp/proll-test-auth",
    },
    () => now,
  );
  session.bot = bot;
  session.connected = true;
  session.wireEvents(bot);
  session.wireProtocolCompat(bot);
  return {
    bot,
    client,
    session,
    setNow(value) {
      now = value;
    },
  };
}

const NEUTRAL_INPUT = {
  forward: false,
  backward: false,
  left: false,
  right: false,
  jump: false,
  shift: false,
  sprint: false,
};

test("expires a held control when its lease becomes stale", () => {
  // Given
  const leases = new MovementLeaseBook();
  leases.press("phone", "forward", 1_000, 10_000);

  // When
  const changedEarly = leases.expire(10_999);
  const changedAtDeadline = leases.expire(11_000);

  // Then
  assert.equal(changedEarly, false);
  assert.equal(changedAtDeadline, true);
  assert.deepEqual([...leases.activeControls()], []);
});

test("caps a hold lease so a lost release cannot move indefinitely", () => {
  // Given
  const leases = new MovementLeaseBook();

  // When
  leases.press("phone", "forward", MOVEMENT_HOLD_MAX_MS * 5, 1_000);
  const changed = leases.expire(1_000 + MOVEMENT_HOLD_MAX_MS);

  // Then
  assert.equal(changed, true);
  assert.equal(leases.isActive(), false);
});

test("stopping one client preserves another client's controls", () => {
  // Given
  const leases = new MovementLeaseBook();
  leases.press("phone", "forward", 1_000, 0);
  leases.press("tablet", "jump", 1_000, 0);

  // When
  const changed = leases.stopClient("phone");

  // Then
  assert.equal(changed, true);
  assert.deepEqual([...leases.activeControls()], ["jump"]);
  assert.equal(leases.activeClientCount(), 1);
});

test("stop-all clears every control from every client", () => {
  // Given
  const leases = new MovementLeaseBook();
  leases.press("phone", "left", 1_000, 0);
  leases.press("tablet", "right", 1_000, 0);

  // When
  const changed = leases.stopAll();

  // Then
  assert.equal(changed, true);
  assert.equal(leases.isActive(), false);
  assert.equal(leases.activeClientCount(), 0);
});

test("movement rate gate rejects excess commands and resets by window", () => {
  // Given
  const gate = new MovementRateGate();
  const accepted = [];

  // When
  for (let index = 0; index < MOVEMENT_RATE_LIMIT + 1; index += 1) {
    accepted.push(gate.allow("phone", 5_000));
  }
  const acceptedAfterWindow = gate.allow("phone", 6_000);

  // Then
  assert.equal(accepted.slice(0, MOVEMENT_RATE_LIMIT).every(Boolean), true);
  assert.equal(accepted.at(-1), false);
  assert.equal(acceptedAfterWindow, true);
});

test("movement parser accepts only bounded known controls", () => {
  // Given
  const valid = {
    type: "movement_control",
    control: "sneak",
    pressed: true,
    holdMs: 750,
  };
  const unknownControl = { ...valid, control: "sprint" };
  const invalidHold = { ...valid, holdMs: 10 };

  // When
  const parsed = parseMovementControlMessage(valid);
  const rejectedControl = parseMovementControlMessage(unknownControl);
  const rejectedHold = parseMovementControlMessage(invalidHold);

  // Then
  assert.deepEqual(parsed, {
    ok: true,
    value: { control: "sneak", pressed: true, holdMs: 750 },
  });
  assert.equal(rejectedControl.ok, false);
  assert.equal(rejectedHold.ok, false);
});

test("movement authorization is fail-closed and case-insensitive", () => {
  assert.equal(isMovementAllowed("vmfhf", []), false);
  assert.equal(isMovementAllowed(null, ["vmfhf"]), false);
  assert.equal(isMovementAllowed("VMFHF", ["vmfhf"]), true);
  assert.equal(isMovementAllowed("other", ["vmfhf"]), false);
});

test("maps every movement control to the modern player_input packet", () => {
  assert.deepEqual(
    toPlayerInputFlags(
      new Set(["forward", "back", "left", "right", "jump", "sneak"]),
    ),
    {
      forward: true,
      backward: true,
      left: true,
      right: true,
      jump: true,
      shift: true,
      sprint: false,
    },
  );
  assert.deepEqual(toPlayerInputFlags(new Set()), {
    forward: false,
    backward: false,
    left: false,
    right: false,
    jump: false,
    shift: false,
    sprint: false,
  });
});

test("writes a neutral modern input packet when a control is released", () => {
  const { session, bot, writes } = movementSession();

  session.setMovementControl("phone", "forward", true, 1_000);
  assert.equal(lastPlayerInput(writes).forward, true);
  assert.equal(bot.physicsEnabled, true);

  session.setMovementControl("phone", "forward", false, 0);
  assert.deepEqual(lastPlayerInput(writes), NEUTRAL_INPUT);
  assert.equal(bot.physicsEnabled, false);
  session.shutdown("test complete");
});

test("writes a neutral modern input packet when a client detaches", () => {
  const { session, bot, writes } = movementSession();

  session.setMovementControl("phone", "left", true, 1_000);
  session.stopMovementForClient("phone");

  assert.deepEqual(lastPlayerInput(writes), NEUTRAL_INPUT);
  assert.equal(bot.physicsEnabled, false);
  session.shutdown("test complete");
});

test("writes a neutral modern input packet when the lease expires", () => {
  const { session, bot, writes, setNow } = movementSession();

  session.setMovementControl("phone", "jump", true, 250);
  setNow(10_250);
  session.expireMovementLeases();

  assert.deepEqual(lastPlayerInput(writes), NEUTRAL_INPUT);
  assert.equal(bot.physicsEnabled, false);
  session.shutdown("test complete");
});

test("writes a neutral modern input packet during shutdown", () => {
  const { session, bot, writes } = movementSession();

  session.setMovementControl("phone", "right", true, 1_000);
  session.shutdown("test complete");

  assert.deepEqual(lastPlayerInput(writes), NEUTRAL_INPUT);
  assert.equal(bot.physicsEnabled, false);
});

test("records exact movement lifecycle epochs and forced-move sync", (t) => {
  // Given
  const { bot, client, session, setNow } = diagnosticSession();
  t.after(() => session.shutdown("test complete"));

  // When
  client.emit("start_configuration");
  const afterConfigurationRestart = session.movementDiagnostics();
  setNow(10_100);
  bot.emit("login");
  setNow(10_200);
  bot.emit("respawn");
  setNow(10_300);
  bot.emit("death");
  setNow(10_400);
  bot.emit("mount");
  setNow(10_500);
  bot.emit("forcedMove");
  const afterForcedMove = session.movementDiagnostics();
  setNow(10_600);
  bot.emit("physicsTick");
  setNow(10_700);
  client.emit("start_configuration");
  const diagnostics = session.movementDiagnostics();

  // Then
  assert.equal(afterConfigurationRestart.movementEpoch, 1);
  assert.equal(afterConfigurationRestart.epochEvents.login.count, 0);
  assert.equal(afterForcedMove.movementEpoch, 5);
  assert.equal(afterForcedMove.teleportEpoch, 5);
  assert.equal(diagnostics.movementEpoch, 6);
  assert.equal(diagnostics.teleportEpoch, 5);
  assert.deepEqual(diagnostics.epochEvents, {
    start_configuration: { count: 2, lastAt: 10_700 },
    login: { count: 1, lastAt: 10_100 },
    respawn: { count: 1, lastAt: 10_200 },
    death: { count: 1, lastAt: 10_300 },
    mount: { count: 1, lastAt: 10_400 },
    forcedMove: { count: 1, lastAt: 10_500 },
  });
  assert.equal(diagnostics.lastForcedMoveAt, 10_500);
  assert.equal(diagnostics.lastPhysicsTickAt, 10_600);
  assert.equal(diagnostics.loadedColumns, 3);
});

test("publishes movement evidence through managed session status", (t) => {
  // Given
  const { bot, client, session, setNow } = diagnosticSession();
  t.after(() => session.shutdown("test complete"));
  const manager = new SessionManager({ maxSessions: 1 });
  manager.sessions.set("tester@main@1.21.11", {
    session,
    userId: "tester",
    target: {
      id: "main",
      name: "Main",
      host: "example.invalid",
      port: 25565,
      publicAddress: "example.invalid",
      version: "1.21.11",
    },
    refCount: 1,
    graceTimer: null,
    graceExpiresAt: null,
    createdAt: 1_000,
    lastAttachedAt: 2_000,
  });

  // When
  client.emit("start_configuration");
  setNow(10_100);
  bot.emit("forcedMove");
  const summary = manager.stats().sessions[0];

  // Then
  assert.equal(summary.movementEpoch, 1);
  assert.equal(summary.teleportEpoch, 1);
  assert.deepEqual(summary.epochEvents.start_configuration, {
    count: 1,
    lastAt: 10_000,
  });
  assert.equal(summary.lastForcedMoveAt, 10_100);
  assert.equal(summary.loadedColumns, 3);
});

test("reports a bounded three-second position delta sample", (t) => {
  // Given
  const { bot, session, setNow } = diagnosticSession();
  t.after(() => session.shutdown("test complete"));

  // When
  for (let index = 0; index < 14; index += 1) {
    setNow(10_000 + index * 250);
    bot.entity.position = { x: index, y: 64, z: index * -2 };
    session.emitPosition(true);
  }
  const diagnostics = session.movementDiagnostics();

  // Then
  assert.equal(diagnostics.positionDelta3s.samples.length, 12);
  assert.deepEqual(diagnostics.positionDelta3s.from, {
    x: 2,
    y: 64,
    z: -4,
    ts: 10_500,
  });
  assert.deepEqual(diagnostics.positionDelta3s.to, {
    x: 13,
    y: 64,
    z: -26,
    ts: 13_250,
  });
  assert.deepEqual(diagnostics.positionDelta3s.delta, {
    x: 11,
    y: 0,
    z: -22,
    distance: Math.sqrt(605),
    elapsedMs: 2_750,
  });
});

test("maps Mineflayer yaw from north through its right-handed rotation", () => {
  // prismarine-physics defines yaw from -Z (north), with positive yaw toward west.
  const sectors = ["N", "NW", "W", "SW", "S", "SE", "E", "NE"];
  for (const [index, direction] of sectors.entries()) {
    assert.equal(headingFromMineflayerYaw((index * Math.PI) / 4).direction, direction);
  }
  assert.equal(headingFromMineflayerYaw(-Math.PI / 180).direction, "N");
  assert.equal(headingFromMineflayerYaw((22.6 * Math.PI) / 180).direction, "NW");
});
