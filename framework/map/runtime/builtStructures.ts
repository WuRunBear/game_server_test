/**
 * 建造层索引（framework/map/runtime/builtStructures.ts）。
 *
 * v2 地图切片 6、前置修正 3：建造实体（楼板/墙/连接器）散落在 ECS 中，而
 * 地理查询（walkableAtLevel）、碰撞静态体、跨层转移、房间检测都需要按
 * 「图 × 层 × tile」提问。本模块把 Structure 实体一次性投影为纯数据索引，
 * 供各消费方按需构建（放置/演化/投射物按调用构建，碰撞按运行时构建 +
 * epoch 失效重建）。
 *
 * 索引内容（按图）：
 * - floors：level → 楼板覆盖 tile 线性索引集（可站面；其下一格「有顶」）；
 * - walls：level → 墙覆盖 tile 线性索引集（挡视线/围合边；通行阻挡由
 *   Collider 实体承担，不在此重复）；
 * - connectors：tile 线性索引 → 连接器声明（连接哪两层 + 方向）——跨层
 *   转移判定的实体侧连接器（楼梯实体把「连接器格」扩展到实体侧）。
 *
 * 确定性：同一 ECS 状态恒投影出同一索引（query 顺序 = eid 序，仅影响同格
 * 多连接器时的取者，取首个、结果确定）。同格第二个连接器不会被静默丢弃：
 * 首次投影到该冲突时记一次 warn（F-25，含保留/丢弃的 eid 与方向），语义仍
 * 是「保留首个」——双向楼梯配置为两个不同 tile 的连接器（见 entityLevelSystem）。
 */
import { hasComponent, query } from "bitecs";

import { Transform } from "framework/components/transform";
import { entityMapOf } from "framework/components/entityMap";
import { entityLevelOf } from "framework/components/entityLevel";
import { Placeable } from "framework/components/placeable";
import { Collider } from "framework/components/physics";
import { isPassageOpen } from "framework/components/passage";
import {
  Structure,
  STRUCTURE_ROLE_NONE,
  STRUCTURE_ROLE_FLOOR,
  STRUCTURE_ROLE_WALL,
  STRUCTURE_ROLE_CONNECTOR,
  CONNECTOR_DIR_UP,
} from "framework/components/structure";
import { walkableAtLevel } from "map/geometry/query";
import type { MapGeometry } from "map/geometry/types";
import type { GameWorld } from "framework/world";

/** 连接器声明（实体侧跨层连接器：连接哪两层 + 方向）。 */
export interface StructureConnector {
  /** 连接的低层号。 */
  low: number;
  /** 连接的高层号（= low + 1，v1 连接器只服务相邻层）。 */
  high: number;
  /** 方向：0=上行（low→high） 1=下行（high→low）。 */
  dir: number;
  /** 连接器实体 eid（stranded 校验排除自身用）。 */
  eid: number;
}

/** 单图建造层索引（纯数据，按需重建）。 */
export interface BuiltStructuresIndex {
  /** level → 楼板覆盖 tile 线性索引集（可站面）。 */
  floors: Map<number, Set<number>>;
  /** level → 墙覆盖 tile 线性索引集（围合边/视线阻挡集）。 */
  walls: Map<number, Set<number>>;
  /** tile 线性索引 → 连接器声明（同格多连接器取 eid 序首个）。 */
  connectors: Map<number, StructureConnector>;
}

/** 空索引（无建造实体的图的自然形态）。 */
export function emptyBuiltStructuresIndex(): BuiltStructuresIndex {
  return { floors: new Map(), walls: new Map(), connectors: new Map() };
}

/**
 * 同格连接器冲突告警去重键（map|tile|保留 eid|丢弃 eid）。模块级集合：同一
 * 冲突每进程只告警一次（投影每 tick/每调用都会重建，不能每次都刷日志）。
 */
const warnedConnectorConflicts = new Set<string>();

/**
 * 把单个建造实体投影进索引（floors / walls / connectors）。
 *
 * 建造实体的层号 = 放置/生成时显式写入的 EntityLevel（entityLevelSystem
 * 对 Structure 实体跳过推导）；无条目回退 0（配置/放置链漏写的兜底）。
 * 同格多连接器取首个（query 顺序 = eid 序，结果确定）；后续同格连接器被
 * 丢弃时第一次告警（F-25），不再静默。
 */
