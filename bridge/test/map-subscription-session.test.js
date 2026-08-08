const assert = require("node:assert/strict");
const test = require("node:test");
const {
  MapSubscriptionSession,
} = require("../dist/map-subscription-session.js");

function frame(timestamp, heading = 0) {
  return {
    type: "map_frame",
    centerX: 0,
    centerZ: 0,
    radius: 1,
    step: 1,
    dimension: "minecraft:overworld",
    cols: 3,
    rows: 3,
    palette: ["#000000", "#3fb950"],
    cells: "AQEBAQEBAQEB",
    heading,
    stale: false,
    ts: timestamp,
  };
}

function sessionFixture() {
  let now = 0;
  let snapshot = {
    x: 0,
    y: 64,
    z: 0,
    heading: 0,
    dimension: "minecraft:overworld",
  };
  let loadedColumns = 1;
  let poll = null;
  let pollIntervalMs = null;
  let sampleCount = 0;
  let activeSamples = 0;
  const messages = [];
  const session = new MapSubscriptionSession({
    now: () => now,
    snapshot: () => snapshot,
    async sample(_snapshot, _radius, signal) {
      sampleCount += 1;
      activeSamples += 1;
      try {
        signal.throwIfAborted();
        return { frame: frame(now, snapshot.heading), loadedColumns };
      } finally {
        activeSamples -= 1;
      }
    },
    startPolling(callback, intervalMs) {
      poll = callback;
      pollIntervalMs = intervalMs;
      return 1;
    },
    stopPolling() {
      poll = null;
    },
  });
  return {
    messages,
    session,
    activeSamples: () => activeSamples,
    pollIntervalMs: () => pollIntervalMs,
    sampleCount: () => sampleCount,
    setLoadedColumns(value) {
      loadedColumns = value;
    },
    setNow(value) {
      now = value;
    },
    setSnapshot(value) {
      snapshot = value;
    },
    async poll() {
      assert.equal(typeof poll, "function");
      await poll();
    },
    subscribe(radius) {
      session.start("client", (message) => messages.push(message), radius);
    },
  };
}

async function until(predicate) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const result = predicate();
    if (result !== undefined) return result;
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error("condition was not reached");
}

test("initial frame is immediate and unchanged polls do not resample", async () => {
  // Given
  const fixture = sessionFixture();

  // When
  fixture.subscribe(24);
  await until(() =>
    fixture.messages.find((message) => message.type === "map_frame"),
  );
  fixture.setNow(6_000);
  await fixture.poll();

  // Then
  assert.deepEqual(
    fixture.messages.map(({ type, state }) => ({ type, state })),
    [
      { type: "map_state", state: "loading" },
      { type: "map_state", state: "live" },
      { type: "map_frame", state: undefined },
    ],
  );
  assert.equal(fixture.sampleCount(), 1);
  assert.equal(fixture.activeSamples(), 0);
  assert.equal(fixture.pollIntervalMs(), 2_000);
});

