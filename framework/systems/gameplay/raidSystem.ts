/**
 * 周期袭击系统（raidSystem）：袭击导演（预警/门槛/无玩家暂停）+ 波刷 + 结构防御对抗。
 *
 * 规则来源 rules/raid.json（RaidRuleSchema，见 config/schema/RuleSchema.ts），
 * 每 tick 从 world.gameDef.resolvedRules["raid"] 读取（缺失/畸形 → no-op）：
 * - intervalTicks：门控周期（world.time.tick % intervalTicks === 0 对齐槽）
 * - waveSize / kinds：缺省波构建器——每成员从 kinds 池确定性挑一种
 * - radiusTiles：落位搜索半径（tile，缺省 4）
 * - condition：整波刷怪条件名（spawnConditions 注册表引用，如 isNight；
 *   未知名经 getSpawnCondition 求值时抛错，与演化引擎同约定）
 * - requireCondition：导演门槛条件名（支持带参 `基名:参数`）——门控槽求值
 *   不满足则跳过该轮（不进预警、不刷波）；语义定位是进度/门槛门控
 * - warnTicks：预警期时长（tick）——门控命中先进预警窗口，每 tick 对在线
 *   玩家发 on-raid-warning 类型化事件（remainingTicks 递减），倒计时结束才
 *   刷波；0/缺省 = 即刷（与旧行为逐位一致）。无在线玩家（全部 Offline 保留
 *   或无玩家）时倒计时**冻结**（进度保留，不推进不重置）
 * - attackStructures：结构防御对抗开关——发波同时为成员指派玩家基地附近的
 *   建造物目标（最近的有 Health 的 Structure 实体，半径 structureRadiusTiles
 *   缺省 = radiusTiles），成员在射程内持续攻击之；打坏归 deathSystem 统一销毁
 * - waveRef：可选规则模块引用（registerRuleModule 扩展点，框架零新概念）——
 *   模块 (world, playerEid, ctx) 返回 Array<{ kind, x?, y? }> 完全接管缺省波
 *   构建器（x/y 缺省时仍走玩家附近随机合法落位）；未知模块 id 求值时抛错
 *
 * 落位合法性与巢穴系统共用同一套语义（spawnPlacement）：锚点 tile 可走 +
 * footprint 不压同图实体/地图阻挡；确定性随机流由 (tick, playerEid, 成员序,
 * 尝试序) 派生。游戏无关——kinds 是 archetype kind 字符串；谁袭击谁、
 * 什么物种全由 game/ 配置与规则模块决定。
 *
 * 导演状态（预警窗口）与结构目标指派存 world.systemRuntimes（运行时瞬态，
 * 不入档）：读档后导演从 idle 重新开始，未发完的预警不跨存档保留。
 * 离线补差只跑演化引擎 + 状态机/族群快进（不重放 tick 系统），导演与灾害
 * 同口径不参与补差。
 */
import { hasComponent, query } from "bitecs";
import { Player, Transform, Attack, Health, Structure, STRUCTURE_ROLE_NONE, entityMapOf } from "components";
import { isOfflineRetained } from "components/offline";
import { attemptRng } from "framework/simulation/rng";
import { getRuleModule } from "framework/api";
import { queueEvent } from "framework/simulation/events/eventBus";
import { attackTarget } from "framework/systems/gameplay/combatSystem";
import { getSpawnCondition } from "framework/systems/gameplay/spawnConditions";
import {
  PLACEMENT_MAX_ATTEMPTS,
  DEFAULT_SPAWN_RADIUS_TILES,
  effectiveMapOf,
  randomTileCenterNear,
  trySpawnAtPixel,
} from "framework/systems/gameplay/spawnPlacement";
import { sameLevelDistance } from "framework/utils/gameplayDistance";
import { entityLevelOf } from "framework/components/entityLevel";
import type { MapGeometry } from "map/geometry/types";
import type { RaidRule } from "framework/config/schema/RuleSchema";
import type { GameWorld } from "world";

/** 波成员规格（waveRef 模块返回值元素）：kind 必填；x/y 缺省走玩家附近随机合法落位。 */
export interface RaidWaveMember {
  kind: string;
  x?: number;
  y?: number;
}