function projectStructure(
  world: GameWorld,
  mapId: string,
  index: BuiltStructuresIndex,
  role: number,
  level: number,
  tileIndex: number,
  connectLow: number,
  connectHigh: number,
  connectDir: number,
  eid: number,
): void {
  if (role === STRUCTURE_ROLE_FLOOR) {
    let byLevel = index.floors.get(level);
    if (!byLevel) {
      byLevel = new Set<number>();
      index.floors.set(level, byLevel);
    }
    byLevel.add(tileIndex);
  } else if (role === STRUCTURE_ROLE_WALL) {
    let byLevel = index.walls.get(level);
    if (!byLevel) {
      byLevel = new Set<number>();
      index.walls.set(level, byLevel);
    }
    byLevel.add(tileIndex);
  } else if (role === STRUCTURE_ROLE_CONNECTOR) {
    const existing = index.connectors.get(tileIndex);
    if (!existing) {
      index.connectors.set(tileIndex, {
        low: connectLow,
        high: connectHigh,
        dir: connectDir,
        eid,
      });
      return;
    }
    // 同格多连接器：保留首个（eid 序确定），首次冲突告警一次
    const warnedKey = `${mapId}|${tileIndex}|${existing.eid}|${eid}`;
    if (existing.eid !== eid && !warnedConnectorConflicts.has(warnedKey)) {
      warnedConnectorConflicts.add(warnedKey);
      world.logger.warn("同格存在多个连接器；保留 eid 序首个（其余不参与跨层转移）", {
        mapId,
        tileIndex,
        keptEid: existing.eid,
        kept: { low: existing.low, high: existing.high, dir: existing.dir },
        droppedEid: eid,
        dropped: { low: connectLow, high: connectHigh, dir: connectDir },
      });
    }
  }
}

/**
 * 投影某图的建造实体为索引。
 *
 * @param world ECS 世界
 * @param mapId 地图 key（空串返回空索引——无图配置世界无建造层）
 */
export function collectBuiltStructures(world: GameWorld, mapId: string): BuiltStructuresIndex {
  const index = emptyBuiltStructuresIndex();
  if (mapId === "") return index;
  const geometry = world.maps[mapId];
  if (!geometry) return index;
  const { width, height, tileWidth, tileHeight } = geometry.grid;

  for (const eid of query(world, [Structure])) {
    if (entityMapOf(world, eid) !== mapId) continue;
    // 打开的通行口不进入建造阻挡索引（碰撞/寻路/视线一致放行）
    if (isPassageOpen(world, eid)) continue;
    const role = Structure.role[eid] ?? STRUCTURE_ROLE_NONE;
    if (role === STRUCTURE_ROLE_NONE) continue;
    const level = entityLevelOf(eid);
    const tx = Math.floor(Transform.x[eid] / tileWidth);
    const ty = Math.floor(Transform.y[eid] / tileHeight);
    if (tx < 0 || ty < 0 || tx >= width || ty >= height) continue;
    projectStructure(
      world,
      mapId,
      index,
      role,
      level,
      ty * width + tx,
      Structure.connectLow[eid] ?? 0,
      Structure.connectHigh[eid] ?? 0,
      Structure.connectDir[eid] ?? CONNECTOR_DIR_UP,
      eid,
    );
  }

  // 有 Collider 且参与碰撞的放置物（未声明 Structure 角色，如设施/障碍物）也是
  // 寻路/视线的实体侧障碍：投影为墙位。数据源与 Structure 墙相同（同索引、
  // 同 walkableAtLevel 消费方），不另造索引；打开的通行口同样跳过。
  for (const eid of query(world, [Placeable, Collider])) {
    if (entityMapOf(world, eid) !== mapId) continue;
    if (hasComponent(world, eid, Structure)) {
      const role = Structure.role[eid] ?? STRUCTURE_ROLE_NONE;
      if (role !== STRUCTURE_ROLE_NONE) continue;
    }
    if ((Placeable.canCollide[eid] ?? 0) !== 1) continue;
    if (isPassageOpen(world, eid)) continue;
    const level = entityLevelOf(eid);
    const tx = Math.floor(Transform.x[eid] / tileWidth);
    const ty = Math.floor(Transform.y[eid] / tileHeight);
    if (tx < 0 || ty < 0 || tx >= width || ty >= height) continue;
    projectStructure(
      world,
      mapId,
      index,
      STRUCTURE_ROLE_WALL,
      level,
      ty * width + tx,
      0,
      0,
      CONNECTOR_DIR_UP,
      eid,
    );
  }

  return index;
}

