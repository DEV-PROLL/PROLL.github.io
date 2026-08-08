export const MAP_GRID_MAX_SIDE = 65;
export const MAP_GRID_MAX_CELLS = MAP_GRID_MAX_SIDE * MAP_GRID_MAX_SIDE;
export const MAP_BLOCK_READ_MAX = 250_000;
export const MAP_SLICE_MAX_MS = 5;
export const MAP_FRAME_MAX_BYTES = 48 * 1024;
export const MAP_TEMPORARY_MAX_BYTES = 2 * 1024 * 1024;

const RADIUS_BOUNDS = {
  fallback: 32,
  minimum: 1,
  maximum: 256,
} as const;
const STEP_BOUNDS = {
  fallback: 1,
  minimum: 1,
  maximum: 64,
} as const;

type IntegerBounds = {
  readonly fallback: number;
  readonly minimum: number;
  readonly maximum: number;
};

export interface LoadedMapColumn {
  readonly minY: number;
  readonly maxY: number;
  getBlockStateId(localX: number, y: number, localZ: number): number | undefined;
}

export interface LoadedMapAdapter {
  getLoadedColumn(chunkX: number, chunkZ: number): LoadedMapColumn | undefined;
  blockNameForStateId(stateId: number): string | undefined;
}

export interface MapSamplerClock {
  now(): number;
}

export interface MapSamplerScheduler {
  yield(): Promise<void>;
}

export type MapSampleRequest = {
  readonly centerX: number;
  readonly centerY: number;
  readonly centerZ: number;
  readonly radius?: number;
  readonly step?: number;
  readonly dimension: string;
  readonly heading: number;
  readonly stale: boolean;
  readonly timestamp: number;
  readonly signal?: AbortSignal;
};

export type MapSamplerRuntime = {
  readonly clock: MapSamplerClock;
  readonly scheduler: MapSamplerScheduler;
};

export type ClampedMapSampleRequest = {
  readonly radius: number;
  readonly step: number;
  readonly cols: number;
  readonly rows: number;
};

export type MapFrame = {
  readonly centerX: number;
  readonly centerZ: number;
  readonly radius: number;
  readonly step: number;
  readonly dimension: string;
  readonly cols: number;
  readonly rows: number;
  readonly palette: readonly string[];
  readonly cells: string;
  readonly heading: number;
  readonly stale: boolean;
  readonly ts: number;
  readonly stats: {
    readonly blockReads: number;
    readonly yields: number;
    readonly maxSliceMs: number;
    readonly readBudgetExhausted: boolean;
    readonly temporaryBytes: number;
  };
};

export class MapSamplingCancelledError extends Error {
  constructor() {
    super("Map sampling was cancelled");
    this.name = "MapSamplingCancelledError";
  }
}

export class MapFrameSizeError extends Error {
  readonly encodedBytes: number;

  constructor(encodedBytes: number) {
    super(`Map frame exceeded ${MAP_FRAME_MAX_BYTES} bytes`);
    this.name = "MapFrameSizeError";
    this.encodedBytes = encodedBytes;
  }
}

export function clampMapSampleRequest(request: {
  readonly radius?: number;
  readonly step?: number;
}): ClampedMapSampleRequest {
  const radius = boundedInteger(request.radius, RADIUS_BOUNDS);
  const requestedStep = boundedInteger(request.step, STEP_BOUNDS);
  const minimumStep = Math.ceil((radius * 2 + 1) / MAP_GRID_MAX_SIDE);
  const step = Math.max(requestedStep, minimumStep);
  const side = Math.ceil((radius * 2 + 1) / step);
  return { radius, step, cols: side, rows: side };
}

export function encodePaletteIndices(indices: Uint8Array): string {
  return Buffer.from(indices).toString("base64");
}

export function decodePaletteIndices(encoded: string): Uint8Array {
  return Buffer.from(encoded, "base64");
}

function boundedInteger(
  value: number | undefined,
  bounds: IntegerBounds,
): number {
  const integer =
    value === undefined || !Number.isFinite(value)
      ? bounds.fallback
      : Math.floor(value);
  return Math.max(bounds.minimum, Math.min(bounds.maximum, integer));
}