/** waveRef 模块调用上下文（第三参数）。 */
export interface RaidWaveContext {
  /** 当前门控 tick。 */
  tick: number;
  /** 玩家所属地图 id（模块可据此分图）。 */
  mapId: string;
  /** 规则声明的落位搜索半径（tile）。 */
  radiusTiles: number;
  /** 原始规则对象（模块可读其余自定义字段——schema passthrough 透传）。 */
  rule: RaidRule;
}

/** 可作为刷波中心的在线玩家（断线保留期/归属图不可解析者被排除）。 */
interface RaidCenter {
  eid: number;
  mapId: string;
  geometry: MapGeometry;
}

/**
 * 导演运行时状态（systemRuntimes，瞬态）：预警窗口进度。
 * 暂停语义 = 无在线玩家时不推进不重置（warnRemaining 原样保留）。
 */
interface RaidDirectorState {
  /** 预警期进行中（该轮已过门控、待倒计时结束刷波）。 */
  pending: boolean;
  /** 预警剩余 tick（pending 时有效；每在线 tick 递减 1，归零刷波）。 */
  warnRemaining: number;
}

/** world.systemRuntimes 中导演状态的键。 */
const DIRECTOR_KEY = "raidDirector";
/** world.systemRuntimes 中结构目标指派表（memberEid → structureEid）的键。 */
const STRUCTURE_TARGETS_KEY = "raidStructureTargets";

/** 取（或惰性创建）导演状态。 */
function directorStateOf(world: GameWorld): RaidDirectorState {
  let state = world.systemRuntimes.get(DIRECTOR_KEY) as RaidDirectorState | undefined;
  if (!state) {
    state = { pending: false, warnRemaining: 0 };
    world.systemRuntimes.set(DIRECTOR_KEY, state);
  }
  return state;
}

/** 取（或惰性创建）结构目标指派表。 */
function structureTargetsOf(world: GameWorld): Map<number, number> {
  let targets = world.systemRuntimes.get(STRUCTURE_TARGETS_KEY) as Map<number, number> | undefined;
  if (!targets) {
    targets = new Map<number, number>();
    world.systemRuntimes.set(STRUCTURE_TARGETS_KEY, targets);
  }
  return targets;
}

/**
 * 收集可作为刷波中心的在线玩家（query 序即原循环序，保持行为一致）：
 * 断线保留期玩家跳过（对玩法系统不可见语义）、归属图不可解析跳过。
 */
function raidCenters(world: GameWorld): RaidCenter[] {
  const centers: RaidCenter[] = [];
  for (const eid of query(world, [Player, Transform])) {
    if (isOfflineRetained(world, eid)) continue;
    const mapId = effectiveMapOf(world, eid);
    const geometry = mapId === "" ? undefined : world.maps[mapId];
    if (!geometry) continue;
    centers.push({ eid, mapId, geometry });
  }
  return centers;
}

/**
 * 结构防御对抗：为本波成员指派玩家基地附近的建造物目标。
 *
 * 目标筛选：同图、Structure role ≠ none、有 Health 且存活、tile 切比雪夫
 * 距离 ≤ structureRadiusTiles（缺省 radiusTiles）——取同层欧氏距离最近者
 * （同距取 eid 小者，保证确定）。无可指派目标时本波只按常规 AI 行动。
 */
function assignStructureTargets(
  world: GameWorld,
  rule: RaidRule,
  center: RaidCenter,
  memberEids: number[],
): void {
  if (memberEids.length === 0) return;
  const radius =
    typeof rule.structureRadiusTiles === "number" && rule.structureRadiusTiles > 0
      ? Math.floor(rule.structureRadiusTiles)
      : (typeof rule.radiusTiles === "number" && rule.radiusTiles > 0
          ? Math.floor(rule.radiusTiles)
          : DEFAULT_SPAWN_RADIUS_TILES);

  const { tileWidth, tileHeight } = center.geometry.grid;
  const px = Transform.x[center.eid];
  const py = Transform.y[center.eid];
  const ptx = Math.floor(px / tileWidth);
  const pty = Math.floor(py / tileHeight);
  const level = entityLevelOf(center.eid);

  let best: number | undefined;
  let bestDist = Infinity;
  for (const eid of query(world, [Structure, Transform])) {
    if (entityMapOf(world, eid) !== center.mapId) continue;
    if ((Structure.role[eid] ?? STRUCTURE_ROLE_NONE) === STRUCTURE_ROLE_NONE) continue;
    if (!hasComponent(world, eid, Health) || (Health.current[eid] ?? 0) <= 0) continue;
    const tx = Math.floor(Transform.x[eid] / tileWidth);
    const ty = Math.floor(Transform.y[eid] / tileHeight);
    if (Math.max(Math.abs(tx - ptx), Math.abs(ty - pty)) > radius) continue;
    // 同层欧氏距离取最近（异层目标不指派——attackTarget 同判，指派即无效）
    const dist = sameLevelDistance(px, py, level, Transform.x[eid], Transform.y[eid], entityLevelOf(eid));
    if (dist === undefined) continue;
    if (dist < bestDist || (dist === bestDist && (best === undefined || eid < best))) {
      best = eid;
      bestDist = dist;
    }
  }
  if (best === undefined) return;

  const targets = structureTargetsOf(world);
  for (const member of memberEids) targets.set(member, best);
}

