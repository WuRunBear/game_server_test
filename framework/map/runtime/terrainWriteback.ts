/**
 * 地形写回入口（framework/map/runtime/terrainWriteback.ts）。
 *
 * 运行期修改底板的**唯一合法通道**（docs/map-system-v2-design.md §3.2）：
 * 任何代码绕过本入口直接改 MapGeometry 的 tiles/walkable/level 数组视为架构违规。
 * 入口内部依次完成四件事：
 * 1. 原地改数组（tiles / walkable / level 三路；level 经 F-16 的 setLevel 开放）；
 * 2. 重算该图 version 内容指纹（computeGeometryVersion 通道复用，同内容恒定）；
 * 3. 递增该图**地形纪元**——按层碰撞运行时据此失效/重建静态体（模式同
 *    builtStructures 的建造纪元：地形与建造楼板是碰撞静态体的两路独立输入，
 *    各持独立纪元、任一变化即重建，互不混淆）；
 * 4. 脏格登记（供 diff 推送在线客户端）；**推完即清、不落盘**——存档 diff
 *    恒以出厂底板重比为准，与本队列无关。
 *
 * ## 调用纪律：只允许 tick 系统调用（约定 + JSDoc）
 *
 * 选择「约定 + JSDoc」而非调用栈级运行时强校验：tick 系统是普通函数
 * （world → world），架构上不存在可靠的带内信号区分「系统内调用」与「其他
 * 路径调用」；栈解析脆弱且给热路径添乱。入口对 map 存在性、索引范围、值域
 * 做硬校验（错误显式抛出），纪律靠本 JSDoc、import 归属与评审约束。
 *
 * ## callerTick 与离线补差边界
 *
 * 入口接受显式 callerTick（缺省取 world.time.tick），脏格记录携带该值。
 * 当前离线补差只跑演化引擎 + 状态机/族群快进，不重放 tick 系统——补差窗口
 * 内**没有合法的写回来源**，本入口也不参与补差（不重放、不补偿）；将来灾害
 * 切片若实现「离线期间地形改写」的重放，可逐事件显式传入被重放的 tick，
 * 脏格记录据此保留重放语义，本模块无需再改。
 *
 * ## 出厂底板登记
 *
 * registerTerrainBaseline 由 bootMaps 在生成路径调用（含增量回填路径的底板
 * 重算产物）：内存驻留的 tiles/walkable 副本 + 生成时指纹，供序列化做 diff
 * （map/geometry/delta）。登记结果不持久化、不入档；全量快照回填路径不登记
 * （出厂底板未知，该图存档恒走全量格式，见 worldSerializer）。
 */
import { computeGeometryVersion } from "map/geometry/version";
import {
  captureTerrainBaseline,
  computeTileModifications,
  type TerrainBaseline,
  type TileModification,
  type WritableTileField,
} from "map/geometry/delta";
import type { MapGeometry } from "map/geometry/types";
import type { GameWorld } from "framework/world";

// ---------------------------------------------------------------------------
// 出厂底板登记（bootMaps 写、worldSerializer 读；WeakMap 模式同 mapSeeds——
// 开机编排产物挂模块侧弱表，不给 GameWorld 核心结构加字段）
// ---------------------------------------------------------------------------

/** world → 每图出厂底板（key = 地图 registry key）。 */
const baselinesByWorld = new WeakMap<GameWorld, Map<string, TerrainBaseline>>();

/**
 * 登记某图的出厂底板（tiles/walkable 副本 + 当前指纹）。bootMaps 生成路径
 * 专用；重复登记以最后一次为准（增量回填路径在叠加修改前登记重算底板）。
 *
 * 同时清空该图的写回版本历史：新底板代表新的内容基线，旧版本号不再可识别
 * （客户端携带旧版本请求增量时由调用方回退全量）。
 */
