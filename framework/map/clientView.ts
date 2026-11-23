/**
 * 客户端地图视图通道（framework/map/clientView.ts，CC-05）。
 *
 * 本模块只做**服务端只读派生视图**，不推翻 MapGeometry 模型、不写回任何底板：
 * - `/maps/render`：当前 tick 的**有效地面**（相位/天气派生，查询期计算）；
 * - `/maps/collision`：某层视角下的静态通行位 + 建造物占用（实体用 networkId）；
 * - `/world/map-graph`：地图 registry + presentation 的地图连接图；
 * - netSync 派生键 `Space.exposure`：玩家所在格室内/露天（spaceExposureAt）。
 *
 * 设计约束：
 * - 纯函数/只读查询：不修改 world/geometry/实体，不推进 tick；
 * - 不复制玩法规则：通行判定走 `walkableAtLevel`，建造索引走
 *   `collectBuiltStructures`，室内判定走 `spaceExposureAt`，有效地面走
 *   `effectiveGroundAt`/`deriveEffectiveGround`；
 * - 对外字段绝不出现 eid（建造物占用用 networkId；无 NetworkId 的实体跳过）。
 *
 * 帧内缓存：
 * - `/maps/render` 的 tiles 按 (地图, baseVersion, phaseId, 量化进度) 缓存，
 *   基准版本/相位/进度任一变化即失效；缓存只在单个 world 内复用（WeakMap）；
 * - `Space.exposure` 的调用方按 tick 传一个格缓存 map（同 tick 同一格只算一次）。
 */
import { hasComponent, query } from "bitecs";

import { Transform } from "framework/components/transform";
import { entityMapOf } from "framework/components/entityMap";
import { entityLevelOf } from "framework/components/entityLevel";
import { NetworkId } from "framework/components/network";
import { Kind } from "framework/components/kind";
import { Placeable } from "framework/components/placeable";
import { Collider } from "framework/components/physics";
import { GridOccupancy } from "framework/components/gridOccupancy";
import { isPassageOpen } from "framework/components/passage";
import {
  Structure,
  STRUCTURE_ROLE_FLOOR,
  STRUCTURE_ROLE_WALL,
  STRUCTURE_ROLE_CONNECTOR,
  STRUCTURE_ROLE_NONE,
} from "framework/components/structure";
import { getMapPresentation } from "framework/content/presentation";
import type { LoadedGameDefinition } from "framework/config/schema/GameDefinitionSchema";
import type { EnvironmentRule } from "framework/config/schema/RuleSchema";
import type { BuiltStructuresIndex } from "framework/map/runtime/builtStructures";
import { collectBuiltStructures } from "framework/map/runtime/builtStructures";
import { spaceExposureAt, type SpaceExposure } from "framework/map/runtime/indoors";
import { levelAt, regionOf, tileAt, walkableAtLevel } from "framework/map/geometry/query";
import type { MapGeometry } from "framework/map/geometry/types";
import type { GameWorld } from "framework/world";
import {
  deriveEffectiveGround,
  effectiveGroundAt,
  getEnvironmentRule,
  phaseAt,
} from "framework/simulation/worldClock";

// ---------------------------------------------------------------------------
// /maps/render：有效地面视图
// ---------------------------------------------------------------------------

/** 有效地面进度量化步数（1/1000）：缓存键与 renderVersion 共用同一量化值。 */
export const RENDER_PROGRESS_STEPS = 1000;

/**
 * `/maps/render` 响应形状（服务端契约）。
 *
 * `tiles` 是 row-major 的**有效地面语义 id**（`effectiveGroundAt` 查询期派生，
 * 绝不写回 `MapGeometry.tiles`）；`baseVersion` 是底板内容指纹，`renderVersion`
 * 是（底板 + 相位 + 量化进度 + 有效 tiles）的稳定哈希，客户端按此缓存。
 */
export interface MapRenderView {
  /** 地图 key。 */
  key: string;
  /** 底板内容指纹（MapGeometry.version）。 */
  baseVersion: string;
  /** 有效地面视图稳定哈希（8 位小写十六进制）。 */
  renderVersion: string;
  /** 当前相位 id（无 environment 规则时为空串）。 */
  phaseId: string;
  /** 相位内进度（已量化到 1/1000，与 renderVersion 的输入一致）。 */
  phaseProgress: number;
  /** 有效地面语义 id（row-major，长度 = width × height）。 */
  tiles: number[];
}

