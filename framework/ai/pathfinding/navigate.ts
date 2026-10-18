/**
 * 寻路运行时接线（framework/ai/pathfinding/navigate.ts）。
 *
 * 为 Chase/Flee 提供「直线可达 → 直走；被挡 → A* → 沿 waypoint 走」的统一实现：
 * - 运行期状态存黑板（每实体每节点独立），含目标格缓存键、下次重算 tick、
 *   当前路径与已用搜索次数（测试/诊断探针）；
 * - 目标格不变且未到 repathTicks → 完全复用缓存，不跑 A*；
 * - 目标格变化 → 超出稳定阈值/层号变化才立即重算（F-29：小范围抖动等间隔）；
 * - 每 tick A* 搜索有全局预算（config.maxSearchesPerTick）——超出后沿用旧
 *   路径（无旧路径回退直线），防止大量 NPC 同帧求路造成帧尖峰；
 * - A* 失败/超限/路径失效 → 返回 null，调用方回退旧直线移动（绝不原地卡死）。
 *
 * 建造索引（楼板/墙/连接器）按 tick 缓存：同 tick 内所有 AI 共享一次 ECS
 * 投影；直接直线可达的实体不会触碰该索引（保持旧路径零额外开销）。
 */
import { bbGet, bbSet, type Blackboard } from "framework/ai/blackboard";
import type { BtContext } from "framework/ai/btRunner";
import { normalizeOrFallback } from "framework/ai/nodes/steer";
import { entityLevelOf } from "framework/components/entityLevel";
import { entityMapOf } from "framework/components/entityMap";
import { Transform } from "framework/components/transform";
import {
  collectBuiltStructures,
  getBuiltStructuresEpoch,
  type BuiltStructuresIndex,
} from "framework/map/runtime/builtStructures";
import { walkableAtLevel } from "map/geometry/query";
import type { MapGeometry } from "map/geometry/types";
import type { GameWorld } from "world";

import { findPathWithStats, lineOfSightClear, type PathTile } from "framework/ai/pathfinding/astar";
import type { PathfindingConfig } from "framework/ai/pathfinding/config";

/** 黑板键：Chase 的寻路运行期状态。 */
export const BB_NAV_CHASE = "ai.pathfinding.chase";
/** 黑板键：Flee 的寻路运行期状态。 */
export const BB_NAV_FLEE = "ai.pathfinding.flee";

/** 寻路目标（tile 坐标 + 层号）。 */
export interface NavigationGoal {
  x: number;
  y: number;
  level: number;
}

/** 每实体寻路运行期状态（黑板值；不序列化）。 */
export interface NavigationRuntime {
  /** 上次寻路的目标缓存键（mapId + tile + level）。 */
  goalKey: string;
  /** 上次实际寻路的目标 tile 列（稳定阈值判定用）。 */
  goalX: number;
  /** 上次实际寻路的目标 tile 行。 */
  goalY: number;
  /** 上次实际寻路的目标层号。 */
  goalLevel: number;
  /** 下次允许重算的世界 tick。 */
  nextRepathTick: number;
  /** 上次检查时直线是否可达（true = 走旧直线逻辑）。 */
  direct: boolean;
  /** A* 路径（含起点；direct 时为空）。 */
  path: PathTile[];
  /** 下一个要到达的 waypoint 下标。 */
  pathIndex: number;
  /** 累计寻路评估次数（含直线可达的快速路径；测试/诊断探针）。 */
  searches: number;
  /** 上次搜索展开的节点数。 */
  lastExpandedNodes: number;
}

/** 读取/初始化某实体的寻路运行期状态（不存在时返回 undefined）。 */
export function getNavigationRuntime(
  bb: Blackboard,
  key: string = BB_NAV_CHASE,
): NavigationRuntime | undefined {
  return bbGet<NavigationRuntime>(bb, key);
}

function ensureRuntime(bb: Blackboard, key: string): NavigationRuntime {
  let runtime = bbGet<NavigationRuntime>(bb, key);
  if (!runtime) {
    runtime = {
      goalKey: "",
      goalX: 0,
      goalY: 0,
      goalLevel: 0,
      nextRepathTick: -1,
      direct: false,
      path: [],
      pathIndex: 0,
      searches: 0,
      lastExpandedNodes: 0,
    };
    bbSet(bb, key, runtime);
  }
  return runtime;
}

/**
 * 每 tick A* 搜索预算（F-29）：全局共享计数，tick 变化自动归零。
 *
 * 预算是「本 tick 真正跑 A* 的次数」上限；直线可达的快速路径不消耗预算。
 * 超出预算的请求回退旧路径/直线（见 navigateTowardsPath），避免大量 NPC
 * 同帧求路造成帧尖峰。
 */
