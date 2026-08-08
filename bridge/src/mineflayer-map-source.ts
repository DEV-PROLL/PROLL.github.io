import { performance } from "perf_hooks";
import type { Bot } from "mineflayer";
import {
  sampleMapFrame,
  type LoadedMapAdapter,
  type LoadedMapColumn,
} from "./map-sampler";
import type {
  MapSampleResult,
  MapSourceSnapshot,
} from "./map-subscription-session";
import { headingFromMineflayerYaw } from "./position-direction";

type BlockPosition = {
  readonly x: number;
  readonly y: number;
  readonly z: number;
};

export class MineflayerMapSource {
  constructor(
    private readonly getBot: () => Bot | null,
    private readonly now: () => number,
  ) {}

  snapshot(): MapSourceSnapshot | null {
    const bot = this.getBot();
    const entity = bot?.entity;
    if (!bot || !entity) return null;
    const { position, yaw } = entity;
    if (
      !Number.isFinite(position.x) ||
      !Number.isFinite(position.y) ||
      !Number.isFinite(position.z) ||
      !Number.isFinite(yaw)
    ) {
      return null;
    }
    return {
      x: position.x,
      y: position.y,
      z: position.z,
      heading: headingFromMineflayerYaw(yaw).yaw,
      dimension: bot.game.dimension,
    };
  }

  async sample(
    snapshot: MapSourceSnapshot,
    radius: number | undefined,
    signal: AbortSignal,
  ): Promise<MapSampleResult> {
    const bot = this.getBot();
    if (!bot) throw new Error("map source unavailable");
    const loadedColumnKeys = new Set<string>();
    const minY =
      "minY" in bot.game && typeof bot.game.minY === "number"
        ? bot.game.minY
        : 0;
    const worldHeight =
      "height" in bot.game && typeof bot.game.height === "number"
        ? bot.game.height
        : 256;
    const adapter: LoadedMapAdapter = {
      getLoadedColumn: (chunkX, chunkZ) => {
        const column = bot.world.getColumn(chunkX, chunkZ);
        if (!column) return undefined;
        loadedColumnKeys.add(`${chunkX}:${chunkZ}`);
        const readStateId = column.getBlockStateId.bind(column) as unknown as (
          position: BlockPosition,
        ) => number;
        const loadedColumn: LoadedMapColumn = {
          minY,
          maxY: minY + worldHeight,
          getBlockStateId: (localX, y, localZ) =>
            readStateId({ x: localX, y, z: localZ }),
        };
        return loadedColumn;
      },
      blockNameForStateId: (stateId) =>
        bot.registry.blocksByStateId[stateId]?.name,
    };
    const sampled = await sampleMapFrame(
      adapter,
      {
        centerX: snapshot.x,
        centerY: snapshot.y,
        centerZ: snapshot.z,
        radius,
        dimension: snapshot.dimension,
        heading: snapshot.heading,
        stale: false,
        timestamp: this.now(),
        signal,
      },
      {
        clock: { now: () => performance.now() },
        scheduler: {
          yield: () =>
            new Promise<void>((resolve) => {
              setImmediate(resolve);
            }),
        },
      },
    );
    const { stats: _stats, ...frame } = sampled;
    return {
      frame: { type: "map_frame", ...frame },
      loadedColumns: loadedColumnKeys.size,
    };
  }
}
