/**
 * populationSystem：族群节点确定性步进 + 离线快进 + 最小生产通路
 * （framework/simulation/population）——游戏无关。
 *
 * ## 确定性步进
 *
 * `advancePopulation(world, eid, targetTick)` 把单个节点从 `lastEvolvedTick`
 * 推进到 targetTick。算法是 `(tick, 节点状态, 世界种子, 真实区域数据)` 的纯
 * 函数，**不依赖系统执行顺序、不用 Math.random**：
 *
 * 1. 承载力：`cap = floor(区域面积 × carryingDensity)`，区域面积来自真实
 *    MapGeometry 区域数据（regionAreaOf）——上限随区域大小变化。
 * 2. 增长槽绝对对齐（与演化引擎 `s = k×every`、状态机绝对计时同一约定）：
 *    只处理 `lastEvolvedTick < s ≤ targetTick` 且 `s = k×growthIntervalTicks`
 *    的槽；每槽增量由 growthForSlot 从 `(seed, source, 槽序号)` 确定性派生。
 * 3. count 单调增至 cap 后**早退**——把 lastEvolvedTick 直接推到 targetTick，
 *    剩余槽全部跳过（长跨度成本有界，与演化引擎早退不变式同构）。
 *
 * 由于槽绝对对齐且无浮点累积状态，`advancePopulation` 对时间段可结合：
 * 「一次快进到 T」必然等价于「先到 t1 再到 T」——因此
 * **快进结果 ≡ 逐 tick 推进结果**（核心断言，离线补差路径 Drover）。
 *
 * ## 离线快进
 *
 * `fastForwardPopulations(world, targetTick)` 把全部节点一次推进到 targetTick
 * （槽步进，非逐 tick）。GameSimulation.runOfflineCatchUp 在 advanceTickTo 前
 * 调用（与 fastForwardStateMachines 并列）。注意：本函数只推进节点数值，
 * 不做实体实例化（实例化是可选生产通路，非节点状态，见下）。
 *
 * ## 最小生产通路
 *
 * `materializePopulation(world, eid)` 为 `spawnInstances === true` 的节点在
 * 来源实体周围把 species 实体补足到 count（复用 spawnPlacement，确定性随机
 * 流，单次尝试数有界）。它是节点作为**实体生产来源**的最小通路——**无视野
 * 门控**（本切片不做「进入视野才实例化」，属下一切片），且缺省关闭；关闭时
 * 系统只演进数值、不产生实体。
 */
import { query } from "bitecs";
import { Kind, Transform, entityMapOf } from "framework/components";
import { mapSeedOf } from "map/runtime/mapSeeds";
import { rngFrom } from "framework/simulation/rng";
import {
  DEFAULT_SPAWN_RADIUS_TILES,
  PLACEMENT_MAX_ATTEMPTS,
  effectiveMapOf,
  randomTileCenterNear,
  trySpawnAtPixel,
} from "framework/systems/gameplay/spawnPlacement";
import {
  Population,
  growthForSlot,
  populationSourceId,
  regionAreaOf,
  resolveHomeRegion,
  populationGeometryOf,
  type PopulationNodeState,
} from "framework/simulation/population/population";
import type { MapGeometry } from "map/geometry/types";
import type { GameWorld } from "framework/world";

/** 单节点单门控的落位尝试上限（与巢穴/演化选点同一 PLACEMENT_MAX_ATTEMPTS 惯例）。 */
const DEFAULT_MAX_PER_SLOT = PLACEMENT_MAX_ATTEMPTS;

/** 最小生产通路参数（可选覆盖缺省）。 */
export interface MaterializeOptions {
  /** 计数/落位搜索半径（tile）。 */
  radiusTiles?: number;
  /** 单节点单门控的落位尝试上限。 */
  maxPerSlot?: number;
}

/**
 * 推进单个族群节点到 targetTick（纯迁移步进，不逐 tick）。
 *
 * 幂等且可结合：同参数重复调用结果一致；分两段推进与一次推进等价。
 */
export function advancePopulation(world: GameWorld, eid: number, targetTick: number): void {
  const node = Population[eid];
  if (!node) return;

  // 承载力依赖真实区域数据：每次演进按当前几何重算（区域只读，值稳定）
  const geometry = populationGeometryOf(world, eid);
  const region = resolveHomeRegion(world, eid, geometry);
  const area = geometry && region !== "" ? regionAreaOf(geometry, region) : 0;
  node.cap = Math.max(0, Math.floor(area * node.carryingDensity));

  // 来源标识（init 阶段 Kind 尚未写入，首次演进惰性填充）
  const sourceKind = node.sourceKind !== "" ? node.sourceKind : (Kind[eid] ?? "");
  node.sourceKind = sourceKind;

  if (node.count > node.cap) node.count = node.cap;
  if (targetTick <= node.lastEvolvedTick) return;
  if (node.cap <= 0) {
    // 无承载力（区域缺失/密度为 0）：无可增长空间，直接落边界
    node.lastEvolvedTick = targetTick;
    return;
  }

  const interval = node.growthIntervalTicks;
  const seed = geometry ? (mapSeedOf(world, geometry.key) ?? 0) : 0;
  const sourceId = populationSourceId(eid);
  const cap = node.cap;

  let slot = Math.floor(node.lastEvolvedTick / interval) * interval + interval;
  let count = node.count;
  while (slot <= targetTick) {
    if (count >= cap) {
      // 早退不变式：已达上限，剩余槽全部跳过（成本有界）
      node.lastEvolvedTick = targetTick;
      break;
    }
    const period = slot / interval;
    count = Math.min(cap, count + growthForSlot(seed, sourceKind, sourceId, period, node.growthRate));
    node.lastEvolvedTick = slot;
    slot += interval;
  }
  node.count = count;
}