const SEARCH_BUDGET_KEY = "ai.pathfinding.searchBudget";

interface SearchBudgetState {
  tick: number;
  used: number;
}

/** 诊断/测试：本 tick 已消耗的 A* 搜索次数（未发生搜索返回 0）。 */
export function pathfindingSearchesThisTick(world: GameWorld): number {
  const state = world.systemRuntimes.get(SEARCH_BUDGET_KEY) as SearchBudgetState | undefined;
  return state && state.tick === world.time.tick ? state.used : 0;
}

/** 尝试预占一次 A* 搜索预算；超出返回 false（调用方回退）。 */
function tryConsumeSearchBudget(world: GameWorld, limit: number): boolean {
  let state = world.systemRuntimes.get(SEARCH_BUDGET_KEY) as SearchBudgetState | undefined;
  if (!state || state.tick !== world.time.tick) {
    state = { tick: world.time.tick, used: 0 };
    world.systemRuntimes.set(SEARCH_BUDGET_KEY, state);
  }
  if (state.used >= limit) return false;
  state.used += 1;
  return true;
}

/** 建造索引按 tick 缓存（tick 变化或地图建造纪元变化即重建）。 */
const BUILT_CACHE_KEY = "ai.pathfinding.built";

interface BuiltCache {
  tick: number;
  byMap: Map<string, { epoch: number; index: BuiltStructuresIndex }>;
}

/** 取某图当前 tick 的建造索引（同 tick 多次调用共享一次 ECS 投影）。 */
function builtFor(world: GameWorld, mapId: string): BuiltStructuresIndex {
  let cache = world.systemRuntimes.get(BUILT_CACHE_KEY) as BuiltCache | undefined;
  if (!cache) {
    cache = { tick: -1, byMap: new Map() };
    world.systemRuntimes.set(BUILT_CACHE_KEY, cache);
  }
  if (cache.tick !== world.time.tick) {
    cache.tick = world.time.tick;
    cache.byMap.clear();
  }

  const epoch = getBuiltStructuresEpoch(world, mapId);
  const cached = cache.byMap.get(mapId);
  if (cached && cached.epoch === epoch) return cached.index;

  const index = collectBuiltStructures(world, mapId);
  cache.byMap.set(mapId, { epoch, index });
  return index;
}

/** tile 中心像素坐标（waypoint 目标点）。 */
function tileCenter(geometry: MapGeometry, tileX: number, tileY: number): { x: number; y: number } {
  return {
    x: (tileX + 0.5) * geometry.grid.tileWidth,
    y: (tileY + 0.5) * geometry.grid.tileHeight,
  };
}

/**
 * 朝目标移动的方向（仅供 Chase/Flee 写 Velocity）：
 * - 直线可达或 A* 失败/无路径 → 返回 null（调用方走旧直线逻辑）；
 * - 有路径 → 返回指向下一个 waypoint 的单位方向。
 *
 * 不直接改坐标/速度：移动仍由 movement/physics 积分，waypoint 到达判定只
 * 决定「下一个目标点」。
 */