/**
 * 一次全扫把所有图的建造实体投影为按图索引（mapId → BuiltStructuresIndex）。
 *
 * 供每 tick 需要同时读取**楼板**（层号支撑）与**连接器**（跨层转移）的系统
 * 使用（entityLevelSystem）：单次 Structure 查询同时喂两条判定，避免逐图
 * 重复扫描。数据源与 walkableAtLevel 的 `built` 参数完全相同（同一投影
 * 函数），不另造索引。无建造实体的图不出现在结果中（调用方按 undefined
 * 视作空索引）。
 */
export function collectBuiltStructuresByMap(world: GameWorld): Map<string, BuiltStructuresIndex> {
  const byMap = new Map<string, BuiltStructuresIndex>();
  for (const eid of query(world, [Structure])) {
    if (isPassageOpen(world, eid)) continue;
    const role = Structure.role[eid] ?? STRUCTURE_ROLE_NONE;
    if (role === STRUCTURE_ROLE_NONE) continue;
    const mapId = entityMapOf(world, eid);
    if (mapId === "") continue;
    const geometry = world.maps[mapId];
    if (!geometry) continue;
    const { width, height, tileWidth, tileHeight } = geometry.grid;
    const tx = Math.floor(Transform.x[eid] / tileWidth);
    const ty = Math.floor(Transform.y[eid] / tileHeight);
    if (tx < 0 || ty < 0 || tx >= width || ty >= height) continue;

    let index = byMap.get(mapId);
    if (!index) {
      index = emptyBuiltStructuresIndex();
      byMap.set(mapId, index);
    }
    projectStructure(
      world,
      mapId,
      index,
      role,
      entityLevelOf(eid),
      ty * width + tx,
      Structure.connectLow[eid] ?? 0,
      Structure.connectHigh[eid] ?? 0,
      Structure.connectDir[eid] ?? CONNECTOR_DIR_UP,
      eid,
    );
  }

  // 非 Structure 的碰撞放置物（见 collectBuiltStructures 注释）同样投影为墙位。
  for (const eid of query(world, [Placeable, Collider])) {
    if (hasComponent(world, eid, Structure)) {
      const role = Structure.role[eid] ?? STRUCTURE_ROLE_NONE;
      if (role !== STRUCTURE_ROLE_NONE) continue;
    }
    if ((Placeable.canCollide[eid] ?? 0) !== 1) continue;
    if (isPassageOpen(world, eid)) continue;
    const mapId = entityMapOf(world, eid);
    if (mapId === "") continue;
    const geometry = world.maps[mapId];
    if (!geometry) continue;
    const { width, height, tileWidth, tileHeight } = geometry.grid;
    const tx = Math.floor(Transform.x[eid] / tileWidth);
    const ty = Math.floor(Transform.y[eid] / tileHeight);
    if (tx < 0 || ty < 0 || tx >= width || ty >= height) continue;

    let index = byMap.get(mapId);
    if (!index) {
      index = emptyBuiltStructuresIndex();
      byMap.set(mapId, index);
    }
    projectStructure(
      world,
      mapId,
      index,
      STRUCTURE_ROLE_WALL,
      entityLevelOf(eid),
      ty * width + tx,
      0,
      0,
      CONNECTOR_DIR_UP,
      eid,
    );
  }
  return byMap;
}

/**
 * 跨层转移判定的连接器查找表：mapId → (tile 线性索引 → 连接器声明)。
 *
 * 供每 tick 只需连接器的消费方使用（entityLevelSystem 现改用
 * collectBuiltStructuresByMap 同时取楼板与连接器）；resolveEntityLevel 经
 * 回调按有效格索引查询，保持 (位置, 地图数据, 查找表) 的纯函数形态。
 */
export function collectConnectorLookup(world: GameWorld): Map<string, Map<number, StructureConnector>> {
  const byMap = new Map<string, Map<number, StructureConnector>>();
  for (const [mapId, index] of collectBuiltStructuresByMap(world)) {
    if (index.connectors.size > 0) byMap.set(mapId, index.connectors);
  }
  return byMap;
}

