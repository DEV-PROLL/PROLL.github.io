import assert from "node:assert/strict";
import test from "node:test";
import {
  EMPTY_MAP_VIEW,
  applyMapMessage,
  decodeMapCells,
  mapFrameRgba,
} from "../src/mapFrame.ts";

function mapFrame(overrides = {}) {
  return {
    type: "map_frame",
    centerX: 10,
    centerZ: -4,
    radius: 1,
    step: 1,
    dimension: "minecraft:overworld",
    cols: 2,
    rows: 2,
    palette: ["#000000", "#112233", "#abcdef"],
    cells: "AAECAQ==",
    heading: 90,
    stale: false,
    ts: 2_000,
    ...overrides,
  };
}

test("raw palette indices decode into exact RGBA canvas pixels", () => {
  // Given
  const frame = mapFrame();

  // When
  const cells = decodeMapCells(frame);
  const rgba = mapFrameRgba(frame);

  // Then
  assert.deepEqual([...cells], [0, 1, 2, 1]);
  assert.deepEqual([...rgba], [
    0, 0, 0, 255,
    17, 34, 51, 255,
    171, 205, 239, 255,
    17, 34, 51, 255,
  ]);
});

test("invalid dimensions and palette indices are rejected at the frame boundary", () => {
  // Given
  const oversized = mapFrame({ cols: 66, rows: 1 });
  const wrongCellCount = mapFrame({ cells: "AA==" });
  const invalidPaletteIndex = mapFrame({
    palette: ["#000000"],
    cells: "AAEAAA==",
  });

  // When / Then
  assert.throws(() => decodeMapCells(oversized), /dimensions/);
  assert.throws(() => decodeMapCells(wrongCellCount), /cell count/);
  assert.throws(() => mapFrameRgba(invalidPaletteIndex), /palette index/);
});

test("map view transitions loading live stale unsupported without timers", () => {
  // Given
  const frame = mapFrame();

  // When
  const loading = applyMapMessage(EMPTY_MAP_VIEW, {
    type: "map_state",
    state: "loading",
    ts: 1_000,
  });
  const live = applyMapMessage(loading, frame);
  const stale = applyMapMessage(live, {
    type: "map_state",
    state: "stale",
    reason: "configuration",
    ts: 3_000,
  });
  const unsupported = applyMapMessage(stale, {
    type: "map_state",
    state: "unsupported",
    reason: "capacity",
    ts: 4_000,
  });

  // Then
  assert.deepEqual(loading, {
    state: "loading",
    reason: undefined,
    frame: null,
    ts: 1_000,
  });
  assert.equal(live.state, "live");
  assert.equal(live.frame, frame);
  assert.equal(stale.state, "stale");
  assert.equal(stale.frame, frame);
  assert.deepEqual(unsupported, {
    state: "unsupported",
    reason: "capacity",
    frame: null,
    ts: 4_000,
  });
});
