import type { MapSourceSnapshot } from "./map-subscription-session";

const MAP_MOVEMENT_THRESHOLD_BLOCKS = 4;
const MAP_HEADING_THRESHOLD_DEGREES = 30;

export interface SuccessfulMapSnapshot extends MapSourceSnapshot {
  readonly dirtyRevision: number;
}

export function shouldSampleMap(
  current: MapSourceSnapshot,
  lastSuccessful: SuccessfulMapSnapshot | null,
  dirtyRevision: number,
): boolean {
  if (!lastSuccessful) return true;
  if (current.dimension !== lastSuccessful.dimension) return true;
  if (dirtyRevision !== lastSuccessful.dirtyRevision) return true;
  const horizontalDistance = Math.hypot(
    current.x - lastSuccessful.x,
    current.z - lastSuccessful.z,
  );
  if (horizontalDistance >= MAP_MOVEMENT_THRESHOLD_BLOCKS) return true;
  return (
    circularHeadingDelta(current.heading, lastSuccessful.heading) >=
    MAP_HEADING_THRESHOLD_DEGREES
  );
}

export function successfulMapSnapshot(
  snapshot: MapSourceSnapshot,
  dirtyRevision: number,
): SuccessfulMapSnapshot {
  return { ...snapshot, dirtyRevision };
}

function circularHeadingDelta(left: number, right: number): number {
  const difference = Math.abs(normalizeHeading(left) - normalizeHeading(right));
  return Math.min(difference, 360 - difference);
}

function normalizeHeading(heading: number): number {
  return ((heading % 360) + 360) % 360;
}