/**
 * 结构防御对抗 tick 步：被指派的波成员对目标建造物结算攻击。
 *
 * attackTarget 统一校验冷却/射程/同图/友伤/目标存活；任一侧消亡（含目标被
 * 打坏后 deathSystem 销毁）即清除指派。成员不寻路——射程外不追击（寻路属
 * 后续切片），本步只把「已在基地旁的袭击者」变成对建造物的持续威胁。
 */
function attackStructuresStep(world: GameWorld): void {
  const targets = world.systemRuntimes.get(STRUCTURE_TARGETS_KEY) as Map<number, number> | undefined;
  if (!targets || targets.size === 0) return;
  for (const [member, structure] of [...targets]) {
    const memberAlive =
      hasComponent(world, member, Transform) && hasComponent(world, member, Attack);
    if (!memberAlive) {
      targets.delete(member);
      continue;
    }
    const structureAlive =
      hasComponent(world, structure, Transform) &&
      hasComponent(world, structure, Health) &&
      (Health.current[structure] ?? 0) > 0;
    if (!structureAlive) {
      targets.delete(member);
      continue;
    }
    attackTarget(world, member, structure);
  }
}

/**
 * 给单个刷波中心发波（波规格构建 + 落位 + 结构目标指派）。
 * 波构建逻辑与旧行为逐位一致（waveRef 接管 / kinds 确定性挑种）。
 */
function fireWave(
  world: GameWorld,
  rule: RaidRule,
  center: RaidCenter,
  warnedMissingKinds: Set<string>,
): void {
  const tick = world.time.tick;
  const radiusTiles =
    typeof rule.radiusTiles === "number" && rule.radiusTiles > 0
      ? Math.floor(rule.radiusTiles)
      : DEFAULT_SPAWN_RADIUS_TILES;
  const kinds = Array.isArray(rule.kinds) ? rule.kinds : [];
  const waveSize =
    typeof rule.waveSize === "number" ? Math.max(0, Math.floor(rule.waveSize)) : 0;

  // 波规格：waveRef 规则模块完全接管缺省构建器（registerRuleModule 扩展点，
  // 调用惯例同 combatSystem 的 damageFormulaRef）；未知模块 id 求值时抛错
  let wave: RaidWaveMember[];
  if (rule.waveRef !== undefined) {
    const ctx: RaidWaveContext = { tick, mapId: center.mapId, radiusTiles, rule };
    const spec = getRuleModule(rule.waveRef)(world, center.eid, ctx);
    wave = Array.isArray(spec) ? (spec as RaidWaveMember[]) : [];
  } else {
    wave = [];
    for (let i = 0; i < waveSize && kinds.length > 0; i += 1) {
      const rng = attemptRng(tick, center.eid, i, 0);
      wave.push({ kind: kinds[rng.int(kinds.length)] });
    }
  }

  const geometry = center.geometry;
  const { tileWidth, tileHeight } = geometry.grid;
  const playerTx = Math.floor(Transform.x[center.eid] / tileWidth);
  const playerTy = Math.floor(Transform.y[center.eid] / tileHeight);
  const spawned: number[] = [];

  for (let i = 0; i < wave.length; i += 1) {
    const member = wave[i];
    if (!member || typeof member.kind !== "string" || member.kind === "") continue;
    if (!world.archetypes.has(member.kind)) {
      if (!warnedMissingKinds.has(member.kind)) {
        warnedMissingKinds.add(member.kind);
        world.logger.warn("raid wave kind archetype is not registered; member skipped", {
          playerEid: center.eid,
          kind: member.kind,
        });
      }
      continue;
    }
    const archetype = world.archetypes.get(member.kind);

    if (typeof member.x === "number" && typeof member.y === "number") {
      // 显式落点：模块给定坐标，单点合法性校验（无随机搜索，不满足即跳过）
      trySpawnAtPixel(world, geometry, center.mapId, archetype, member.x, member.y, spawned);
      continue;
    }
    // 缺省落位：玩家半径内随机 tile + 可走/占位合法性，每成员尝试数有界
    for (let attempt = 0; attempt < PLACEMENT_MAX_ATTEMPTS; attempt += 1) {
      const rng = attemptRng(tick, center.eid, i, attempt + 1);
      const { px, py } = randomTileCenterNear(rng, geometry, playerTx, playerTy, radiusTiles);
      if (trySpawnAtPixel(world, geometry, center.mapId, archetype, px, py, spawned)) break;
    }
  }

  // 结构防御对抗：attackStructures 开启时给本波成员指派建造物目标
  if (rule.attackStructures) {
    assignStructureTargets(world, rule, center, spawned);
  }
}

