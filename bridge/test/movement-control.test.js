const assert = require("node:assert/strict");
const test = require("node:test");
const {
  MOVEMENT_HOLD_MAX_MS,
  MOVEMENT_RATE_LIMIT,
  MovementLeaseBook,
  MovementRateGate,
  isMovementAllowed,
  parseMovementControlMessage,
} = require("../dist/movement-control.js");
const {
  headingFromMineflayerYaw,
} = require("../dist/position-direction.js");

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

test("maps Mineflayer yaw from north through its right-handed rotation", () => {
  // prismarine-physics defines yaw from -Z (north), with positive yaw toward west.
  const sectors = ["N", "NW", "W", "SW", "S", "SE", "E", "NE"];
  for (const [index, direction] of sectors.entries()) {
    assert.equal(headingFromMineflayerYaw((index * Math.PI) / 4).direction, direction);
  }
  assert.equal(headingFromMineflayerYaw(-Math.PI / 180).direction, "N");
  assert.equal(headingFromMineflayerYaw((22.6 * Math.PI) / 180).direction, "NW");
});