export function registerTerrainBaseline(world: GameWorld, mapKey: string, geometry: MapGeometry): void {
  let byMap = baselinesByWorld.get(world);
  if (!byMap) {
    byMap = new Map<string, TerrainBaseline>();
    baselinesByWorld.set(world, byMap);
  }
  byMap.set(mapKey, captureTerrainBaseline(geometry));
  versionHistoryByWorld.get(world)?.delete(mapKey);
}

/** 读某图的出厂底板；未登记（全量回填路径/未开机）返回 undefined。 */
export function terrainBaselineOf(world: GameWorld, mapKey: string): TerrainBaseline | undefined {
  return baselinesByWorld.get(world)?.get(mapKey);
}

/**
 * 读某图的当前内容指纹（实时 `MapGeometry.version`；图不存在返回 undefined）。
 *
 * 只读访问器：供传输层/仿真端口写 `PlayerState.mapVersion`，不触碰写回语义。
 */
export function terrainVersionOf(world: GameWorld, mapKey: string): string | undefined {
  return world.maps[mapKey]?.version;
}

// ---------------------------------------------------------------------------
// 写回版本历史（HTTP 增量识别「基线/历史版本」；不参与存档）
// ---------------------------------------------------------------------------

/**
 * 单条版本历史记录：一次**实际生效**的写回产生了哪个新版本、改了哪格/通道。
 *
 * 只记当前图的 modified 序列；请求 `sinceVersion` 命中某条记录时，把该记录
 * 之后的全部 (tileIndex, field) 去重后映射为**当前数组终值**——天然
 * last-write-wins（与存档 diff 同语义），不需要保存每一版完整数组。
 */
interface TerrainVersionChange {
  /** 写入后重算的内容指纹（新版本）。 */
  version: string;
  /** tile 线性索引。 */
  tileIndex: number;
  /** 被改写的底板字段。 */
  field: WritableTileField;
}

/** 每图版本历史条数上限（超出丢最旧；旧版本号随之变为「无法识别」→ 回退全量）。 */
const VERSION_HISTORY_LIMIT = 4096;

/** world → 每图版本变更历史（key = 地图 registry key）。 */
const versionHistoryByWorld = new WeakMap<GameWorld, Map<string, TerrainVersionChange[]>>();

/** 登记一次实际写回产生的新版本（写回入口内部专用）。 */
function recordVersionChange(
  world: GameWorld,
  mapKey: string,
  version: string,
  tileIndex: number,
  field: WritableTileField,
): void {
  let byMap = versionHistoryByWorld.get(world);
  if (!byMap) {
    byMap = new Map<string, TerrainVersionChange[]>();
    versionHistoryByWorld.set(world, byMap);
  }
  let changes = byMap.get(mapKey);
  if (!changes) {
    changes = [];
    byMap.set(mapKey, changes);
  }
  changes.push({ version, tileIndex, field });
  if (changes.length > VERSION_HISTORY_LIMIT) {
    changes.splice(0, changes.length - VERSION_HISTORY_LIMIT);
  }
}

/**
 * HTTP 增量响应所需的终态修改集（baseVersion = 调用方 `sinceVersion`）。
 */
export interface TerrainModificationSet {
  /** 增量基准版本（调用方提供的、已被识别的版本号）。 */
  baseVersion: string;
  /** 计算修改项时该图的当前版本（用于响应/响应头与终态一致）。 */
  version: string;
  /** 相对该基准的稀疏终态修改项（`tiles`/`walkable`/`level`）。 */
  modifications: TileModification[];
}

/** 字段排序权重（同格多通道时输出顺序固定，便于客户端/测试比对）。 */
const FIELD_ORDER: Record<WritableTileField, number> = {
  tiles: 0,
  walkable: 1,
  level: 2,
};