export function navigateTowardsPath(
  ctx: BtContext,
  params: { key: string; goal: NavigationGoal; config: PathfindingConfig },
): { x: number; y: number } | null {
  const { world, self, bb } = ctx;
  const { key, goal, config } = params;

  const mapId = entityMapOf(world, self);
  const geometry = world.maps[mapId];
  if (!geometry) return null;

  const { width, height, tileWidth, tileHeight } = geometry.grid;
  const startX = Math.floor(Transform.x[self] / tileWidth);
  const startY = Math.floor(Transform.y[self] / tileHeight);
  if (startX < 0 || startY < 0 || startX >= width || startY >= height) return null;

  const selfLevel = entityLevelOf(self);
  const runtime = ensureRuntime(bb, key);
  const now = world.time.tick;
  const goalKey = `${mapId}|${goal.x},${goal.y}@${goal.level}`;
  const goalChanged = runtime.goalKey !== goalKey;
  // F-29 稳定阈值：目标格小范围抖动（相对上次寻路目标的 Chebyshev 偏移 ≤
  // goalStability px）不立即重算，等 repathTicks 间隔；层号变化/首次目标始终
  // 算显著变化。
  const goalDrift = Math.max(
    Math.abs(goal.x - runtime.goalX),
    Math.abs(goal.y - runtime.goalY),
  );
  // 配置量纲为 px（tile-units 归一化后），偏移是格数 → 换算成格阈值比较
  const goalStabilityTiles = config.goalStability / tileWidth;
  const significantChange =
    goalChanged &&
    (runtime.goalKey === "" ||
      goal.level !== runtime.goalLevel ||
      goalDrift > goalStabilityTiles);
  const needsRepath = significantChange || now >= runtime.nextRepathTick;

  if (needsRepath) {
    const built = builtFor(world, mapId);
    const goalCenter = tileCenter(geometry, goal.x, goal.y);
    const direct =
      goal.level === selfLevel &&
      lineOfSightClear(
        geometry,
        built,
        Transform.x[self],
        Transform.y[self],
        goalCenter.x,
        goalCenter.y,
        selfLevel,
      );

    let path: PathTile[] = runtime.path;
    let expandedNodes = runtime.lastExpandedNodes;
    let searchRan = false;
    let committed = true;

    if (direct) {
      // 直线可达：清空路径，不消耗 A* 预算（廉价快速路径）
      path = [];
      expandedNodes = 0;
    } else if (tryConsumeSearchBudget(world, config.maxSearchesPerTick)) {
      const result = findPathWithStats(
        geometry,
        built,
        { x: startX, y: startY, level: selfLevel },
        { x: goal.x, y: goal.y, level: goal.level },
        { maxNodes: config.maxNodes },
      );
      path = result.path ?? [];
      expandedNodes = result.expandedNodes;
      searchRan = true;
    } else if (runtime.direct || runtime.path.length === 0) {
      // 预算耗尽且无旧路径可沿用：本 tick 回退直线，不提交目标——下一 tick
      // 预算释放后重试（避免把「没算过」当成「已算过」而饿死 20 tick）。
      committed = false;
    }
    // 预算耗尽但有旧路径：沿用旧路径（committed 保持 true，下次间隔再算）

    if (committed) {
      runtime.direct = direct;
      runtime.path = path;
      // path[0] 恒为起点格：跳过它，避免先折回当前格中心。
      runtime.pathIndex = path.length > 1 ? 1 : 0;
      runtime.goalKey = goalKey;
      runtime.goalX = goal.x;
      runtime.goalY = goal.y;
      runtime.goalLevel = goal.level;
      runtime.nextRepathTick = now + config.repathTicks;
      runtime.searches += 1;
      if (searchRan) runtime.lastExpandedNodes = expandedNodes;
    }
  }

  if (runtime.direct || runtime.path.length === 0) return null;

  const built = builtFor(world, mapId);
  const tolerance = config.waypointTolerance;

  while (runtime.pathIndex < runtime.path.length) {
    const waypoint = runtime.path[runtime.pathIndex]!;
    const center = tileCenter(geometry, waypoint.x, waypoint.y);
    const dx = center.x - Transform.x[self];
    const dy = center.y - Transform.y[self];
    if (Math.hypot(dx, dy) <= tolerance) {
      runtime.pathIndex += 1;
      continue;
    }

    // 路径失效（地图被改/楼层被拆）：清缓存并回退直线；下次重算按节流间隔。
    const index = waypoint.y * width + waypoint.x;
    if (built.walls?.get(waypoint.level)?.has(index)) {
      runtime.path = [];
      runtime.pathIndex = 0;
      return null;
    }
    if (!walkableAtLevel(geometry, waypoint.x, waypoint.y, waypoint.level, built)) {
      runtime.path = [];
      runtime.pathIndex = 0;
      return null;
    }

    return normalizeOrFallback(dx, dy);
  }

  // 路径耗尽：本 tick 回退直线（目标可能就在前方），等待下次触发重算。
  runtime.path = [];
  runtime.pathIndex = 0;
  return null;
}

/**
 * 为 Flee 选逃逸目标格：沿背向目标的单位方向，从最远距离向下找第一个可走格。
 * 返回 null 表示无合适目标（调用方走旧直线逻辑）。
 */
export function pickFleeGoalTile(
  world: GameWorld,
  mapId: string,
  geometry: MapGeometry,
  self: NavigationGoal,
  away: { x: number; y: number },
  maxDistancePx: number,
): NavigationGoal | null {
  const { width, height, tileWidth, tileHeight } = geometry.grid;
  if (width <= 0 || height <= 0) return null;
  const tileSize = Math.min(tileWidth, tileHeight);
  const maxTiles = Math.max(1, Math.floor(maxDistancePx / tileSize));
  const built = builtFor(world, mapId);

  for (let distance = maxTiles; distance >= 1; distance--) {
    const tileX = Math.min(
      width - 1,
      Math.max(0, self.x + Math.round(away.x * distance)),
    );
    const tileY = Math.min(
      height - 1,
      Math.max(0, self.y + Math.round(away.y * distance)),
    );
    if (tileX === self.x && tileY === self.y) continue;

    const index = tileY * width + tileX;
    if (built.walls?.get(self.level)?.has(index)) continue;
    if (!walkableAtLevel(geometry, tileX, tileY, self.level, built)) continue;
    return { x: tileX, y: tileY, level: self.level };
  }

  return null;
}
