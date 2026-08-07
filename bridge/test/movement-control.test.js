const assert = require("node:assert/strict");
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

function movementSession() {
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
  const session = new McSession({
    host: "example.invalid",
    port: 25565,
    version: "1.21.11",
    username: "tester",
    profilesFolder: "/tmp/proll-test-auth",
  });
  session.bot = bot;
  session.connected = true;
  return { session, bot, writes };
}

function lastPlayerInput(writes) {
  return writes.filter(({ name }) => name === "player_input").at(-1)?.params?.inputs;
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

test("writes a neutral modern input packet when the lease expires", async () => {
  const { session, bot, writes } = movementSession();

  session.setMovementControl("phone", "jump", true, 250);
  await new Promise((resolve) => setTimeout(resolve, 300));

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

test("maps Mineflayer yaw from north through its right-handed rotation", () => {
  // prismarine-physics defines yaw from -Z (north), with positive yaw toward west.
  const sectors = ["N", "NW", "W", "SW", "S", "SE", "E", "NE"];
  for (const [index, direction] of sectors.entries()) {
    assert.equal(headingFromMineflayerYaw((index * Math.PI) / 4).direction, direction);
  }
  assert.equal(headingFromMineflayerYaw(-Math.PI / 180).direction, "N");
  assert.equal(headingFromMineflayerYaw((22.6 * Math.PI) / 180).direction, "NW");
});