/**
 * 计算「从某已知版本到当前」的稀疏终态修改项（HTTP `/maps/runtime` 增量）。
 *
 * 识别的版本来源（其余一律返回 undefined，调用方回退全量）：
 * - **出厂基线版本**（`terrainBaselineOf`）：与当前几何逐格 diff；
 * - **本进程内写回产生过的历史版本**：取该版本记录之后被改写的
 *   (tileIndex, field) 去重集合，读取当前数组终值输出。
 *
 * 终态语义：同一格多次写回只输出最后一次的值（不按事件流重放）；版本历史
 * 超出上限后最旧版本不可识别。
 *
 * @param world ECS 世界
 * @param mapKey 地图 registry key
 * @param sinceVersion 客户端持有的已知版本
 * @returns 增量结果；版本不可识别/图不存在/无出厂底板时 undefined
 */
export function terrainModificationsSince(
  world: GameWorld,
  mapKey: string,
  sinceVersion: string,
): TerrainModificationSet | undefined {
  const geometry = world.maps[mapKey];
  if (!geometry) return undefined;
  const baseline = terrainBaselineOf(world, mapKey);
  if (!baseline) return undefined;

  // 出厂基线：与当前数组逐格 diff（最常用的「首次全量后的增量」路径）
  if (sinceVersion === baseline.version) {
    return {
      baseVersion: sinceVersion,
      version: geometry.version,
      modifications: computeTileModifications(geometry, baseline),
    };
  }

  const changes = versionHistoryByWorld.get(world)?.get(mapKey);
  if (!changes || changes.length === 0) return undefined;

  let baseIndex = -1;
  for (let i = changes.length - 1; i >= 0; i -= 1) {
    if (changes[i]!.version === sinceVersion) {
      baseIndex = i;
      break;
    }
  }
  if (baseIndex < 0) return undefined;

  // 该版本之后被改写的 (field, tileIndex) 去重；值取当前数组终态。
  const touched = new Set<string>();
  const modifications: TileModification[] = [];
  for (let i = baseIndex + 1; i < changes.length; i += 1) {
    const change = changes[i]!;
    const key = `${change.field}|${change.tileIndex}`;
    if (touched.has(key)) continue;
    touched.add(key);
    const value =
      change.field === "tiles"
        ? geometry.tiles[change.tileIndex]!
        : change.field === "walkable"
          ? geometry.walkable[change.tileIndex]!
          : geometry.level[change.tileIndex]!;
    modifications.push({ tileIndex: change.tileIndex, field: change.field, value });
  }
  modifications.sort(
    (a, b) => a.tileIndex - b.tileIndex || FIELD_ORDER[a.field] - FIELD_ORDER[b.field],
  );
  return { baseVersion: sinceVersion, version: geometry.version, modifications };
}

// ---------------------------------------------------------------------------
// 地形纪元（碰撞运行时失效信号；模式同 builtStructures 的建造纪元）
// ---------------------------------------------------------------------------

/** world.systemRuntimes 中地形纪元表的键（mapId → 递增计数）。 */
const EPOCH_KEY = "terrainWritebackEpoch";

/** 取某图当前地形纪元（无记录为 0）。 */
export function getTerrainEpoch(world: GameWorld, mapId: string): number {
  const epochs = world.systemRuntimes.get(EPOCH_KEY) as Map<string, number> | undefined;
  return epochs?.get(mapId) ?? 0;
}

/** 地形写回后调用：递增该图地形纪元（按层碰撞静态体下次访问时重建）。 */
function bumpTerrainEpoch(world: GameWorld, mapId: string): void {
  let epochs = world.systemRuntimes.get(EPOCH_KEY) as Map<string, number> | undefined;
  if (!epochs) {
    epochs = new Map<string, number>();
    world.systemRuntimes.set(EPOCH_KEY, epochs);
  }
  epochs.set(mapId, (epochs.get(mapId) ?? 0) + 1);
}

// ---------------------------------------------------------------------------
// 脏格登记（供 diff 推送在线客户端；推完即清，不落盘、不参与存档 diff）
// ---------------------------------------------------------------------------

/** 单条脏格记录：改了哪格、哪个通道、终值，以及写回发生时的调用方 tick。 */
export interface TerrainChangeRecord {
  /** tile 线性索引。 */
  tileIndex: number;
  /** 被改写的底板字段。 */
  field: WritableTileField;
  /** 写回后的终值。 */
  value: number;
  /** 写回发生时的调用方 tick（显式传入或 world.time.tick；重放标注用）。 */
  tick: number;
}

