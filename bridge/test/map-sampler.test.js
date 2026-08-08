const assert = require("node:assert/strict");
const test = require("node:test");
const {
  MAP_FRAME_MAX_BYTES,
  MAP_GRID_MAX_CELLS,
  MAP_PALETTE,
  clampMapSampleRequest,
  decodePaletteIndices,
  encodePaletteIndices,
  sampleMapFrame,
} = require("../dist/map-sampler.js");

const FIXED_RUNTIME = {
  clock: { now: () => 1_000 },
  scheduler: { yield: async () => {} },
};

function request(overrides = {}) {
  return {
    centerX: 0,
    centerY: 64,
    centerZ: 0,
    radius: 1,
    step: 1,
    dimension: "minecraft:overworld",
    heading: 90,
    stale: false,
    timestamp: 123_456,
    ...overrides,
  };
}

function unloadedAdapter(extra = {}) {
  return {
    getLoadedColumn() {
      return undefined;
    },
    blockNameForStateId() {
      return undefined;
    },
    ...extra,
  };
}

function filledAdapter(blockName, surfaceY = 64) {
  return {
    getLoadedColumn() {
      return {
        minY: -64,
        maxY: 320,
        getBlockStateId(_x, y) {
          return y > surfaceY ? 0 : 1;
        },
      };
    },
    blockNameForStateId(stateId) {
      if (stateId === 0) return "air";
      if (stateId === 1) return blockName;
      return undefined;
    },
  };
}

test("clamps radius and step so output never exceeds 65x65 cells", () => {
  // Given
  const hostileRequest = { radius: 100_000, step: -10 };

  // When
  const clamped = clampMapSampleRequest(hostileRequest);

  // Then
  assert.deepEqual(clamped, {
    radius: 256,
    step: 8,
    cols: 65,
    rows: 65,
  });
  assert.ok(clamped.cols * clamped.rows <= MAP_GRID_MAX_CELLS);
  assert.deepEqual(clampMapSampleRequest({ radius: Number.NaN, step: 0 }), {
    radius: 32,
    step: 1,
    cols: 65,
    rows: 65,
  });
});

test("marks unloaded and unsupported surface cells as palette index zero", async () => {
  // Given
  const unsupported = {
    getLoadedColumn() {
      return {
        minY: -64,
        maxY: 320,
        getBlockStateId() {
          return 99;
        },
      };
    },
    blockNameForStateId() {
      return undefined;
    },
  };

  // When
  const unloadedFrame = await sampleMapFrame(
    unloadedAdapter(),
    request(),
    FIXED_RUNTIME,
  );
  const unsupportedFrame = await sampleMapFrame(
    unsupported,
    request(),
    FIXED_RUNTIME,
  );

  // Then
  assert.deepEqual([...decodePaletteIndices(unloadedFrame.cells)], Array(9).fill(0));
  assert.deepEqual([...decodePaletteIndices(unsupportedFrame.cells)], Array(9).fill(0));
  assert.equal(unloadedFrame.stats.blockReads, 0);
  assert.equal(unsupportedFrame.stats.blockReads, 9);
});

test("never invokes chunk request or load methods", async () => {
  // Given
  let prohibitedCalls = 0;
  const adapter = unloadedAdapter({
    requestChunk() {
      prohibitedCalls += 1;
      throw new Error("requestChunk must stay unreachable");
    },
    loadColumn() {
      prohibitedCalls += 1;
      throw new Error("loadColumn must stay unreachable");
    },
  });

  // When
  const frame = await sampleMapFrame(adapter, request(), FIXED_RUNTIME);

  // Then
  assert.equal(prohibitedCalls, 0);
  assert.equal(frame.stats.blockReads, 0);
});

test("round-trips raw one-byte palette indices through base64 without RLE", () => {
  // Given
  const indices = Uint8Array.from([0, 1, 1, 1, 255, 0, 4, 4]);

  // When
  const encoded = encodePaletteIndices(indices);
  const decoded = decodePaletteIndices(encoded);

  // Then
  assert.equal(Buffer.from(encoded, "base64").byteLength, indices.byteLength);
  assert.deepEqual([...decoded], [...indices]);
});

test("classifies common surfaces into deterministic blurry-map colors", async () => {
  // Given
  const surfaces = ["grass_block", "water", "lava", "snow_block", "oak_leaves"];

  // When
  const firstPass = await Promise.all(
    surfaces.map((name) =>
      sampleMapFrame(filledAdapter(name), request({ radius: 0 }), FIXED_RUNTIME),
    ),
  );
  const secondPass = await Promise.all(
    surfaces.map((name) =>
      sampleMapFrame(filledAdapter(name), request({ radius: 0 }), FIXED_RUNTIME),
    ),
  );

  // Then
  const firstIndices = firstPass.map((frame) => decodePaletteIndices(frame.cells)[0]);
  const secondIndices = secondPass.map(
    (frame) => decodePaletteIndices(frame.cells)[0],
  );
  assert.deepEqual(secondIndices, firstIndices);
  assert.equal(firstIndices.every((index) => index > 0), true);
  assert.equal(new Set(firstIndices).size, surfaces.length);
});

test("keeps worst-case encoded frames below the 48KB ceiling", async () => {
  // Given
  const maximumRequest = request({
    radius: 100_000,
    step: 1,
    dimension: "x".repeat(10_000),
  });

  // When
  const frame = await sampleMapFrame(
    unloadedAdapter(),
    maximumRequest,
    FIXED_RUNTIME,
  );
  const serializedBytes = Buffer.byteLength(JSON.stringify(frame), "utf8");

  // Then
  assert.equal(frame.cols, 65);
  assert.equal(frame.rows, 65);
  assert.equal(decodePaletteIndices(frame.cells).byteLength, MAP_GRID_MAX_CELLS);
  assert.ok(serializedBytes <= MAP_FRAME_MAX_BYTES);
  assert.equal(frame.dimension, "unknown");
  assert.equal(frame.stale, false);
  assert.equal(frame.ts, 123_456);
  assert.equal(frame.palette, MAP_PALETTE);
});
