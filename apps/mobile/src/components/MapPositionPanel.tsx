import { useEffect, useRef } from "react";
import { AppState, Platform, Text, View } from "react-native";
import type { MapViewState } from "../mapFrame";
import type { ClientMessage, PlayerPosition } from "../protocol";
import { MapPositionSession } from "../mapPositionSession";
import { styles } from "./MapPositionPanel.styles";
import { TopDownMap } from "./TopDownMap";

interface MapPositionPanelProps {
  connected: boolean;
  position: PlayerPosition | null;
  map: MapViewState;
  mapEnabled: boolean;
  send: (message: ClientMessage) => boolean;
  onPositionReset: () => void;
  onMapReset: () => void;
}

export function MapPositionPanel({
  connected,
  position,
  map,
  mapEnabled,
  send,
  onPositionReset,
  onMapReset,
}: MapPositionPanelProps) {
  const sendRef = useRef(send);
  const resetPositionRef = useRef(onPositionReset);
  const resetMapRef = useRef(onMapReset);
  const sessionRef = useRef<MapPositionSession | null>(null);
  if (!sessionRef.current) {
    sessionRef.current = new MapPositionSession({
      send: (message) => sendRef.current(message),
      clearPosition: () => resetPositionRef.current(),
      clearMap: () => resetMapRef.current(),
      mapEnabled,
    });
  }
  const session = sessionRef.current;

  useEffect(() => {
    sendRef.current = send;
    resetPositionRef.current = onPositionReset;
    resetMapRef.current = onMapReset;
  }, [onMapReset, onPositionReset, send]);

  useEffect(() => {
    session.setAvailable(connected);
  }, [connected, session]);

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

  return (
    <View style={styles.panel}>
      <View style={styles.header}>
        <View>
          <Text style={styles.eyebrow}>LIVE MAP</Text>
          <Text style={styles.heading}>주변 지도</Text>
        </View>
        <View style={[styles.status, connected && styles.statusOnline]}>
          <Text style={styles.statusText}>{connected ? "LIVE" : "OFFLINE"}</Text>
        </View>
      </View>

      <View style={styles.position}>
        <Text style={styles.coordinates}>{formatCoordinates(position)}</Text>
        <Text style={styles.meta}>{formatPositionMeta(position)}</Text>
      </View>

      {mapEnabled ? <TopDownMap map={map} position={position} /> : null}
    </View>
  );
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