/** world.systemRuntimes 中脏格队列的键（mapId → 追加记录）。 */
const DIRTY_KEY = "terrainWritebackDirty";

/**
 * 排空脏格队列：返回「地图 key → 自上次排空以来的全部写回记录」，并清空
 * 队列（推完即清）。供传输层逐 tick 消费 diff 推送在线客户端；不消费也不
 * 影响正确性（队列只增不减时会常驻内存，消费方应每 tick 排空）。
 */
export function drainDirtyTiles(world: GameWorld): Map<string, TerrainChangeRecord[]> {
  const queue = world.systemRuntimes.get(DIRTY_KEY) as Map<string, TerrainChangeRecord[]> | undefined;
  const drained = new Map<string, TerrainChangeRecord[]>();
  if (!queue) return drained;
  for (const [mapKey, records] of queue) {
    if (records.length > 0) drained.set(mapKey, records);
  }
  world.systemRuntimes.set(DIRTY_KEY, new Map<string, TerrainChangeRecord[]>());
  return drained;
}

/** 追加一条脏格记录（写回入口内部专用）。 */
function pushDirtyTile(world: GameWorld, mapKey: string, record: TerrainChangeRecord): void {
  let queue = world.systemRuntimes.get(DIRTY_KEY) as Map<string, TerrainChangeRecord[]> | undefined;
  if (!queue) {
    queue = new Map<string, TerrainChangeRecord[]>();
    world.systemRuntimes.set(DIRTY_KEY, queue);
  }
  let records = queue.get(mapKey);
  if (!records) {
    records = [];
    queue.set(mapKey, records);
  }
  records.push(record);
}

// ---------------------------------------------------------------------------
// 写回入口（唯一合法通道）
// ---------------------------------------------------------------------------

/** 解析目标图几何；mapId 解析不到已构建图即抛显式错误（不静默回退默认图）。 */
function geometryOf(world: GameWorld, mapKey: string): MapGeometry {
  const geometry = world.maps[mapKey];
  if (!geometry) {
    throw new Error(`terrain writeback: map "${mapKey}" is not present in world.maps`);
  }
  return geometry;
}

/**
 * 写回单格（入口内部共用实现）：硬校验 → 同值短路 → 原地改数组 → 重算
 * version 指纹 → 递增地形纪元 → 脏格登记。
 *
 * @returns 本次调用是否真的改动了内容（同值写回为 false——不动指纹/纪元/脏格）
 */
function writeTile(
  world: GameWorld,
  mapKey: string,
  tileIndex: number,
  field: WritableTileField,
  value: number,
  callerTick: number | undefined,
): boolean {
  const geometry = geometryOf(world, mapKey);
  const total = geometry.grid.width * geometry.grid.height;
  if (!Number.isInteger(tileIndex) || tileIndex < 0 || tileIndex >= total) {
    throw new Error(
      `terrain writeback: tileIndex ${tileIndex} out of range (0..${total - 1}) on map "${mapKey}"`,
    );
  }
  if (field === "tiles" && (!Number.isInteger(value) || value < 0 || value > 255)) {
    throw new Error(`terrain writeback: ground semantic id ${value} out of range (0..255) on map "${mapKey}"`);
  }
  if (field === "walkable" && value !== 0 && value !== 1) {
    throw new Error(`terrain writeback: walkable value must be 0 or 1 (got ${value}) on map "${mapKey}"`);
  }
  if (field === "level" && (!Number.isInteger(value) || value < -128 || value > 127)) {
    throw new Error(
      `terrain writeback: level ${value} out of Int8 range (-128..127) on map "${mapKey}"`,
    );
  }

  const array =
    field === "tiles" ? geometry.tiles : field === "walkable" ? geometry.walkable : geometry.level;
  if (array[tileIndex] === value) {
    return false; // 同值写回：内容无变化，不动指纹/纪元/脏格
  }
  array[tileIndex] = value;

  geometry.version = computeGeometryVersion(geometry);
  bumpTerrainEpoch(world, mapKey);
  // 版本历史只服务 HTTP 增量识别（内存态、不入档）；存档仍以出厂底板 diff 为准。
  recordVersionChange(world, mapKey, geometry.version, tileIndex, field);
  pushDirtyTile(world, mapKey, {
    tileIndex,
    field,
    value,
    tick: callerTick ?? world.time.tick,
  });
  return true;
}

