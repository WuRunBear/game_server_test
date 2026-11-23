import { hasComponent, query } from "bitecs";
import { Cooldown, Health, Transform, Velocity, entityMapOf, Enemy, NetworkId } from "components";
import { entityLevelOf } from "framework/components/entityLevel";
import { sameLevelDistance } from "framework/utils/gameplayDistance";
import { isOfflineRetained } from "framework/components/offline";
import type { GameWorld, System } from "world";
import type { EntityId } from "world";
import {
  ActionDefinitionSchema,
  ActionSystemConfigSchema,
  loadActionConfigFile,
  type ActionDefinition,
  type ActionSystemConfig,
} from "framework/config/schema/ActionSchema";
import { attackTarget } from "framework/systems/gameplay/combatSystem";
import { harvest } from "framework/systems/gameplay/gatheringSystem";
import { awardHarvestXp } from "framework/systems/gameplay/progression";
import { throwWeapon } from "framework/systems/gameplay/projectileSystem";
import {
  ActionState,
  clearActionState,
  getActionDefinition,
  getActionRuntime,
  phaseIdAt,
  phaseIndexAt,
  normalizeDirection,
  setActionRuntime,
  type ActionRuntime,
  type ActionStateEntry,
} from "framework/simulation/actions/actionState";

/**
 * actionSystem：服务端权威的动作时间轴推进器。
 *
 * ## 职责边界
 *
 * - 只决定**何时**调用既有原子（`attackTarget` / `harvest` / `throwWeapon`），
 *   不复制伤害公式、采集掉落、工具门槛、冷却数值或投掷方向解析。
 * - 动作开始时写 `ActionState`（actionId/startedTick/durationTicks/phase/target/
 *   dir/lock/interruptible），每 tick 推进阶段；事件阶段每个事件只触发一次。
 * - 结束/死亡/换图/受击（按配置）清空；不迁移 place/deconstruct/consume/
 *   dialogue 等瞬时路径。
 *
 * ## 系统排序（见 game/game.json 与 registerBuiltinSystems 注释）
 *
 * 当前 game.json 的顺序是 combat（冷却递减）→ gathering（再生）→ interaction
 * （意图路由）。actionSystem 声明 `after: ["interaction"]`，因为动作由交互意图
 * 启动，必须在同一 tick 被推进；同时声明 `before: ["equipment", "progression",
 * "death"]`：
 * - 事件伤害发生在 progression 之前 → 击杀事件同 tick 结算经验；
 * - 发生在 death 之前 → 击杀同 tick 进入死亡处理；
 * - 不放到 combat/physics 之前（它们是既有顺序中的前置系统），移动锁由
 *   applyInputs 在下一 tick 生效，本 tick 的位移已经结算，无需重排物理链。
 *
 * ## 时间与阶段
 *
 * 阶段区间为 `[上一阶段 endTick, 本阶段 endTick)`；事件在**进入**阶段时触发
 * 一次。客户端动画进度用 `(RoomState.tick - Action.startedTick) /
 * Action.durationTicks`，不混用毫秒。
 */

/** 动作系统配置的解析/安装结果。 */
export interface InstalledActionRuntime extends ActionRuntime {
  /** 配置来源（日志/错误定位）。 */
  source: string;
}

/**
 * 装配动作运行时（actionSystem 工厂期调用）。
 *
 * 无 `actionsPath` / 内联 `actions` 时返回 undefined——动作系统 no-op，
 * interaction/throw 保持旧瞬时行为（向后兼容）。配置非法（文件缺失、schema
 * 不合法、意图映射引用不存在的动作）直接抛错，加载期 fail-fast。
 */
export function installActionRuntime(
  world: GameWorld,
  rawConfig?: ActionSystemConfig | Record<string, unknown>,
): InstalledActionRuntime | undefined {
  const config = ActionSystemConfigSchema.parse(rawConfig ?? {});
  let actions: Record<string, ActionDefinition> | undefined;
  let source = "inline actions";
  if (config.actions) {
    actions = config.actions;
  } else if (config.actionsPath) {
    source = config.actionsPath;
    actions = loadActionConfigFile(config.actionsPath).actions;
  }
  if (!actions) return undefined;

  const actionMap = new Map<string, ActionDefinition>();
  for (const [actionId, definition] of Object.entries(actions)) {
    // 逐项再解析一次：内联配置/文件配置都经过同一 schema（默认值/边界校验）。
    actionMap.set(actionId, ActionDefinitionSchema.parse(definition));
  }
  for (const [intent, actionId] of Object.entries(config.intentActions)) {
    if (!actionMap.has(actionId)) {
      throw new Error(
        `action runtime "${source}": intent "${intent}" references unknown action "${actionId}"`,
      );
    }
  }
  const runtime: InstalledActionRuntime = {
    actions: actionMap,
    intentActions: { ...config.intentActions },
    source,
  };
  setActionRuntime(world, runtime);
  return runtime;
}

