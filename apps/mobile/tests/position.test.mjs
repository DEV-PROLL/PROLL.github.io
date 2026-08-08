import assert from "node:assert/strict";
import test from "node:test";
import {
  classifyPositionFreshness,
  minecraftHeadingRotation,
  positionAvailability,
} from "../src/position.ts";

test("classifies position freshness at exact time boundaries", () => {
  // Given
  const receivedAt = 50_000;

  // When
  const states = [
    classifyPositionFreshness(receivedAt, receivedAt + 999),
    classifyPositionFreshness(receivedAt, receivedAt + 1_000),
    classifyPositionFreshness(receivedAt, receivedAt + 9_999),
    classifyPositionFreshness(receivedAt, receivedAt + 10_000),
  ];

  // Then
  assert.deepEqual(states, ["fresh", "aging", "aging", "stale"]);
});

test("treats a future position timestamp as fresh", () => {
  // Given
  const receivedAt = 50_000;
  const now = 49_000;

  // When
  const state = classifyPositionFreshness(receivedAt, now);

  // Then
  assert.equal(state, "fresh");
});

test("reports offline and missing position before freshness", () => {
  // Given
  const receivedAt = 50_000;
  const now = 50_500;

  // When
  const states = [
    positionAvailability(false, receivedAt, now),
    positionAvailability(true, null, now),
    positionAvailability(true, receivedAt, now),
  ];

  // Then
  assert.deepEqual(states, ["offline", "missing", "fresh"]);
});

test("rotates a north arrow using the bridge heading convention", () => {
  // Given
  const yaws = [0, 45, 90, 135, 180, 225, 270, 315, -135, 360];

  // When
  const rotations = yaws.map(minecraftHeadingRotation);

  // Then
  assert.deepEqual(rotations, [0, 315, 270, 225, 180, 135, 90, 45, 135, 0]);
});