/** 进度量化（向下取整到 1/RENDER_PROGRESS_STEPS，避免 1.0 越界）。 */
export function quantizePhaseProgress(progress: number): number {
  if (!Number.isFinite(progress) || progress <= 0) return 0;
  if (progress >= 1) return 1;
  return Math.floor(progress * RENDER_PROGRESS_STEPS) / RENDER_PROGRESS_STEPS;
}

/** FNV-1a 32 位哈希：单字节。 */
function hashByte(hash: number, byte: number): number {
  hash ^= byte & 0xff;
  return Math.imul(hash, 0x01000193);
}

/** FNV-1a 32 位哈希：字符串（逐 UTF-16 低字节；仅用于固定 ASCII 元信息 + id）。 */
function hashText(hash: number, text: string): number {
  for (let i = 0; i < text.length; i += 1) {
    hash = hashByte(hash, text.charCodeAt(i));
  }
  return hash;
}

/**
 * 计算有效地面视图版本（稳定哈希）。
 *
 * 输入固定为 baseVersion / phaseId / 量化进度 / tiles；同输入恒同输出，
 * 任一变化即变化。返回 8 位小写十六进制（与地图内容指纹同形）。
 */
export function computeMapRenderVersion(
  baseVersion: string,
  phaseId: string,
  phaseProgress: number,
  tiles: readonly number[],
): string {
  let hash = 0x811c9dc5;
  hash = hashText(hash, baseVersion);
  hash = hashByte(hash, 0x7c); // '|'
  hash = hashText(hash, phaseId);
  hash = hashByte(hash, 0x7c);
  hash = hashText(hash, quantizePhaseProgress(phaseProgress).toFixed(3));
  hash = hashByte(hash, 0x7c);
  for (let i = 0; i < tiles.length; i += 1) {
    hash = hashByte(hash, tiles[i]!);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

/** 单图有效地面缓存条目（每个 world/地图只保留最近一个量化进度桶）。 */
interface RenderCacheEntry {
  cacheKey: string;
  view: MapRenderView;
}

/** world → (mapId → 最近一次有效地面视图)。 */
const renderViewCache = new WeakMap<GameWorld, Map<string, RenderCacheEntry>>();

/** 取/建某 world 的有效地面缓存表。 */
function renderCacheOf(world: GameWorld): Map<string, RenderCacheEntry> {
  let cache = renderViewCache.get(world);
  if (!cache) {
    cache = new Map();
    renderViewCache.set(world, cache);
  }
  return cache;
}

/**
 * 构建某图当前 tick 的有效地面视图（服务端 `/maps/render` 数据源）。
 *
 * @param world ECS 世界
 * @param mapId 地图 key
 * @returns 视图；该图不在 world.maps 中时 undefined
 */
export function buildMapRenderView(world: GameWorld, mapId: string): MapRenderView | undefined {
  const geometry = world.maps[mapId];
  if (!geometry) return undefined;

  const rule = getEnvironmentRule(world);
  const phase = rule
    ? phaseAt(world.time.tick, rule)
    : { phaseId: "", progress: 0 };
  const phaseProgress = quantizePhaseProgress(phase.progress);
  const cacheKey = `${geometry.version}|${phase.phaseId}|${phaseProgress.toFixed(3)}`;
  const cache = renderCacheOf(world);
  const cached = cache.get(mapId);
  if (cached && cached.cacheKey === cacheKey) return cached.view;

  const { width, height } = geometry.grid;
  const tiles = new Array<number>(width * height);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      tiles[y * width + x] = effectiveGroundAt(world, x, y, mapId);
    }
  }

  const view: MapRenderView = {
    key: geometry.key,
    baseVersion: geometry.version,
    renderVersion: computeMapRenderVersion(geometry.version, phase.phaseId, phaseProgress, tiles),
    phaseId: phase.phaseId,
    phaseProgress,
    tiles,
  };
  cache.set(mapId, { cacheKey, view });
  return view;
}

