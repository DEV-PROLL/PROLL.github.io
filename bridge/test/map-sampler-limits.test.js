const assert = require("node:assert/strict");
const test = require("node:test");
const {
  MAP_BLOCK_READ_MAX,
  MAP_SLICE_MAX_MS,
  MAP_TEMPORARY_MAX_BYTES,
  MapSamplingCancelledError,
  decodePaletteIndices,
  sampleMapFrame,
} = require("../dist/map-sampler.js");

function request(overrides = {}) {
  return {
    centerX: 0,
    centerY: 64,
    centerZ: 0,
    radius: 32,
    step: 1,
    dimension: "minecraft:overworld",
    heading: 0,
    stale: false,
    timestamp: 123_456,
    ...overrides,
  };
}

function deepSurfaceAdapter(onRead = () => {}) {
  return {
    getLoadedColumn() {
      return {
        minY: -64,
        maxY: 320,
        getBlockStateId(_x, y) {
          onRead();
          return y === -64 ? 1 : 0;
        },
      };
    },
    blockNameForStateId(stateId) {
      return stateId === 0 ? "air" : "stone";
    },
  };
}

test("cancels sampling at a deterministic slice boundary", async () => {
  // Given
  let now = 0;
  let reads = 0;
  const controller = new AbortController();
  const adapter = deepSurfaceAdapter(() => {
    reads += 1;
    now += 1;
  });
  const runtime = {
    clock: { now: () => now },
    scheduler: {
      async yield() {
        controller.abort();
      },
    },
  };

  // When
  const sampling = sampleMapFrame(
    adapter,
    request({ signal: controller.signal }),
    runtime,
  );

  // Then
  await assert.rejects(sampling, MapSamplingCancelledError);
  assert.equal(reads, MAP_SLICE_MAX_MS);
});

test("cuts off exactly at the completed-frame block-read budget", async () => {
  // Given
  let reads = 0;
  const adapter = deepSurfaceAdapter(() => {
    reads += 1;
  });
  const runtime = {
    clock: { now: () => 0 },
    scheduler: { yield: async () => {} },
  };

  // When
  const frame = await sampleMapFrame(adapter, request(), runtime);
  const cells = decodePaletteIndices(frame.cells);

  // Then
  assert.equal(reads, MAP_BLOCK_READ_MAX);
  assert.equal(frame.stats.blockReads, MAP_BLOCK_READ_MAX);
  assert.equal(frame.stats.readBudgetExhausted, true);
  assert.equal(cells.some((index) => index > 0), true);
  assert.equal(cells.at(-1), 0);
});

test("yields before injected work exceeds five milliseconds", async () => {
  // Given
  let now = 0;
  const sliceDurations = [];
  let sliceStartedAt = 0;
  const adapter = deepSurfaceAdapter(() => {
    now += 1;
  });
  const runtime = {
    clock: { now: () => now },
    scheduler: {
      async yield() {
        sliceDurations.push(now - sliceStartedAt);
        sliceStartedAt = now;
      },
    },
  };

  // When
  const frame = await sampleMapFrame(
    adapter,
    request({ radius: 2 }),
    runtime,
  );
  sliceDurations.push(now - sliceStartedAt);

  // Then
  assert.ok(sliceDurations.length > 1);
  assert.equal(
    sliceDurations.every((duration) => duration <= MAP_SLICE_MAX_MS),
    true,
  );
  assert.ok(frame.stats.yields > 0);
  assert.ok(frame.stats.maxSliceMs <= MAP_SLICE_MAX_MS);
});

test("repeated frames retain no growing sampler state", async () => {
  // Given
  const adapter = {
    getLoadedColumn() {
      return {
        minY: -64,
        maxY: 320,
        getBlockStateId() {
          return 1;
        },
      };
    },
    blockNameForStateId() {
      return "grass_block";
    },
  };
  const runtime = {
    clock: { now: () => 0 },
    scheduler: { yield: async () => {} },
  };

  // When
  const frames = [];
  for (let index = 0; index < 100; index += 1) {
    frames.push(await sampleMapFrame(adapter, request(), runtime));
  }

  // Then
  const temporarySizes = new Set(
    frames.map((frame) => frame.stats.temporaryBytes),
  );
  const encodedSizes = new Set(frames.map((frame) => frame.cells.length));
  assert.deepEqual([...temporarySizes], [65 * 65]);
  assert.equal(encodedSizes.size, 1);
  assert.equal(
    frames.every(
      (frame) => frame.stats.temporaryBytes <= MAP_TEMPORARY_MAX_BYTES,
    ),
    true,
  );
});
