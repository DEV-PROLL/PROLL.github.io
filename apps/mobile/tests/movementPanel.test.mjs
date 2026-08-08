import assert from "node:assert/strict";
import test from "node:test";
import {
  MovementPanelSession,
  movementControlPressHandlers,
} from "../src/movementPanelSession.ts";

function sessionFixture() {
  const messages = [];
  const activeStates = [];
  const timers = new Map();
  let nextTimer = 1;
  let positionClearCount = 0;
  let sendResult = true;
  const session = new MovementPanelSession({
    send(message) {
      messages.push(message);
      return sendResult;
    },
    setActiveControls(controls) {
      activeStates.push([...controls]);
    },
    clearPosition() {
      positionClearCount += 1;
    },
    startHeartbeat(callback) {
      const timer = nextTimer;
      nextTimer += 1;
      timers.set(timer, callback);
      return timer;
    },
    stopHeartbeat(timer) {
      timers.delete(timer);
    },
  });
  return {
    activeStates,
    messages,
    session,
    timers,
    positionClearCount: () => positionClearCount,
    setSendResult(value) {
      sendResult = value;
    },
  };
}

test("movement panel subscribes only while available", () => {
  // Given
  const fixture = sessionFixture();

  // When
  fixture.session.setAvailable(true);
  fixture.session.setAvailable(true);
  fixture.session.suspend();
  fixture.session.suspend();
  fixture.session.resume();

  // Then
  assert.deepEqual(fixture.messages, [
    { type: "position_subscribe" },
    { type: "movement_stop_all" },
    { type: "position_unsubscribe" },
    { type: "position_subscribe" },
  ]);
  assert.equal(fixture.positionClearCount(), 1);
});

test("movement pointer handlers press, release, and cancel exactly once", () => {
  // Given
  const fixture = sessionFixture();
  fixture.session.setAvailable(true);
  const handlers = movementControlPressHandlers(fixture.session, "forward");

  // When
  handlers.onPointerDown();
  handlers.onPointerDown();
  handlers.onPointerCancel();
  handlers.onPointerUp();

  // Then
  assert.deepEqual(Object.keys(handlers).sort(), [
    "onPointerCancel",
    "onPointerDown",
    "onPointerLeave",
    "onPointerUp",
  ]);
  assert.deepEqual(
    fixture.messages.filter(({ type }) => type === "movement_control"),
    [
      {
        type: "movement_control",
        control: "forward",
        pressed: true,
        holdMs: 1_500,
      },
      {
        type: "movement_control",
        control: "forward",
        pressed: false,
      },
    ],
  );
  assert.equal(fixture.timers.size, 0);
  assert.deepEqual(fixture.session.activeControls(), []);
});

test("visibility loss clears controls, timers, position, and subscription", () => {
  // Given
  const fixture = sessionFixture();
  fixture.session.setAvailable(true);
  fixture.session.press("jump");
  fixture.session.press("forward");

  // When
  fixture.session.suspend();

  // Then
  assert.equal(fixture.timers.size, 0);
  assert.deepEqual(fixture.session.activeControls(), []);
  assert.deepEqual(fixture.messages.slice(-2), [
    { type: "movement_stop_all" },
    { type: "position_unsubscribe" },
  ]);
  assert.equal(fixture.positionClearCount(), 1);
});

test("websocket loss clears controls before a later reconnect", () => {
  // Given
  const fixture = sessionFixture();
  fixture.session.setAvailable(true);
  fixture.session.press("right");

  // When
  fixture.session.setAvailable(false);
  fixture.session.setAvailable(true);

  // Then
  assert.equal(fixture.timers.size, 0);
  assert.deepEqual(fixture.session.activeControls(), []);
  assert.deepEqual(fixture.messages.slice(-3), [
    { type: "movement_stop_all" },
    { type: "position_unsubscribe" },
    { type: "position_subscribe" },
  ]);
  assert.equal(fixture.positionClearCount(), 1);
});

test("failed movement heartbeat releases local pressed state", () => {
  // Given
  const fixture = sessionFixture();
  fixture.session.setAvailable(true);
  fixture.session.press("left");
  const heartbeat = [...fixture.timers.values()][0];
  assert.equal(typeof heartbeat, "function");
  fixture.setSendResult(false);

  // When
  heartbeat();

  // Then
  assert.equal(fixture.timers.size, 0);
  assert.deepEqual(fixture.session.activeControls(), []);
  assert.deepEqual(fixture.activeStates.at(-1), []);
});

test("unmount cleanup is idempotent after a prior lifecycle suspension", () => {
  // Given
  const fixture = sessionFixture();
  fixture.session.setAvailable(true);
  fixture.session.press("sneak");
  fixture.session.suspend();
  const messagesAfterSuspend = fixture.messages.length;

  // When
  fixture.session.dispose();
  fixture.session.dispose();

  // Then
  assert.equal(fixture.messages.length, messagesAfterSuspend);
  assert.equal(fixture.timers.size, 0);
});
