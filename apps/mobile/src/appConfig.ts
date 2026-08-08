import { Platform } from "react-native";

export const DEFAULT_SERVER_ADDRESS = "99999.kr";
export const DEFAULT_SERVER_ID = "ludulgi";
export const DEFAULT_SERVER_LABEL = "루둘기";

const headRenderFeature =
  typeof process !== "undefined"
    ? process.env.EXPO_PUBLIC_HEAD_RENDER_ENABLED?.trim().toLowerCase()
    : undefined;

export const HEAD_RENDER_ENABLED =
  headRenderFeature === "1" || headRenderFeature === "true";

const mapFeature =
  typeof process !== "undefined"
    ? process.env.EXPO_PUBLIC_MAP_ENABLED?.trim().toLowerCase()
    : undefined;

export const MAP_ENABLED =
  mapFeature === "1" || mapFeature === "true";

export function normalizeServerId(value: string | null | undefined): string {
  const trimmed = value?.trim().toLowerCase();
  if (!trimmed || trimmed === "rudulgi") return DEFAULT_SERVER_ID;
  return trimmed;
}

const runtimeBridgeUrl =
  typeof globalThis !== "undefined"
    ? (
        globalThis as {
          __RUDULGI_BRIDGE_URL__?: unknown;
        }
      ).__RUDULGI_BRIDGE_URL__
    : undefined;

const envBridgeUrl =
  typeof process !== "undefined"
    ? process.env.EXPO_PUBLIC_BRIDGE_URL?.trim()
    : undefined;

export const DEFAULT_BRIDGE_URL =
  (typeof runtimeBridgeUrl === "string" ? runtimeBridgeUrl.trim() : "") ||
  envBridgeUrl ||
  (__DEV__
    ? Platform.OS === "android"
      ? "ws://10.0.2.2:8080"
      : "ws://localhost:8080"
    : "");
