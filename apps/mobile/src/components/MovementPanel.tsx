import { useCallback, useEffect, useRef, useState } from "react";
import {
  AppState,
  Platform,
  Pressable,
  Text,
  View,
} from "react-native";
import { MOVEMENT_PANEL_ENABLED } from "../appConfig";
import type {
  ClientMessage,
  MovementControl,
  PlayerPosition,
} from "../protocol";
import { styles } from "./MovementPanel.styles";

const HOLD_MS = 1_500;
const HEARTBEAT_MS = 500;

interface MovementPanelProps {
  connected: boolean;
  position: PlayerPosition | null;
  send: (message: ClientMessage) => boolean;
  enabled?: boolean;
}

interface ControlButton {
  control: MovementControl;
  label: string;
  hint: string;
}

const CONTROLS: readonly ControlButton[] = [
  { control: "forward", label: "↑", hint: "앞" },
  { control: "left", label: "←", hint: "왼쪽" },
  { control: "back", label: "↓", hint: "뒤" },
  { control: "right", label: "→", hint: "오른쪽" },
  { control: "jump", label: "JUMP", hint: "점프" },
  { control: "sneak", label: "SNEAK", hint: "웅크리기" },
];

export function MovementPanel({
  connected,
  position,
  send,
  enabled = MOVEMENT_PANEL_ENABLED,
}: MovementPanelProps) {
  const [activeControls, setActiveControls] = useState<ReadonlySet<MovementControl>>(
    new Set(),
  );
  const activeRef = useRef(new Set<MovementControl>());
  const timersRef = useRef(
    new Map<MovementControl, ReturnType<typeof setInterval>>(),
  );
  const sendRef = useRef(send);
  const enabledRef = useRef(enabled);

  useEffect(() => {
    sendRef.current = send;
    enabledRef.current = enabled;
  }, [enabled, send]);

  const clearTimer = useCallback((control: MovementControl) => {
    const timer = timersRef.current.get(control);
    if (timer) clearInterval(timer);
    timersRef.current.delete(control);
  }, []);

  const updateActive = useCallback((control: MovementControl, pressed: boolean) => {
    const next = new Set(activeRef.current);
    if (pressed) next.add(control);
    else next.delete(control);
    activeRef.current = next;
    setActiveControls(next);
  }, []);

  const release = useCallback(
    (control: MovementControl) => {
      if (!activeRef.current.has(control)) return;
      clearTimer(control);
      updateActive(control, false);
      sendRef.current({ type: "movement_control", control, pressed: false });
    },
    [clearTimer, updateActive],
  );

  const stopAll = useCallback(() => {
    for (const timer of timersRef.current.values()) clearInterval(timer);
    timersRef.current.clear();
    activeRef.current = new Set();
    setActiveControls(new Set());
    sendRef.current({ type: "movement_stop_all" });
  }, []);

  const press = useCallback(
    (control: MovementControl) => {
      if (!enabledRef.current || !connected) return;
      if (activeRef.current.has(control)) return;
      clearTimer(control);
      const command: ClientMessage = {
        type: "movement_control",
        control,
        pressed: true,
        holdMs: HOLD_MS,
      };
      if (!sendRef.current(command)) return;
      updateActive(control, true);
      timersRef.current.set(
        control,
        setInterval(() => {
          if (!sendRef.current(command)) {
            clearTimer(control);
            updateActive(control, false);
          }
        }, HEARTBEAT_MS),
      );
    },
    [clearTimer, connected, updateActive],
  );

  useEffect(() => {
    if ((enabled && connected) || activeRef.current.size === 0) return;
    stopAll();
  }, [connected, enabled, stopAll]);

  useEffect(() => {
    const subscription = AppState.addEventListener("change", (state) => {
      if (state !== "active" && activeRef.current.size > 0) stopAll();
    });
    return () => subscription.remove();
  }, [stopAll]);

  useEffect(() => {
    if (Platform.OS !== "web" || typeof document === "undefined") return;
    const stopWhenHidden = () => {
      if (document.visibilityState !== "visible" && activeRef.current.size > 0) {
        stopAll();
      }
    };
    document.addEventListener("visibilitychange", stopWhenHidden);
    globalThis.addEventListener("pagehide", stopAll);
    return () => {
      document.removeEventListener("visibilitychange", stopWhenHidden);
      globalThis.removeEventListener("pagehide", stopAll);
    };
  }, [stopAll]);

  useEffect(
    () => () => {
      for (const timer of timersRef.current.values()) clearInterval(timer);
      timersRef.current.clear();
      if (enabledRef.current && activeRef.current.size > 0) {
        sendRef.current({ type: "movement_stop_all" });
      }
      activeRef.current.clear();
    },
    [],
  );

  if (!enabled) return null;

  return (
    <View style={styles.panel}>
      <View style={styles.header}>
        <View>
          <Text style={styles.eyebrow}>MOVEMENT TEST</Text>
          <Text style={styles.heading}>안전 이동</Text>
        </View>
        <View style={[styles.status, connected && styles.statusOnline]}>
          <Text style={styles.statusText}>{connected ? "READY" : "OFFLINE"}</Text>
        </View>
      </View>

      <View style={styles.position}>
        <Text style={styles.coordinates}>{formatCoordinates(position)}</Text>
        <Text style={styles.meta}>{formatPositionMeta(position)}</Text>
      </View>

      <View style={styles.controls}>
        <View style={styles.dpad}>
          <View style={styles.dpadRow}>
            <View style={styles.controlSpacer} />
            {renderControl(CONTROLS[0])}
            <View style={styles.controlSpacer} />
          </View>
          <View style={styles.dpadRow}>
            {CONTROLS.slice(1, 4).map(renderControl)}
          </View>
        </View>
        <View style={styles.actionControls}>
          {CONTROLS.slice(4).map(renderControl)}
        </View>
      </View>

      <Pressable
        accessibilityLabel="이 기기의 모든 이동 즉시 정지"
        accessibilityRole="button"
        onPress={stopAll}
        style={({ pressed }) => [styles.stop, pressed && styles.stopPressed]}
      >
        <Text style={styles.stopText}>즉시 정지</Text>
      </Pressable>
    </View>
  );

  function renderControl({ control, label, hint }: ControlButton) {
          const active = activeControls.has(control);
          return (
            <Pressable
              key={control}
              accessibilityLabel={`${hint} 이동, 누르는 동안 작동`}
              accessibilityRole="button"
              disabled={!connected}
              onPressIn={() => press(control)}
              onPressOut={() => release(control)}
              onTouchStart={() => press(control)}
              onTouchEnd={() => release(control)}
              onTouchCancel={() => release(control)}
              style={({ pressed }) => [
                styles.control,
                active || pressed ? styles.controlPressed : null,
                !connected ? styles.controlDisabled : null,
                control === "jump" || control === "sneak" ? styles.actionControl : null,
              ]}
            >
              <Text style={[styles.controlLabel, active && styles.controlLabelPressed]}>
                {label}
              </Text>
              <Text style={styles.controlHint}>{hint}</Text>
            </Pressable>
          );
  }
}

function formatCoordinates(position: PlayerPosition | null): string {
  if (!position) return "X --  Y --  Z --";
  return `X ${position.x.toFixed(1)}  Y ${position.y.toFixed(1)}  Z ${position.z.toFixed(1)}`;
}

function formatPositionMeta(position: PlayerPosition | null): string {
  if (!position) return "방향 -- · 차원 -- · 지면 --";
  const grounded =
    position.grounded == null ? "--" : position.grounded ? "GROUND" : "AIR";
  return `${position.direction} ${position.yaw.toFixed(0)}° · ${position.dimension ?? "--"} · ${grounded}`;
}