test("sampling uses exact four-block and thirty-degree success thresholds", async () => {
  // Given
  const fixture = sessionFixture();
  fixture.subscribe();
  await until(() => fixture.sampleCount() === 1 ? true : undefined);

  // When
  fixture.setNow(2_000);
  fixture.setSnapshot({
    x: 3.999,
    y: 64,
    z: 0,
    heading: 29.999,
    dimension: "minecraft:overworld",
  });
  await fixture.poll();
  assert.equal(fixture.sampleCount(), 1);

  fixture.setNow(4_000);
  fixture.setSnapshot({
    x: 4,
    y: 64,
    z: 0,
    heading: 0,
    dimension: "minecraft:overworld",
  });
  await fixture.poll();
  assert.equal(fixture.sampleCount(), 2);

  fixture.setNow(6_000);
  fixture.setSnapshot({
    x: 4,
    y: 64,
    z: 0,
    heading: 29.999,
    dimension: "minecraft:overworld",
  });
  await fixture.poll();
  assert.equal(fixture.sampleCount(), 2);

  fixture.setNow(8_000);
  fixture.setSnapshot({
    x: 4,
    y: 64,
    z: 0,
    heading: 30,
    dimension: "minecraft:overworld",
  });
  await fixture.poll();
  assert.equal(fixture.sampleCount(), 3);

  fixture.setNow(10_000);
  fixture.setSnapshot({
    x: 4,
    y: 64,
    z: 0,
    heading: 1,
    dimension: "minecraft:overworld",
  });
  await fixture.poll();
  assert.equal(fixture.sampleCount(), 3);

  fixture.setNow(12_000);
  fixture.setSnapshot({
    x: 4,
    y: 64,
    z: 0,
    heading: 0,
    dimension: "minecraft:overworld",
  });
  await fixture.poll();
  assert.equal(fixture.sampleCount(), 4);

  fixture.setNow(14_000);
  fixture.session.markDirty();
  await fixture.poll();
  assert.equal(fixture.sampleCount(), 5);

  fixture.setNow(16_000);
  fixture.setSnapshot({
    x: 4,
    y: 64,
    z: 0,
    heading: 0,
    dimension: "minecraft:the_nether",
  });
  await fixture.poll();

  // Then
  assert.equal(fixture.sampleCount(), 6);
  assert.equal(
    fixture.messages.filter(({ type }) => type === "map_frame").length,
    6,
  );
});

test("failed sampling retains the last successful comparison snapshot", async () => {
  // Given
  const fixture = sessionFixture();
  fixture.subscribe();
  await until(() => fixture.sampleCount() === 1 ? true : undefined);
  fixture.setLoadedColumns(0);

  // When
  fixture.setNow(2_000);
  fixture.setSnapshot({
    x: 4,
    y: 64,
    z: 0,
    heading: 0,
    dimension: "minecraft:overworld",
  });
  await fixture.poll();
  fixture.setLoadedColumns(1);
  fixture.setNow(4_000);
  fixture.setSnapshot({
    x: 7.9,
    y: 64,
    z: 0,
    heading: 0,
    dimension: "minecraft:overworld",
  });
  await fixture.poll();

  // Then
  assert.equal(fixture.sampleCount(), 3);
  assert.equal(
    fixture.messages.filter(({ type }) => type === "map_frame").length,
    2,
  );
});

test("no loaded chunks becomes unsupported after five seconds", async () => {
  // Given
  const fixture = sessionFixture();
  fixture.setLoadedColumns(0);
  fixture.subscribe();
  await until(() => fixture.sampleCount() === 1 ? true : undefined);

  // When
  fixture.setNow(5_000);
  await fixture.poll();

  // Then
  assert.deepEqual(fixture.messages.at(-1), {
    type: "map_state",
    state: "unsupported",
    reason: "no-loaded-chunks",
    ts: 5_000,
  });
  assert.equal(
    fixture.messages.some(({ type }) => type === "map_frame"),
    false,
  );
});

test("stop and stale suspension abort in-flight sampling and polling", async () => {
  // Given
  let poll = null;
  let aborted = 0;
  const messages = [];
  const pending = new Promise(() => {});
  const session = new MapSubscriptionSession({
    now: () => 10_000,
    snapshot: () => ({
      x: 0,
      y: 64,
      z: 0,
      heading: 0,
      dimension: "minecraft:overworld",
    }),
    sample(_snapshot, _radius, signal) {
      signal.addEventListener("abort", () => {
        aborted += 1;
      });
      return pending;
    },
    startPolling(callback) {
      poll = callback;
      return 1;
    },
    stopPolling() {
      poll = null;
    },
  });
  session.start("first", (message) => messages.push(message));
  await until(() => poll ? true : undefined);

  // When
  session.suspend("configuration");
  session.resume();
  session.stop("first");

  // Then
  assert.equal(aborted, 1);
  assert.equal(poll, null);
  assert.deepEqual(messages.at(-1), {
    type: "map_state",
    state: "stale",
    reason: "configuration",
    ts: 10_000,
  });
});