/** 预警事件：对单个在线玩家发一条 on-raid-warning（remainingTicks 供表现层）。 */
function emitWarnings(world: GameWorld, centers: RaidCenter[], remainingTicks: number): void {
  for (const center of centers) {
    queueEvent(world, "on-raid-warning", { eid: center.eid, remainingTicks });
  }
}

export function createRaidSystem(_config?: Record<string, unknown>) {
  // 波成员 kind 原型缺失告警去重（每 kind 一次）
  const warnedMissingKinds = new Set<string>();

  return function raidSystem(world: GameWorld): GameWorld {
    const rule = world.gameDef.resolvedRules["raid"] as RaidRule | undefined;
    if (!rule) return world;
    const interval = rule.intervalTicks;
    if (typeof interval !== "number" || interval < 1) return world;

    // 结构防御对抗：每 tick 先于导演推进结算（含刷波当 tick 的指派前空转）
    attackStructuresStep(world);

    const state = directorStateOf(world);

    // 预警期：倒计时只在存在在线玩家时推进；无玩家 → 冻结（进度保留）
    if (state.pending) {
      const centers = raidCenters(world);
      if (centers.length === 0) return world;
      emitWarnings(world, centers, state.warnRemaining);
      state.warnRemaining -= 1;
      if (state.warnRemaining <= 0) {
        state.pending = false;
        for (const center of centers) fireWave(world, rule, center, warnedMissingKinds);
      }
      return world;
    }

    // 门控槽评估新一轮（与演化引擎 every 槽同一约定）
    if (world.time.tick % interval !== 0) return world;

    // 整波条件门控：未知条件名经 getSpawnCondition 求值时抛错（与演化引擎同约定）
    if (rule.condition !== undefined) {
      const condition = getSpawnCondition(rule.condition);
      if (!condition(world)) return world;
    }
    // 导演门槛门控：不满足则跳过该轮（不进预警、不刷波）
    if (rule.requireCondition !== undefined) {
      const gate = getSpawnCondition(rule.requireCondition);
      if (!gate(world)) return world;
    }

    const centers = raidCenters(world);
    if (centers.length === 0) return world;

    const warnTicks =
      typeof rule.warnTicks === "number" && rule.warnTicks > 0
        ? Math.floor(rule.warnTicks)
        : 0;
    if (warnTicks > 0) {
      // 进预警窗口：从下一 tick 起每 tick 发预警事件并递减，warnTicks 后刷波
      state.pending = true;
      state.warnRemaining = warnTicks;
      return world;
    }

    // 无预警：维持旧行为——门控当 tick 即刷
    for (const center of centers) fireWave(world, rule, center, warnedMissingKinds);
    return world;
  };
}

/** 无配置默认实例（向后兼容直接注册形态）。 */
export function raidSystem(world: GameWorld): GameWorld {
  return createRaidSystem()(world);
}
