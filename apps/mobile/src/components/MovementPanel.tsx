import { useEffect, useRef, useState } from "react";
import {
  AppState,
  Platform,
  Pressable,
  Text,
  View,
} from "react-native";
import { MOVEMENT_PANEL_ENABLED } from "../appConfig";
import type { MapViewState } from "../mapFrame";
import type {
  ClientMessage,
  MovementControl,
  PlayerPosition,
} from "../protocol";
import {
  MovementPanelSession,
  movementControlPressHandlers,
} from "../movementPanelSession";
import { styles, webHoldSafeStyle } from "./MovementPanel.styles";
import { TopDownMap } from "./TopDownMap";

interface MovementPanelProps {
  connected: boolean;
  position: PlayerPosition | null;
  map: MapViewState;
  mapEnabled: boolean;
  send: (message: ClientMessage) => boolean;
  onPositionReset: () => void;
  onMapReset: () => void;
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
  map,
  mapEnabled,
  send,
  onPositionReset,
  onMapReset,
  enabled = MOVEMENT_PANEL_ENABLED,
}: MovementPanelProps) {
  const [activeControls, setActiveControls] = useState<ReadonlySet<MovementControl>>(
    new Set(),
  );
  const sendRef = useRef(send);
  const resetPositionRef = useRef(onPositionReset);
  const resetMapRef = useRef(onMapReset);
  const sessionRef = useRef<MovementPanelSession | null>(null);
  if (!sessionRef.current) {
    sessionRef.current = new MovementPanelSession({
      send: (message) => sendRef.current(message),
      setActiveControls,
      clearPosition: () => resetPositionRef.current(),
      clearMap: () => resetMapRef.current(),
      mapEnabled,
      startHeartbeat: (callback) => setInterval(callback, 500),
      stopHeartbeat: (timer) => {
        clearInterval(timer as ReturnType<typeof setInterval>);
      },
    });
  }
  const session = sessionRef.current;

  useEffect(() => {
    sendRef.current = send;
    resetPositionRef.current = onPositionReset;
    resetMapRef.current = onMapReset;
  }, [onMapReset, onPositionReset, send]);

  useEffect(() => {
    session.setAvailable(enabled && connected);
  }, [connected, enabled, session]);

  useEffect(() => {
    const subscription = AppState.addEventListener("change", (state) => {
      if (state === "active") session.resume();
      else session.suspend();
    });
    return () => subscription.remove();
  }, [session]);

  useEffect(() => {
    if (Platform.OS !== "web" || typeof document === "undefined") return;
    const handleVisibility = () => {
      if (document.visibilityState === "visible") session.resume();
      else session.suspend();
    };
    const handlePageHide = () => session.suspend();
    document.addEventListener("visibilitychange", handleVisibility);
    globalThis.addEventListener("pagehide", handlePageHide);
    return () => {
      document.removeEventListener("visibilitychange", handleVisibility);
      globalThis.removeEventListener("pagehide", handlePageHide);
    };
  }, [session]);

  useEffect(() => () => session.dispose(), [session]);

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

      {mapEnabled ? <TopDownMap map={map} position={position} /> : null}

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
        onPress={() => session.stopAll()}
        style={({ pressed }) => [
          styles.stop,
          webHoldSafeStyle,
          pressed && styles.stopPressed,
        ]}
      >
        <Text selectable={false} style={styles.stopText}>즉시 정지</Text>
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
              {...movementControlPressHandlers(session, control)}
              style={({ pressed }) => [
                styles.control,
                webHoldSafeStyle,
                active || pressed ? styles.controlPressed : null,
                !connected ? styles.controlDisabled : null,
                control === "jump" || control === "sneak" ? styles.actionControl : null,
              ]}
            >
              <Text
                selectable={false}
                style={[styles.controlLabel, active && styles.controlLabelPressed]}
              >
                {label}
              </Text>
              <Text selectable={false} style={styles.controlHint}>{hint}</Text>
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