/** 动作启动选项（目标/朝向/瞄准/复核距离；eid 均为服务端内部标识）。 */
export interface StartActionOptions {
  /** 已解析的目标实体 eid（-1/缺省 = 无目标）。 */
  targetEid?: number;
  /** 朝向单位向量（缺省由目标方向或 +x 得出）。 */
  dirX?: number;
  dirY?: number;
  /** 投掷瞄准点（世界坐标，仅 spawn-projectile 事件使用）。 */
  aimX?: number;
  aimY?: number;
  /** 采集事件复核距离（interaction range；目标离开则落空）。 */
  maxRange?: number;
}

/**
 * 启动一个已配置动作。
 *
 * 校验顺序：动作定义存在 → 实体存活（Health > 0）→ 当前动作可打断 →
 * 动作级冷却就绪。成功时写 ActionState（含解析后的目标 eid 与朝向），
 * 不立刻结算任何事件；事件由 actionSystem 在阶段边界调用既有原子。
 *
 * @returns 是否成功启动
 */
export function startConfiguredAction(
  world: GameWorld,
  eid: EntityId,
  actionId: string,
  options: StartActionOptions = {},
): boolean {
  const definition = getActionDefinition(world, actionId);
  if (!definition) return false;
  if (!hasComponent(world, eid, Transform)) return false;
  if (hasComponent(world, eid, Health) && (Health.current[eid] ?? 0) <= 0) return false;

  const existing = ActionState[eid];
  let interrupted = false;
  if (existing) {
    if (!existing.interruptible) return false;
    clearActionState(eid);
    // 被可打断动作替换：新动作是权威起点，允许重新起冷却（不继承旧冷却）
    interrupted = true;
  }

  let cooldownStarted = false;
  if (definition.cooldownTicks !== undefined && hasComponent(world, eid, Cooldown)) {
    if (!interrupted && (Cooldown.remainingMs[eid] ?? 0) > 0) return false;
    Cooldown.remainingMs[eid] = definition.cooldownTicks * world.time.fixedDtMs;
    cooldownStarted = true;
  }

  let targetEid = options.targetEid ?? -1;
  if (targetEid >= 0 && !hasComponent(world, targetEid, Transform)) targetEid = -1;
  const targetNetworkId =
    targetEid >= 0 && hasComponent(world, targetEid, NetworkId)
      ? NetworkId.value[targetEid]
      : undefined;

  let dirX = options.dirX;
  let dirY = options.dirY;
  if (
    typeof dirX !== "number" ||
    typeof dirY !== "number" ||
    !Number.isFinite(dirX) ||
    !Number.isFinite(dirY) ||
    Math.hypot(dirX, dirY) <= 1e-6
  ) {
    if (targetEid >= 0) {
      dirX = Transform.x[targetEid] - Transform.x[eid];
      dirY = Transform.y[targetEid] - Transform.y[eid];
    } else {
      dirX = 1;
      dirY = 0;
    }
  }
  const dir = normalizeDirection(dirX, dirY);

  const state: ActionStateEntry = {
    actionId,
    startedTick: world.time.tick,
    durationTicks: definition.durationTicks,
    phaseIndex: 0,
    phase: definition.phases[0]!.id,
    eventsThroughPhase: -1,
    targetEid,
    ...(targetNetworkId !== undefined ? { targetNetworkId } : {}),
    dirX: dir.x,
    dirY: dir.y,
    locked: definition.lockMovement,
    interruptible: definition.interruptible,
    resolved: targetEid >= 0,
    mapId: entityMapOf(world, eid),
    startHealth: hasComponent(world, eid, Health) ? (Health.current[eid] ?? 0) : 0,
    cancelOnDamage: definition.cancelOnDamage,
    cooldownStarted,
    ...(options.maxRange !== undefined ? { maxRange: options.maxRange } : {}),
    ...(typeof options.aimX === "number" && Number.isFinite(options.aimX)
      ? { aimX: options.aimX }
      : {}),
    ...(typeof options.aimY === "number" && Number.isFinite(options.aimY)
      ? { aimY: options.aimY }
      : {}),
  };
  ActionState[eid] = state;

  // 锁移动立即生效（本 tick 位移已在 movement 中结算；这里清速度让快照/下一
  // tick 都从静止开始，applyInputs 在锁定期也会持续清零）。
  if (state.locked && hasComponent(world, eid, Velocity)) {
    Velocity.vx[eid] = 0;
    Velocity.vy[eid] = 0;
  }
  return true;
}