/**
 * 无活动房间时的回退：按配置重建的几何 + environment 规则直接派生有效地面
 * （tick 取 0，与「没有 live 世界」的回退语义一致）。
 *
 * 与 live 路径共用 `deriveEffectiveGround`（worldClock），不复制覆盖规则。
 */
export function buildMapRenderViewForGeometry(
  geometry: MapGeometry,
  rule: EnvironmentRule | undefined,
  tick: number,
): MapRenderView {
  const phase = rule ? phaseAt(tick, rule) : { phaseId: "", progress: 0 };
  const phaseProgress = quantizePhaseProgress(phase.progress);
  const { width, height } = geometry.grid;
  const tiles = new Array<number>(width * height);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      tiles[y * width + x] = deriveEffectiveGround(rule, tick, {
        x,
        y,
        baseSemantic: tileAt(geometry, x, y),
        level: levelAt(geometry, x, y),
        region: regionOf(geometry, x, y),
      }).semantic;
    }
  }
  return {
    key: geometry.key,
    baseVersion: geometry.version,
    renderVersion: computeMapRenderVersion(geometry.version, phase.phaseId, phaseProgress, tiles),
    phaseId: phase.phaseId,
    phaseProgress,
    tiles,
  };
}

// ---------------------------------------------------------------------------
// /maps/collision：静态通行位 + 建造物占用
// ---------------------------------------------------------------------------

/** 建造物占用条目（服务端契约；实体引用一律 networkId）。 */
export interface MapCollisionOccupant {
  /** 实体稳定网络标识（NetworkId.value；绝不输出 eid）。 */
  networkId: number;
  /** 实体 kind（Kind.value；缺失时回退结构角色名）。 */
  kind: string;
  /** 该实体占用的 tile 线性索引（row-major；含多格占位时的全部格）。 */
  cells: number[];
  /** 实体所在离散层号（EntityLevel）。 */
  level: number;
  /** 结构角色（floor/wall/connector；非 Structure 的碰撞放置物为 wall）。 */
  role: "floor" | "wall" | "connector";
}

/** `/maps/collision` 响应形状（服务端契约）。 */
export interface MapCollisionView {
  /** 地图 key。 */
  key: string;
  /** 底板内容指纹（MapGeometry.version）。 */
  version: string;
  /** 查询视角的层号。 */
  level: number;
  /** 网格信息（客户端按 row-major 展开 walkable）。 */
  grid: { width: number; height: number; tileWidth: number; tileHeight: number };
  /** 该层视角的通行位（1=可通行，0=阻挡；含建造楼板让不可走格可站）。 */
  walkable: number[];
  /** 该层的建造物占用（墙/楼板/连接器/参与碰撞的放置物）。 */
  occupants: MapCollisionOccupant[];
}

/** 结构角色数字 → 对外角色名（与 Structure 组件常量一致）。 */
function structureRoleName(role: number): "floor" | "wall" | "connector" {
  if (role === STRUCTURE_ROLE_FLOOR) return "floor";
  if (role === STRUCTURE_ROLE_CONNECTOR) return "connector";
  return "wall";
}

/**
 * 单实体占用的 tile 线性索引列表。
 *
 * 优先使用 GridOccupancy 的格组（放置链写入的权威占用矩形）；未写格组
 * （如地图静态布置的建造物 cellW/cellH=0）回退到 Transform 所在中心格。
 * 越界格不输出。
 */
function occupantCellsOf(world: GameWorld, eid: number, geometry: MapGeometry): number[] {
  const { width, height, tileWidth, tileHeight } = geometry.grid;
  const cellW = GridOccupancy.cellW[eid] ?? 0;
  const cellH = GridOccupancy.cellH[eid] ?? 0;
  const cells: number[] = [];
  if (Number.isInteger(cellW) && Number.isInteger(cellH) && cellW > 0 && cellH > 0) {
    const cellX = GridOccupancy.cellX[eid] ?? 0;
    const cellY = GridOccupancy.cellY[eid] ?? 0;
    for (let y = cellY; y < cellY + cellH; y += 1) {
      if (y < 0 || y >= height) continue;
      for (let x = cellX; x < cellX + cellW; x += 1) {
        if (x < 0 || x >= width) continue;
        cells.push(y * width + x);
      }
    }
    return cells;
  }

  const tx = Math.floor(Transform.x[eid] / tileWidth);
  const ty = Math.floor(Transform.y[eid] / tileHeight);
  if (tx < 0 || ty < 0 || tx >= width || ty >= height) return cells;
  cells.push(ty * width + tx);
  return cells;
}

