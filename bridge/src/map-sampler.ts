import {
  MAP_PALETTE,
  isAirBlockName,
  surfacePaletteIndex,
} from "./map-colors";
import {
  MAP_BLOCK_READ_MAX,
  MAP_FRAME_MAX_BYTES,
  MAP_SLICE_MAX_MS,
  MapFrameSizeError,
  MapSamplingCancelledError,
  clampMapSampleRequest,
  encodePaletteIndices,
} from "./map-sampler-contract";
import type {
  LoadedMapAdapter,
  LoadedMapColumn,
  MapFrame,
  MapSampleRequest,
  MapSamplerRuntime,
} from "./map-sampler-contract";

export { MAP_PALETTE };
export * from "./map-sampler-contract";

const DIMENSION_MAX_LENGTH = 128;
const LOCAL_SCAN_ABOVE = 48;
const LOCAL_SCAN_BELOW = 64;
const MAP_SLICE_YIELD_TARGET_MS = MAP_SLICE_MAX_MS - 1;

/** Mutable counters and fixed buffer for one in-progress frame only. */
type SamplingContext = {
  readonly adapter: LoadedMapAdapter;
  readonly runtime: MapSamplerRuntime;
  readonly request: MapSampleRequest;
  readonly cells: Uint8Array;
  blockReads: number;
  yields: number;
  maxSliceMs: number;
  readBudgetExhausted: boolean;
  sliceStartedAt: number;
};

type ColumnScan = {
  readonly column: LoadedMapColumn;
  readonly localX: number;
  readonly localZ: number;
};

type VerticalRange = {
  readonly top: number;
  readonly bottom: number;
};

export async function sampleMapFrame(
  adapter: LoadedMapAdapter,
  request: MapSampleRequest,
  runtime: MapSamplerRuntime,
): Promise<MapFrame> {
  throwIfCancelled(request.signal);
  const grid = clampMapSampleRequest(request);
  const cells = new Uint8Array(grid.cols * grid.rows);
  const context: SamplingContext = {
    adapter,
    runtime,
    request,
    cells,
    blockReads: 0,
    yields: 0,
    maxSliceMs: 0,
    readBudgetExhausted: false,
    sliceStartedAt: runtime.clock.now(),
  };
  const centerX = finiteInteger(request.centerX, 0);
  const centerY = finiteInteger(request.centerY, 0);
  const centerZ = finiteInteger(request.centerZ, 0);
  const startOffset = -Math.floor(((grid.cols - 1) * grid.step) / 2);

  for (let row = 0; row < grid.rows && !context.readBudgetExhausted; row += 1) {
    for (let col = 0; col < grid.cols && !context.readBudgetExhausted; col += 1) {
      await yieldIfNeeded(context);
      const blockX = centerX + startOffset + col * grid.step;
      const blockZ = centerZ + startOffset + row * grid.step;
      const column = adapter.getLoadedColumn(
        Math.floor(blockX / 16),
        Math.floor(blockZ / 16),
      );
      if (!column) continue;
      const scan: ColumnScan = {
        column,
        localX: modulo(blockX, 16),
        localZ: modulo(blockZ, 16),
      };
      cells[row * grid.cols + col] = await scanSurface(context, scan, centerY);
    }
  }

  const finalSliceMs = runtime.clock.now() - context.sliceStartedAt;
  context.maxSliceMs = Math.max(context.maxSliceMs, finalSliceMs);
  const frame: MapFrame = {
    centerX,
    centerZ,
    radius: grid.radius,
    step: grid.step,
    dimension:
      request.dimension.length > 0 &&
      request.dimension.length <= DIMENSION_MAX_LENGTH
        ? request.dimension
        : "unknown",
    cols: grid.cols,
    rows: grid.rows,
    palette: MAP_PALETTE,
    cells: encodePaletteIndices(cells),
    heading: Number.isFinite(request.heading) ? request.heading : 0,
    stale: request.stale,
    ts: finiteInteger(request.timestamp, 0),
    stats: {
      blockReads: context.blockReads,
      yields: context.yields,
      maxSliceMs: context.maxSliceMs,
      readBudgetExhausted: context.readBudgetExhausted,
      temporaryBytes: cells.byteLength,
    },
  };
  const encodedBytes = Buffer.byteLength(JSON.stringify(frame), "utf8");
  if (encodedBytes > MAP_FRAME_MAX_BYTES) throw new MapFrameSizeError(encodedBytes);
  return frame;
}

async function scanSurface(
  context: SamplingContext,
  scan: ColumnScan,
  centerY: number,
): Promise<number> {
  const top = Math.floor(scan.column.maxY) - 1;
  const bottom = Math.ceil(scan.column.minY);
  if (top < bottom) return 0;
  const localTop = Math.min(top, centerY + LOCAL_SCAN_ABOVE);
  const localBottom = Math.max(bottom, centerY - LOCAL_SCAN_BELOW);
  if (localTop < localBottom) {
    return (await scanRange(context, scan, { top, bottom })) ?? 0;
  }
  const localResult = await scanRange(context, scan, {
    top: localTop,
    bottom: localBottom,
  });
  if (localResult !== null) return localResult;
  if (top > localTop) {
    const upperResult = await scanRange(context, scan, {
      top,
      bottom: localTop + 1,
    });
    if (upperResult !== null) return upperResult;
  }
  if (localBottom > bottom) {
    const lowerResult = await scanRange(context, scan, {
      top: localBottom - 1,
      bottom,
    });
    if (lowerResult !== null) return lowerResult;
  }
  return 0;
}

async function scanRange(
  context: SamplingContext,
  scan: ColumnScan,
  range: VerticalRange,
): Promise<number | null> {
  for (let y = range.top; y >= range.bottom; y -= 1) {
    await yieldIfNeeded(context);
    if (context.blockReads >= MAP_BLOCK_READ_MAX) {
      context.readBudgetExhausted = true;
      return 0;
    }
    context.blockReads += 1;
    const stateId = scan.column.getBlockStateId(scan.localX, y, scan.localZ);
    if (stateId === undefined) return 0;
    const blockName = context.adapter.blockNameForStateId(stateId);
    if (blockName === undefined) return 0;
    if (isAirBlockName(blockName)) continue;
    return surfacePaletteIndex(blockName, y, finiteInteger(context.request.centerY, 0));
  }
  return null;
}

async function yieldIfNeeded(context: SamplingContext): Promise<void> {
  throwIfCancelled(context.request.signal);
  const elapsed = context.runtime.clock.now() - context.sliceStartedAt;
  if (elapsed < MAP_SLICE_YIELD_TARGET_MS) return;
  context.maxSliceMs = Math.max(context.maxSliceMs, elapsed);
  await context.runtime.scheduler.yield();
  context.yields += 1;
  throwIfCancelled(context.request.signal);
  context.sliceStartedAt = context.runtime.clock.now();
}

function throwIfCancelled(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new MapSamplingCancelledError();
}

function finiteInteger(value: number, fallback: number): number {
  return Number.isFinite(value) ? Math.floor(value) : fallback;
}

function modulo(value: number, divisor: number): number {
  return ((value % divisor) + divisor) % divisor;
}