/**
 * 写回某格地面语义 id（设计概念名 setGround）。
 *
 * 调用纪律：只允许 tick 系统调用（见模块 JSDoc）；callerTick 缺省取
 * world.time.tick，显式传入用于将来的补差重放标注。
 *
 * @param world ECS 世界
 * @param mapKey 地图 registry key
 * @param tileIndex tile 线性索引（行主序）
 * @param semanticId 地面语义 id（0-255 整数；id→含义映射在 game 配置）
 * @param callerTick 调用方 tick（缺省 world.time.tick）
 * @returns 是否真的改动了内容
 * @throws Error 地图不存在 / 索引越界 / 值域非法
 */
export function setGround(
  world: GameWorld,
  mapKey: string,
  tileIndex: number,
  semanticId: number,
  callerTick?: number,
): boolean {
  return writeTile(world, mapKey, tileIndex, "tiles", semanticId, callerTick);
}

/**
 * 写回某格通行位（设计概念名 setWalkable）。
 *
 * 调用纪律与 callerTick 语义同 setGround。碰撞侧效果：地形纪元递增后，
 * 按层碰撞运行时在该图下次访问时按新通行位重建静态体（低频事件，非热路径）。
 *
 * @param world ECS 世界
 * @param mapKey 地图 registry key
 * @param tileIndex tile 线性索引（行主序）
 * @param walkable 通行位（0=阻挡 1=可走）
 * @param callerTick 调用方 tick（缺省 world.time.tick）
 * @returns 是否真的改动了内容
 * @throws Error 地图不存在 / 索引越界 / 值域非法
 */
export function setWalkable(
  world: GameWorld,
  mapKey: string,
  tileIndex: number,
  walkable: 0 | 1,
  callerTick?: number,
): boolean {
  return writeTile(world, mapKey, tileIndex, "walkable", walkable, callerTick);
}

/**
 * 写回某格离散层号（设计概念名 setLevel；F-16 补齐）。
 *
 * 调用纪律与 callerTick 语义同 setGround。层号写回的影响面：
 * - **碰撞**：地形纪元递增 → 按层碰撞静态体在该图下次访问时按新层号重建
 *   （cliff/slope 语义仍以 geometry.levelSemantics 为准，本入口不推断语义）；
 * - **实体层号**：entityLevelSystem 下一 tick 读新地形层，按既有过渡规则
 *   （slope/连接器/cliff 单向）决定是否跟随——本入口不改实体层号；
 * - **持久化**：随增量存档写入 `field:"level"` 修改项（Int8 值域）。
 * - **结构一致性由调用方负责**：层号改动若形成可通行区 ≥2 层差且无 cliff
 *   语义格，读档时的 validateMapGeometry 会拒绝该图（与生成期同一约束）。
 *   需要大幅改层的调用方应同时写回 tiles/walkable（cliff 带）。
 *
 * @param world ECS 世界
 * @param mapKey 地图 registry key
 * @param tileIndex tile 线性索引（行主序）
 * @param level 新层号（Int8，-128..127 整数；负层为地下预留）
 * @param callerTick 调用方 tick（缺省 world.time.tick）
 * @returns 是否真的改动了内容
 * @throws Error 地图不存在 / 索引越界 / 值域非法
 */
export function setLevel(
  world: GameWorld,
  mapKey: string,
  tileIndex: number,
  level: number,
  callerTick?: number,
): boolean {
  return writeTile(world, mapKey, tileIndex, "level", level, callerTick);
}