/**
 * 启动投掷动作（`submitCommand("throw")` 的服务端入口）。
 *
 * 方向解析优先级：显式瞄准点 → 最近同图同层存活 Enemy → 当前移动速度 →
 * +x。与 `throwWeapon` 的朝向解析保持同序；真正的投射物生成仍在 release
 * 事件阶段由 throwWeapon 完成（不在这里复制投掷参数/冷却/磨损）。
 */
export function startThrowAction(
  world: GameWorld,
  eid: EntityId,
  actionId: string,
  aimX?: number,
  aimY?: number,
): boolean {
  if (!hasComponent(world, eid, Transform)) return false;
  const definition = getActionDefinition(world, actionId);
  if (!definition) return false;

  const px = Transform.x[eid];
  const py = Transform.y[eid];
  let dirX: number | undefined;
  let dirY: number | undefined;
  let targetEid = -1;

  if (
    typeof aimX === "number" &&
    typeof aimY === "number" &&
    Number.isFinite(aimX) &&
    Number.isFinite(aimY) &&
    Math.hypot(aimX - px, aimY - py) > 1e-6
  ) {
    dirX = aimX - px;
    dirY = aimY - py;
  } else {
    const mapId = entityMapOf(world, eid);
    const level = entityLevelOf(eid);
    let nearest: number | undefined;
    let nearestDist = Infinity;
    for (const enemyEid of query(world, [Enemy, Health, Transform])) {
      if ((Health.current[enemyEid] ?? 0) <= 0) continue;
      if (entityMapOf(world, enemyEid) !== mapId) continue;
      const d = sameLevelDistance(
        px,
        py,
        level,
        Transform.x[enemyEid],
        Transform.y[enemyEid],
        entityLevelOf(enemyEid),
      );
      if (d === undefined) continue;
      if (d < nearestDist) {
        nearest = enemyEid;
        nearestDist = d;
      }
    }
    if (nearest !== undefined) {
      targetEid = nearest;
      dirX = Transform.x[nearest] - px;
      dirY = Transform.y[nearest] - py;
    } else if (hasComponent(world, eid, Velocity)) {
      dirX = Velocity.vx[eid];
      dirY = Velocity.vy[eid];
    }
  }

  return startConfiguredAction(world, eid, actionId, {
    targetEid,
    dirX,
    dirY,
    aimX,
    aimY,
  });
}

/**
 * 事件阶段调用既有原子（唯一结算点）。
 *
 * - `hit`：attackTarget（射程/冷却/伤害/暴击/事件全部沿用原实现）。
 * - `harvest`：harvest + 成功后的采集经验（interaction 旧路径同款）。
 *   配置了 maxRange 时先复核目标仍在交互距离内（windup 期间目标离开 → 落空）。
 * - `spawn-projectile`：throwWeapon（装备/投掷档案/磨损/冷却沿用原实现）。
 * - 未知类型兜底抛错（schema 已在加载期拒绝；此处防内联构造绕过）。
 */
function runActionEvent(
  world: GameWorld,
  eid: EntityId,
  state: ActionStateEntry,
  type: string,
): void {
  switch (type) {
    case "hit": {
      if (!isResolvedTargetCurrent(world, state)) return;
      runWithCooldownBypass(world, eid, state, () =>
        attackTarget(world, eid, state.targetEid),
      );
      return;
    }
    case "harvest": {
      if (!isResolvedTargetCurrent(world, state)) return;
      if (state.maxRange !== undefined) {
        const distance = sameLevelDistance(
          Transform.x[eid],
          Transform.y[eid],
          entityLevelOf(eid),
          Transform.x[state.targetEid],
          Transform.y[state.targetEid],
          entityLevelOf(state.targetEid),
        );
        if (distance === undefined || distance > state.maxRange) return;
      }
      if (harvest(world, eid, state.targetEid)) {
        awardHarvestXp(world, eid, state.targetEid);
      }
      return;
    }
    case "spawn-projectile": {
      runWithCooldownBypass(world, eid, state, () =>
        throwWeapon(world, eid, state.aimX, state.aimY),
      );
      return;
    }
    default:
      throw new Error(`unknown action event type "${type}" (action "${state.actionId}")`);
  }
}

/**
 * 事件阶段目标复核：目标仍是动作启动时解析出的同一网络实体。
 *
 * eid 会复用（目标在 windup 内死亡并被新实体占用），因此仅比较 eid 不够；
 * 动作启动时记录了目标 networkId，事件阶段要求 eid 与 networkId 仍对应，
 * 否则视为目标死亡/离开 → 本次事件落空（不转移目标）。
 */
function isResolvedTargetCurrent(world: GameWorld, state: ActionStateEntry): boolean {
  if (state.targetEid < 0) return false;
  if (!hasComponent(world, state.targetEid, Transform)) return false;
  if (state.targetNetworkId !== undefined) {
    if (!hasComponent(world, state.targetEid, NetworkId)) return false;
    if (NetworkId.value[state.targetEid] !== state.targetNetworkId) return false;
  }
  return true;
}

