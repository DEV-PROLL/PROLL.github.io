import path from "path";
import type { BridgeConfig, BridgeServerProfile } from "./types";
import { assertSupportedMcVersion } from "./mc-versions";

export const HEAD_METADATA_ENABLED = process.env.HEAD_METADATA_ENABLED === "1";
export const HEAD_DEBUG_ENABLED = process.env.HEAD_DEBUG === "1";

function num(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) {
    throw new Error(`env ${name} is not a number: ${raw}`);
  }
  return n;
}

function positiveInt(name: string, fallback: number): number {
  const n = num(name, fallback);
  if (!Number.isInteger(n) || n < 1) {
    throw new Error(`env ${name} must be a positive integer: ${n}`);
  }
  return n;
}

function str(name: string, fallback?: string): string {
  const v = process.env[name];
  if (v != null && v !== "") return v;
  if (fallback != null) return fallback;
  throw new Error(`env ${name} is required`);
}

export function loadConfig(): BridgeConfig {
  const allowed = process.env.ALLOWED_ORIGINS?.trim();
  const mcHost = str("MC_HOST");
  const mcPort = num("MC_PORT", 25565);
  const mcVersion = assertSupportedMcVersion(str("MC_VERSION", "1.21.11"));
  const defaultProfile: BridgeServerProfile = {
    id: "ludulgi",
    name: "루둘기",
    host: mcHost,
    port: mcPort,
    version: mcVersion,
    publicAddress: publicServerAddress(mcHost, mcPort),
  };
  const serverProfiles = parseServerProfiles(process.env.SERVER_PROFILES, defaultProfile);

  return {
    mcHost,
    mcPort,
    mcVersion,
    serverProfiles,
    bindHost: str("BIND_HOST", "127.0.0.1"),
    wsPort: num("WS_PORT", 8080),
    bridgeToken: process.env.BRIDGE_TOKEN?.trim() || null,
    tokensDir: path.resolve(str("TOKENS_DIR", "./tokens")),
    allowedOrigins: allowed ? allowed.split(",").map((s) => s.trim()) : null,
    maxSessions: num("MAX_SESSIONS", 20),
    chatRateLimit: num("CHAT_RATE_LIMIT", 2),
    sessionGraceMs: positiveInt("SESSION_GRACE_MS", 30 * 60 * 1000),
    headMetadataEnabled: HEAD_METADATA_ENABLED,
    headDebugEnabled: HEAD_DEBUG_ENABLED,
    mapEnabled: process.env.MAP_ENABLED === "true" || process.env.MAP_ENABLED === "1",
    mapMaxSubscribers: positiveInt("MAP_MAX_SUBSCRIBERS", 2),
  };
}

function parseServerProfiles(
  raw: string | undefined,
  fallback: BridgeServerProfile,
): BridgeServerProfile[] {
  const trimmed = raw?.trim();
  if (!trimmed) return [fallback];

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new Error(`env SERVER_PROFILES is not valid JSON: ${reason}`);
  }
  if (!Array.isArray(parsed)) {
    throw new Error("env SERVER_PROFILES must be a JSON array");
  }

  const seen = new Set<string>();
  const profiles = parsed.map((item, index) => {
    if (!item || typeof item !== "object") {
      throw new Error(`env SERVER_PROFILES[${index}] must be an object`);
    }
    const obj = item as Record<string, unknown>;
    const id = stringField(obj, "id", index).toLowerCase();
    if (!/^[a-z0-9][a-z0-9_-]{0,31}$/.test(id)) {
      throw new Error(`env SERVER_PROFILES[${index}].id is invalid: ${id}`);
    }
    if (seen.has(id)) {
      throw new Error(`env SERVER_PROFILES has duplicate id: ${id}`);
    }
    seen.add(id);

    const host = stringField(obj, "host", index);
    const port = numberField(obj, "port", index, 25565);
    const version = assertSupportedMcVersion(stringField(obj, "version", index));
    const name =
      typeof obj.name === "string" && obj.name.trim() ? obj.name.trim() : id;
    const publicAddress =
      typeof obj.publicAddress === "string" && obj.publicAddress.trim()
        ? obj.publicAddress.trim()
        : publicServerAddress(host, port);

    return {
      id,
      name,
      host,
      port,
      version,
      publicAddress,
    };
  });

  if (!profiles.length) {
    throw new Error("env SERVER_PROFILES must contain at least one server");
  }
  return profiles;
}

function stringField(
  obj: Record<string, unknown>,
  field: string,
  index: number,
): string {
  const value = obj[field];
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`env SERVER_PROFILES[${index}].${field} must be a string`);
  }
  return value.trim();
}

function numberField(
  obj: Record<string, unknown>,
  field: string,
  index: number,
  fallback: number,
): number {
  const value = obj[field] ?? fallback;
  const numberValue = typeof value === "number" ? value : Number(value);
  if (!Number.isInteger(numberValue) || numberValue < 1 || numberValue > 65535) {
    throw new Error(`env SERVER_PROFILES[${index}].${field} must be a TCP port`);
  }
  return numberValue;
}

function publicServerAddress(host: string, port: number): string {
  return port === 25565 ? host : `${host}:${port}`;
}
