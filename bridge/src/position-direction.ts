export type CompassDirection =
  | "N"
  | "NE"
  | "E"
  | "SE"
  | "S"
  | "SW"
  | "W"
  | "NW";

export interface Heading {
  yaw: number;
  direction: CompassDirection;
}

export function headingFromMineflayerYaw(yawRadians: number): Heading {
  const yaw = normalizeDegrees((yawRadians * 180) / Math.PI);
  const directions: readonly CompassDirection[] = [
    "N",
    "NW",
    "W",
    "SW",
    "S",
    "SE",
    "E",
    "NE",
  ];
  return {
    yaw,
    direction: directions[Math.round(yaw / 45) % directions.length] ?? "N",
  };
}

function normalizeDegrees(value: number): number {
  return ((value % 360) + 360) % 360;
}
