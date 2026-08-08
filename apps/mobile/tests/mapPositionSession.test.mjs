import assert from "node:assert/strict";
import test from "node:test";
import { MapPositionSession } from "../src/mapPositionSession.ts";

function sessionFixture(mapEnabled = false) {
  const messages = [];
  let positionClearCount = 0;
  let mapClearCount = 0;
  const session = new MapPositionSession({
    send(message) {
      messages.push(message);
      return true;
    },
    clearPosition() {
      positionClearCount += 1;
    },
    clearMap() {
      mapClearCount += 1;
    },
    mapEnabled,
  });
  return {
    messages,
    session,
    positionClearCount: () => positionClearCount,
    mapClearCount: () => mapClearCount,
  };
}

test("map and position subscriptions follow the visible panel lifecycle", () => {
  const fixture = sessionFixture(true);

  fixture.session.setAvailable(true);
  fixture.session.suspend();
  fixture.session.resume();
  fixture.session.dispose();

  assert.deepEqual(fixture.messages, [
    { type: "position_subscribe" },
    { type: "map_subscribe" },
    { type: "position_unsubscribe" },
    { type: "map_unsubscribe" },
    { type: "position_subscribe" },
    { type: "map_subscribe" },
    { type: "position_unsubscribe" },
    { type: "map_unsubscribe" },
  ]);
  assert.equal(fixture.positionClearCount(), 1);
  assert.equal(fixture.mapClearCount(), 1);
});

test("subscriptions are idempotent and stop when disconnected", () => {
  const fixture = sessionFixture();

  fixture.session.setAvailable(true);
  fixture.session.setAvailable(true);
  fixture.session.setAvailable(false);
  fixture.session.setAvailable(false);

  assert.deepEqual(fixture.messages, [
    { type: "position_subscribe" },
    { type: "position_unsubscribe" },
  ]);
  assert.equal(fixture.positionClearCount(), 1);
  assert.equal(fixture.mapClearCount(), 1);
});