/**
 * 事件阶段临时让出动作开始时写入的冷却。
 *
 * 既有原子（attackTarget / throwWeapon）把 `Cooldown.remainingMs > 0` 视为
 * 冷却中；动作开始时已经按配置起冷却，若不临时清零，事件阶段会被自己挡住。
 * 原子成功后按 max(动作剩余冷却, 原子写入冷却) 恢复——绝不让事件把冷却缩短。
 */
function runWithCooldownBypass(
  world: GameWorld,
  eid: EntityId,
  state: ActionStateEntry,
  fn: () => boolean,
): boolean {
  if (!state.cooldownStarted || !hasComponent(world, eid, Cooldown)) {
    return fn();
  }
  const saved = Cooldown.remainingMs[eid] ?? 0;
  Cooldown.remainingMs[eid] = 0;
  try {
    return fn();
  } finally {
    const after = Cooldown.remainingMs[eid] ?? 0;
    Cooldown.remainingMs[eid] = Math.max(saved, after);
  }
}

/**
 * 推进一个 tick 的全部动作状态（actionSystem 的系统体）。
 *
 * 每个动作每 tick 至多进入一个阶段边界；`phaseIndex` 单调递增保证同一事件
 * 不会重复触发（同 tick 双结算防护）。动作在总时长到达前清空，清理后
 * netSync key diff 自动删除客户端 Action.* 键。
 */
export function tickActionStates(world: GameWorld): GameWorld {
  for (let eid = 0; eid < ActionState.length; eid++) {
    const state = ActionState[eid];
    if (!state) continue;

    // 实体已销毁 / 断线保留 / 死亡 → 取消（死亡窗口不接受动作残留）
    if (!hasComponent(world, eid, Transform)) {
      clearActionState(eid);
      continue;
    }
    if (isOfflineRetained(world, eid)) {
      clearActionState(eid);
      continue;
    }
    if (hasComponent(world, eid, Health) && (Health.current[eid] ?? 0) <= 0) {
      clearActionState(eid);
      continue;
    }

    // 换图取消：动作开始时的地图与当前归属不一致 → 清空（客户端键随之消失）
    if (entityMapOf(world, eid) !== state.mapId) {
      clearActionState(eid);
      continue;
    }

    // 受击取消（按配置）：以动作开始时生命值为基准，只在下降时触发
    if (
      state.cancelOnDamage &&
      hasComponent(world, eid, Health) &&
      (Health.current[eid] ?? 0) < state.startHealth
    ) {
      clearActionState(eid);
      continue;
    }

    const elapsed = world.time.tick - state.startedTick;
    if (elapsed < 0 || elapsed >= state.durationTicks) {
      clearActionState(eid);
      continue;
    }

    const definition = getActionDefinition(world, state.actionId);
    if (!definition) {
      // 运行时配置被替换/动作已删除：无法安全推进 → 清空
      clearActionState(eid);
      continue;
    }

    const targetPhase = phaseIndexAt(definition, elapsed);
    state.phaseIndex = targetPhase;
    state.phase = phaseIdAt(definition, targetPhase);
    // 事件游标独立于当前阶段：动作开始时已在首阶段，但首阶段事件在 actionSystem
    // 首次推进（同 tick 或下一 tick）只触发一次；跨多个阶段时按顺序补齐。
    while (state.eventsThroughPhase < targetPhase) {
      state.eventsThroughPhase += 1;
      const eventPhase = phaseIdAt(definition, state.eventsThroughPhase);
      for (const event of definition.events) {
        if (event.phase !== eventPhase) continue;
        runActionEvent(world, eid, state, event.type);
        // 事件可能间接触发清空/替换（防御：不要继续用失效状态推进）
        if (ActionState[eid] !== state) break;
      }
      if (ActionState[eid] !== state) break;
    }
  }
  return world;
}

/**
 * 创建动作系统实例。
 *
 * 工厂期加载/校验动作配置并写入 world（interactionSystem/GameSimulation
 * 运行期读取）。配置缺省时系统为 no-op，旧瞬时行为保持不变。
 */
export function createActionSystem(
  world: GameWorld,
  config?: ActionSystemConfig | Record<string, unknown>,
): System {
  installActionRuntime(world, config);
  return function actionSystem(current: GameWorld): GameWorld {
    if (!getActionRuntime(current)) return current;
    return tickActionStates(current);
  };
}

/** 向后兼容直接注册形态（无配置 = no-op）。 */
export function actionSystem(world: GameWorld): GameWorld {
  if (!getActionRuntime(world)) return world;
  return tickActionStates(world);
}
