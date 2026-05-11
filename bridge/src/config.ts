import path from "path";
import type { BridgeConfig } from "./types";

function num(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) {
    throw new Error(`env ${name} is not a number: ${raw}`);
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
  return {
    mcHost: str("MC_HOST"),
    mcPort: num("MC_PORT", 25565),
    mcVersion: str("MC_VERSION", "1.21.11"),
    wsPort: num("WS_PORT", 8080),
    bridgeToken: process.env.BRIDGE_TOKEN?.trim() || null,
    tokensDir: path.resolve(str("TOKENS_DIR", "./tokens")),
    allowedOrigins: allowed ? allowed.split(",").map((s) => s.trim()) : null,
    maxSessions: num("MAX_SESSIONS", 20),
    chatRateLimit: num("CHAT_RATE_LIMIT", 2),
  };
}
