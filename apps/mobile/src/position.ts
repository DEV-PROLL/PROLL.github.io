export type PositionFreshness = "fresh" | "aging" | "stale";
export type PositionAvailability = "offline" | "missing" | PositionFreshness;

export const POSITION_FRESH_MS = 1_000;
export const POSITION_STALE_MS = 10_000;

export function classifyPositionFreshness(
  positionTimestampMs: number,
  nowTimestampMs: number,
): PositionFreshness {
  const ageMs = Math.max(0, nowTimestampMs - positionTimestampMs);
  if (ageMs < POSITION_FRESH_MS) return "fresh";
  if (ageMs >= POSITION_STALE_MS) return "stale";
  return "aging";
}

export function positionAvailability(
  connected: boolean,
  positionTimestampMs: number | null,
  nowTimestampMs: number,
): PositionAvailability {
  if (!connected) return "offline";
  if (positionTimestampMs == null) return "missing";
  return classifyPositionFreshness(positionTimestampMs, nowTimestampMs);
}

export function minecraftHeadingRotation(yaw: number): number {
  return ((-yaw % 360) + 360) % 360;
}