/**
 * 节点待实例化的实体预算 = `count − 半径内存活数`（下限 0）。
 * 供最小生产通路与测试观测「来源产出与记账的差值」。
 */
export function populationSpawnBudget(
  world: GameWorld,
  eid: number,
  geometry: MapGeometry,
  radiusTiles: number,
): number {
  const node = Population[eid];
  if (!node) return 0;
  const mapKey = geometry.key;
  const { tileWidth, tileHeight } = geometry.grid;
  const cx = Math.floor(Transform.x[eid] / tileWidth);
  const cy = Math.floor(Transform.y[eid] / tileHeight);
  let alive = 0;
  for (const other of query(world, [Transform])) {
    if (Kind[other] !== node.species) continue;
    if (entityMapOf(world, other) !== mapKey) continue;
    const dx = Math.floor(Transform.x[other] / tileWidth) - cx;
    const dy = Math.floor(Transform.y[other] / tileHeight) - cy;
    if (Math.max(Math.abs(dx), Math.abs(dy)) <= radiusTiles) alive += 1;
  }
  return Math.max(0, node.count - alive);
}

/** species 原型缺失告警去重（每 kind 一次——配置错误可见但不刷屏）。 */
const warnedMissingSpecies = new Set<string>();

/**
 * 最小生产通路：为开启 spawnInstances 的节点在来源实体周围把 species 实体
 * 补足到 count（单节点单门控尝试数有界；确定性随机流）。返回本次新增数。
 * 未开启 / 无几何 / 原型未知时为空操作。
 */
export function materializePopulation(
  world: GameWorld,
  eid: number,
  options?: MaterializeOptions,
): number {
  const node = Population[eid];
  if (!node || !node.spawnInstances || node.count <= 0) return 0;

  const geometry = populationGeometryOf(world, eid);
  if (!geometry) return 0;

  if (!world.archetypes.has(node.species)) {
    if (!warnedMissingSpecies.has(node.species)) {
      warnedMissingSpecies.add(node.species);
      world.logger.warn("population species archetype is not registered; materialization skipped", {
        eid,
        species: node.species,
      });
    }
    return 0;
  }

  const radiusTiles =
    options?.radiusTiles && options.radiusTiles > 0
      ? Math.floor(options.radiusTiles)
      : DEFAULT_SPAWN_RADIUS_TILES;
  const maxPerSlot =
    options?.maxPerSlot && options.maxPerSlot > 0 ? Math.floor(options.maxPerSlot) : DEFAULT_MAX_PER_SLOT;

  const mapKey = effectiveMapOf(world, eid);
  const archetype = world.archetypes.get(node.species);
  const { tileWidth, tileHeight } = geometry.grid;
  const cx = Math.floor(Transform.x[eid] / tileWidth);
  const cy = Math.floor(Transform.y[eid] / tileHeight);

  let budget = populationSpawnBudget(world, eid, geometry, radiusTiles);
  const tick = world.time.tick;
  const seed = mapSeedOf(world, mapKey) ?? 0;
  const sourceId = populationSourceId(eid);

  let spawned = 0;
  for (let attempt = 0; budget > 0 && attempt < maxPerSlot; attempt += 1) {
    const rng = rngFrom(seed, "population-spawn", sourceId, tick, attempt);
    const { px, py } = randomTileCenterNear(rng, geometry, cx, cy, radiusTiles);
    if (trySpawnAtPixel(world, geometry, mapKey, archetype, px, py)) {
      budget -= 1;
      spawned += 1;
    }
  }
  return spawned;
}

/** populationSystem tick 体：把每个节点推进到当前 tick（可选生产通路）。 */
export function populationSystem(world: GameWorld): GameWorld {
  return createPopulationSystem()(world);
}

/**
 * 构建族群系统（可选绑定生产通路参数）。系统体对每个节点：推进数值 →
 * （开启 spawnInstances 时）补足实例。
 */
export function createPopulationSystem(config?: Record<string, unknown>): (world: GameWorld) => GameWorld {
  const materializeOptions: MaterializeOptions = {};
  if (typeof config?.radiusTiles === "number" && config.radiusTiles > 0) {
    materializeOptions.radiusTiles = config.radiusTiles;
  }
  if (typeof config?.maxPerSlot === "number" && config.maxPerSlot > 0) {
    materializeOptions.maxPerSlot = config.maxPerSlot;
  }

  return function runPopulationSystem(world: GameWorld): GameWorld {
    const target = world.time.tick;
    for (let eid = 0; eid < Population.length; eid++) {
      if (!Population[eid]) continue;
      advancePopulation(world, eid, target);
      materializePopulation(world, eid, materializeOptions);
    }
    return world;
  };
}

/**
 * 离线快进：把全部节点一次推进到 targetTick（槽步进，非逐 tick）。
 * 函数返回时 world.time.tick 恢复为调用前的值（时钟推进归调用方 advanceTickTo）。
 * 只推进节点数值，不做实体实例化（生产通路非节点状态）。
 */
export function fastForwardPopulations(world: GameWorld, targetTick: number): void {
  const saved = world.time.tick;
  world.time.tick = targetTick;
  try {
    for (let eid = 0; eid < Population.length; eid++) {
      if (Population[eid]) advancePopulation(world, eid, targetTick);
    }
  } finally {
    world.time.tick = saved;
  }
}

/** 只读快照（测试/调试）：拷贝单节点状态。 */
export function populationSnapshot(eid: number): PopulationNodeState | undefined {
  const node = Population[eid];
  return node ? { ...node } : undefined;
}
