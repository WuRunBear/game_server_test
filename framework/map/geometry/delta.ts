/**
 * 地形写回的增量序列化（framework/map/geometry/delta.ts）。
 *
 * 底板（tiles/walkable）允许经运行时写回入口修改（docs/map-system-v2-design.md
 * §3）：存档只记偏离出厂底板的那几格——落盘时对当前数组与出厂底板做 diff，
 * 序列化为稀疏终态修改项（last-write-wins，不存事件流）；读档时种子重算出厂
 * 底板 → 底板指纹比对 → 叠加修改项。修改数超过阈值（约 10% tiles）降级为
 * 现行全量快照格式，运行时逻辑不变，仅序列化格式二选一。
 *
 * 纯数据层：diff/apply 只操作类型化数组与纯对象，不触碰 ECS/world；
 * 出厂底板的登记与持有见 map/runtime/terrainWriteback（bootMaps 写、序列化读）。
 */
import type { MapGeometry } from "map/geometry/types";

/**
 * 可写回的底板字段。
 *
 * v1 决策（设计 §3.4）：只开放 tiles（地面语义）与 walkable（通行位）——
 * 焦土/小径类持久变化走 tiles、通行性变化走 walkable；level 写回后置
 * （层号改动牵连碰撞/跨层语义，先不开放），因此增量项不含 level 字段。
 */
export type WritableTileField = "tiles" | "walkable";

/** 单格终态修改项（last-write-wins：存的是叠加后的终值，不携带时刻）。 */
export interface TileModification {
  /** tile 线性索引（行主序，y * width + x）。 */
  tileIndex: number;
  /** 被改写的底板字段。 */
  field: WritableTileField;
  /** 终态值（tiles 为地面语义 id 0-255；walkable 为 0|1）。 */
  value: number;
}

/**
 * 地图快照的增量形态（record.maps 条目二形态之一，format:"delta" 判别）。
 *
 * 只携带 diff 产物与出厂底板指纹——tiles/walkable/level/regions 等全部底板
 * 内容由读档路径按 seed 重算（指纹比对通过后叠加修改项），不重复落盘。
 */
export interface SerializedMapDelta {
  /** 形态判别（全量形态 SerializedMapGeometry 无此字段）。 */
  format: "delta";
  /** 地图 key（与 record.maps 的键一致，自描述）。 */
  key: string;
  /** 出厂底板内容指纹（生成时的 geometry.version；读档重算底板后强校验）。 */
  baseVersion: string;
  /** 稀疏终态修改项（升序不保证，叠加按数组序 last-write-wins）。 */
  modifications: TileModification[];
}

/**
 * 降级阈值（占比）：修改格数超过 tiles 总数的该比例时，序列化回退全量快照
 * （设计 §3.3「约 10%」）。严格大于才算超（恰好等于阈值仍走增量）。
 */
export const DELTA_DOWNGRADE_RATIO = 0.1;

/**
 * 出厂底板（内存驻留，不持久化）：生成时的 tiles/walkable 原始快照 + 内容指纹。
 *
 * 序列化 diff 的基准；类型化数组持有**副本**（不与几何共享引用），写回入口
 * 原地改数组不会污染底板。
 */
export interface TerrainBaseline {
  /** 生成时的地面语义数组副本。 */
  tiles: Uint8Array;
  /** 生成时的通行位数组副本。 */
  walkable: Uint8Array;
  /** 生成时的内容指纹（底板指纹，读档路径据此拒绝配置/种子漂移的存档）。 */
  version: string;
}

/**
 * 捕获几何的出厂底板（tiles/walkable 副本 + 当前指纹）。
 *
 * 由 bootMaps 在生成路径调用（工厂产物冻结瞬间）；调用方须在随后任何写回
 * 之前捕获，否则 diff 基准被污染。
 */
export function captureTerrainBaseline(geometry: MapGeometry): TerrainBaseline {
  return {
    tiles: geometry.tiles.slice(),
    walkable: geometry.walkable.slice(),
    version: geometry.version,
  };
}