// ---------------------------------------------------------------------------
// 建造纪元（epoch）：楼板增删使按层碰撞静态体失效的轻量信号
// ---------------------------------------------------------------------------

/** world.systemRuntimes 中 epoch 表的键（mapId → 递增计数）。 */
const EPOCH_KEY = "builtStructuresEpoch";

/**
 * 取某图当前建造纪元（无记录为 0）。楼板实体增删时递增——按层碰撞的静态体
 * 由 walkableAtLevel(…, built) 派生，楼板变化即需重建（墙/连接器走实体碰撞
 * 体或转移判定，不产生静态体，不递增）。
 */
export function getBuiltStructuresEpoch(world: GameWorld, mapId: string): number {
  const epochs = world.systemRuntimes.get(EPOCH_KEY) as Map<string, number> | undefined;
  return epochs?.get(mapId) ?? 0;
}

/** 楼板实体增删后调用：递增该图建造纪元（碰撞静态体下次访问时重建）。 */
export function bumpBuiltStructuresEpoch(world: GameWorld, mapId: string): void {
  if (mapId === "") return;
  let epochs = world.systemRuntimes.get(EPOCH_KEY) as Map<string, number> | undefined;
  if (!epochs) {
    epochs = new Map<string, number>();
    world.systemRuntimes.set(EPOCH_KEY, epochs);
  }
  epochs.set(mapId, (epochs.get(mapId) ?? 0) + 1);
}

// ---------------------------------------------------------------------------
// 同层洪泛（stranded 校验 / 房间检测共用的可达性基元）
// ---------------------------------------------------------------------------

/** 同层洪泛选项。 */
export interface FloodSameLevelOptions {
  /**
   * 访问格数上限（达到即提前终止）。可达性判定（stranded）不设限时会扫全
   * 图；房间检测用小上限把「围合」判定变成 O(min(面积, 上限))。
   */
  maxVisited?: number;
}

/**
 * 同层洪泛：从 (startX, startY) 出发 4-邻接扩散，返回访问过的 tile 线性索引集。
 *
 * 可走格 = walkableAtLevel（地形 OR 楼板建造）∪ 起点格本身；阻挡 = 墙建造
 * 实体（同层围合边）+ 图边界。cliff 单向语义在洪泛中按其层号视角自然成立
 * （walkableAtLevel 的既有判定）。起点恒在结果内（无论其本身是否可走）。
 * 结果规模 ≤ maxVisited（达到即提前终止——「豁通远方」的判定信号：洪泛
 * 触顶说明区域未在有限格数内封闭）。
 *
 * 纯函数：同 (geometry, built, 起点, 层) 恒同结果。
 */
export function floodSameLevel(
  geometry: MapGeometry,
  built: BuiltStructuresIndex,
  startX: number,
  startY: number,
  level: number,
  options: FloodSameLevelOptions = {},
): Set<number> {
  const { width, height } = geometry.grid;
  const startIndex = startY * width + startX;
  if (startX < 0 || startY < 0 || startX >= width || startY >= height) {
    return new Set();
  }

  const walkable = (index: number): boolean => {
    const tx = index % width;
    const ty = Math.floor(index / width);
    return walkableAtLevel(geometry, tx, ty, level, built);
  };

  const visited = new Set<number>([startIndex]);
  const queue: number[] = [startIndex];
  const maxVisited = options.maxVisited ?? Number.POSITIVE_INFINITY;

  while (queue.length > 0 && visited.size < maxVisited) {
    const current = queue.shift()!;
    const cx = current % width;
    const cy = Math.floor(current / width);
    // 4-邻接（固定顺序：左、右、上、下——结果集与顺序无关，顺序仅为确定性遍历）
    const neighbors = [
      cx > 0 ? current - 1 : -1,
      cx < width - 1 ? current + 1 : -1,
      cy > 0 ? current - width : -1,
      cy < height - 1 ? current + width : -1,
    ];
    for (const next of neighbors) {
      if (next < 0 || visited.has(next)) continue;
      if (built.walls.get(level)?.has(next)) continue; // 墙体阻挡
      if (!walkable(next)) continue;
      visited.add(next);
      queue.push(next);
      if (visited.size >= maxVisited) break;
    }
  }

  return visited;
}