/**
 * 收集某图某层的建造物占用（与 `collectBuiltStructures` 的过滤口径一致）。
 *
 * 数据源：
 * - Structure 实体 role ≠ none（floor/wall/connector），且通行口未打开；
 * - 非 Structure 的 Placeable + Collider 且 canCollide=1（如设施/障碍物），
 *   与建造索引把其投影为墙位的规则相同。
 *
 * 仅返回 `entityLevelOf(eid) === level` 的实体（与查询层的通行视角一致）；
 * 无 NetworkId 的实体不暴露（客户端只认 networkId）。
 */
function collectOccupants(
  world: GameWorld,
  mapId: string,
  level: number,
  geometry: MapGeometry,
): MapCollisionOccupant[] {
  const occupants: MapCollisionOccupant[] = [];

  const add = (eid: number, role: "floor" | "wall" | "connector"): void => {
    if (entityMapOf(world, eid) !== mapId) return;
    if (entityLevelOf(eid) !== level) return;
    if (isPassageOpen(world, eid)) return;
    if (!hasComponent(world, eid, NetworkId)) return;
    const cells = occupantCellsOf(world, eid, geometry);
    if (cells.length === 0) return;
    occupants.push({
      networkId: NetworkId.value[eid],
      kind: Kind[eid] || role,
      cells,
      level,
      role,
    });
  };

  for (const eid of query(world, [Structure])) {
    const role = Structure.role[eid] ?? STRUCTURE_ROLE_NONE;
    if (role === STRUCTURE_ROLE_NONE) continue;
    add(eid, structureRoleName(role));
  }

  // 与 collectBuiltStructures 一致：不重复投影「已有 Structure 角色」的实体；
  // 无 Structure 或角色 none 的碰撞放置物按墙位输出。
  for (const eid of query(world, [Placeable, Collider])) {
    if ((Placeable.canCollide[eid] ?? 0) !== 1) continue;
    if (hasComponent(world, eid, Structure)) {
      const role = Structure.role[eid] ?? STRUCTURE_ROLE_NONE;
      if (role !== STRUCTURE_ROLE_NONE) continue;
    }
    add(eid, "wall");
  }

  occupants.sort((a, b) => a.networkId - b.networkId);
  return occupants;
}

/**
 * 从几何 + 可选建造索引构建碰撞视图（无 world 时的回退路径，occupants 恒空）。
 *
 * @param geometry 地图几何
 * @param level 查询层号
 * @param built 建造索引（可选；缺省仅地形判定）
 */
export function buildMapCollisionViewFromGeometry(
  geometry: MapGeometry,
  level: number,
  built?: BuiltStructuresIndex,
): MapCollisionView {
  const { width, height } = geometry.grid;
  const walkable = new Array<number>(width * height);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      walkable[y * width + x] = walkableAtLevel(geometry, x, y, level, built) ? 1 : 0;
    }
  }
  return {
    key: geometry.key,
    version: geometry.version,
    level,
    grid: { ...geometry.grid },
    walkable,
    occupants: [],
  };
}

/**
 * 构建某图某层的正式碰撞视图（`/maps/collision` 数据源）。
 *
 * @param world ECS 世界
 * @param mapId 地图 key
 * @param level 查询层号
 * @returns 视图；该图不在 world.maps 中时 undefined
 */
export function buildMapCollisionView(
  world: GameWorld,
  mapId: string,
  level: number,
): MapCollisionView | undefined {
  const geometry = world.maps[mapId];
  if (!geometry) return undefined;
  const built = collectBuiltStructures(world, mapId);
  const view = buildMapCollisionViewFromGeometry(geometry, level, built);
  return { ...view, occupants: collectOccupants(world, mapId, level, geometry) };
}