/**
 * 对出厂底板做 diff，产出稀疏终态修改项（存档序列化的增量来源）。
 *
 * 逐格比较 tiles/walkable 两个通道，与底板不同的格各产出一条修改项——
 * 数组即时状态即终态，天然 last-write-wins（与脏格队列无关：队列推完即清、
 * 只服务在线推送，存档 diff 恒以底板重比为准）。
 *
 * @param geometry 当前几何
 * @param baseline 出厂底板（须与几何同图同时捕获）
 * @returns 修改项数组（tileIndex 升序；同格双通道各自独立产出）
 * @throws Error 当底板与几何的数组长度不一致（编程错误，fail-fast）
 */
export function computeTileModifications(
  geometry: MapGeometry,
  baseline: TerrainBaseline,
): TileModification[] {
  const total = geometry.grid.width * geometry.grid.height;
  if (baseline.tiles.length !== total || geometry.tiles.length !== total) {
    throw new Error(
      `terrain baseline mismatch on map "${geometry.key}": tiles length ${geometry.tiles.length}/${baseline.tiles.length} != width*height ${total}`,
    );
  }
  if (baseline.walkable.length !== total || geometry.walkable.length !== total) {
    throw new Error(
      `terrain baseline mismatch on map "${geometry.key}": walkable length ${geometry.walkable.length}/${baseline.walkable.length} != width*height ${total}`,
    );
  }

  const modifications: TileModification[] = [];
  for (let i = 0; i < total; i++) {
    if (geometry.tiles[i] !== baseline.tiles[i]) {
      modifications.push({ tileIndex: i, field: "tiles", value: geometry.tiles[i]! });
    }
    if (geometry.walkable[i] !== baseline.walkable[i]) {
      modifications.push({ tileIndex: i, field: "walkable", value: geometry.walkable[i]! });
    }
  }
  return modifications;
}

/**
 * 把稀疏终态修改项原地叠加到几何数组上（读档路径）。
 *
 * 校验（畸形存档绝不静默加载，fail-fast）：
 * - modifications 须为数组；
 * - tileIndex 须为 [0, width*height) 内的整数；
 * - field 须为 tiles|walkable；value 须在字段值域内（tiles 整数 0-255，
 *   walkable 严格 0|1）。
 *
 * 不重算 version（叠加后的指纹由调用方统一重算——boot 分支还要先跑结构
 * 校验，指纹只算一次）；不校验分层可达性等图级结构约束（由调用方的
 * validateMapGeometry 统一兜底）。
 *
 * @throws Error 任一条目畸形（消息含条目序号与内容）
 */
export function applyTileModifications(
  geometry: MapGeometry,
  modifications: readonly TileModification[],
): void {
  if (!Array.isArray(modifications)) {
    throw new Error(`map "${geometry.key}": delta modifications must be an array`);
  }
  const total = geometry.grid.width * geometry.grid.height;
  for (let i = 0; i < modifications.length; i++) {
    const mod = modifications[i]!;
    const described = `map "${geometry.key}" modification[${i}] ${JSON.stringify(mod)}`;
    if (mod.field !== "tiles" && mod.field !== "walkable") {
      throw new Error(`${described}: unknown field (expected "tiles" | "walkable")`);
    }
    if (!Number.isInteger(mod.tileIndex) || mod.tileIndex < 0 || mod.tileIndex >= total) {
      throw new Error(`${described}: tileIndex out of range (0..${total - 1})`);
    }
    if (mod.field === "tiles") {
      if (!Number.isInteger(mod.value) || mod.value < 0 || mod.value > 255) {
        throw new Error(`${described}: tiles value out of range (0..255)`);
      }
    } else if (mod.value !== 0 && mod.value !== 1) {
      throw new Error(`${described}: walkable value must be 0 or 1`);
    }
    if (mod.field === "tiles") {
      geometry.tiles[mod.tileIndex] = mod.value;
    } else {
      geometry.walkable[mod.tileIndex] = mod.value;
    }
  }
}

/**
 * 修改格数是否超过降级阈值（超过 → 序列化走全量快照格式）。
 * 分母是 tiles 总数（width × height）；严格大于才算超。
 */
export function exceedsDeltaThreshold(modificationCount: number, geometry: MapGeometry): boolean {
  const total = geometry.grid.width * geometry.grid.height;
  return modificationCount > total * DELTA_DOWNGRADE_RATIO;
}