// ---------------------------------------------------------------------------
// 室内/露天派生键（netSync：Space.exposure）
// ---------------------------------------------------------------------------

/**
 * netSync 派生键：室内/露天（`"indoor" | "outdoor"`）。
 *
 * 走 `EntityState.stringValues` 动态键，不扩大 EntityState schema；旧客户端
 * 忽略未知键即可。game.json 末尾的 `Kind`+`exposure` 条目触发本投影。
 */
export const SPACE_EXPOSURE_SYNC_KEY = "Space.exposure";

/** 同一 tick 内「地图|格|层」→ 室内/露天 的缓存表（调用方按 tick 新建）。 */
export type SpaceExposureCellCache = Map<string, SpaceExposure>;

/**
 * 按实体位置查询室内/露天，带同 tick 同格缓存。
 *
 * 复用 `spaceExposureAt`（墙围合 + 头顶楼板），不复制房间检测规则；缓存键
 * 包含地图/格/层，避免同 tick 内多个玩家/实体同格重复洪泛。
 *
 * @param world ECS 世界
 * @param eid 实体 id（须有 Transform/EntityMap；缺失位置时按 outdoor）
 * @param cache 可选的同 tick 格缓存
 */
export function spaceExposureOfEntity(
  world: GameWorld,
  eid: number,
  cache?: SpaceExposureCellCache,
): SpaceExposure {
  const mapId = entityMapOf(world, eid);
  const geometry = world.maps[mapId];
  if (!geometry) return "outdoor";
  const { tileWidth, tileHeight } = geometry.grid;
  const x = Math.floor(Transform.x[eid] / tileWidth);
  const y = Math.floor(Transform.y[eid] / tileHeight);
  const level = entityLevelOf(eid);
  const key = `${mapId}|${x}|${y}|${level}`;
  const cached = cache?.get(key);
  if (cached !== undefined) return cached;
  const exposure = spaceExposureAt(world, mapId, x, y, level);
  cache?.set(key, exposure);
  return exposure;
}

// ---------------------------------------------------------------------------
// /world/map-graph：地图连接图（presentation 优先，registry 兜底）
// ---------------------------------------------------------------------------

/** 地图连接条目（坐标是 tile 坐标；配置不确定时省略）。 */
export interface WorldMapConnection {
  /** 目标地图 key。 */
  to: string;
  /** 连接类型（不透明字符串，如 "portal"）。 */
  kind: string;
  /** 入口 tile x 坐标（可选）。 */
  x?: number;
  /** 入口 tile y 坐标（可选）。 */
  y?: number;
}

/** 单图图节点。 */
export interface WorldMapNode {
  /** 地图 registry key。 */
  id: string;
  /** 展示名（无 presentation 时回退 key）。 */
  displayName: string;
  /** 地图连接（无 presentation 时为空数组）。 */
  connections: WorldMapConnection[];
}

/** `/world/map-graph` 响应形状。 */
export interface WorldMapGraph {
  maps: WorldMapNode[];
}

/**
 * 构建世界地图图（`/world/map-graph` 数据源）。
 *
 * 地图集合来自 registry（`resolvedMapConfigs` 声明序）；展示名与连接来自
 * `game/presentation/maps.json` 的查询层（`getMapPresentation`）。无
 * presentation 时至少返回 registry 的图 id（displayName=id、connections=[]）。
 */
export function buildWorldMapGraph(gameDef: LoadedGameDefinition): WorldMapGraph {
  const maps = (gameDef.resolvedMapConfigs ?? []).map((config): WorldMapNode => {
    const presentation = getMapPresentation(config.key);
    const connections = (presentation?.connections ?? []).map(
      (connection): WorldMapConnection => ({
        to: connection.to,
        kind: connection.kind,
        ...(connection.x !== undefined ? { x: connection.x } : {}),
        ...(connection.y !== undefined ? { y: connection.y } : {}),
      }),
    );
    return {
      id: config.key,
      displayName: presentation?.displayName ?? config.key,
      connections,
    };
  });
  return { maps };
}
