/**
 * stateMachineSystem：通用状态机 tick 推进 + 即时信号 + 离线快进
 * （framework/simulation/stateMachine）——游戏无关。
 *
 * ## tick 内如何迁移
 *
 * 每 tick 对每个带 `StateMachine` 的实体调用 `advanceStateMachine(world, eid,
 * world.time.tick)`，循环（步数上限 = 状态数 + 8，自动边无环保证收敛）：
 * 1. **定时迁移优先**：取当前状态中「到期 tick ≤ 目标 tick」且最早到期的
 *    `afterTicks` 迁移；迁移后 `enteredTick` = 精确到期 tick（不是当前 tick），
 *    故长跨度快进与逐 tick 推进产生完全相同的状态与计时。
 * 2. 其次**条件迁移**：按声明顺序取首个求值为真的 `condition` 迁移（在目标
 *    tick 求值；与 worldClock/演化引擎的离线近似语义一致）。
 * 3. 无可用迁移则停。
 *
 * 即时信号（`signalStateMachine`）在动作发生的同 tick 同步应用，随后立即
 * 用当前 tick 走一次 advance（让 `afterTicks: 0` 的后续链当 tick 收敛）——
 * 「被采集时立即转状态」不依赖系统相对顺序。
 *
 * ## 离线快进
 *
 * `fastForwardStateMachines(world, targetTick)` 在同一状态图上按**迁移步**
 * 推进（不是逐 tick），把全部实体状态机快进到 targetTick。定时迁移用绝对
 * `enteredTick + afterTicks` 派生，因此逐 tick 推进到 targetTick 与一次快进
 * 到 targetTick 的最终状态、剩下计时、效果结果完全一致——离线补差路径
 * （GameSimulation.runOfflineCatchUp）在 advanceTickTo 前调用本函数。
 */
import type { GameWorld } from "framework/world";
import { getSpawnCondition } from "framework/systems/gameplay/spawnConditions";
import { applyEffectSpecs } from "framework/simulation/effects/effectRegistry";
import {
  StateMachine,
  stateMachineDefOf,
  type CompiledStateMachine,
  type CompiledTransition,
} from "framework/simulation/stateMachine/stateMachine";

/** 单步推进的步数上限（自动边无环 ⇒ 真实上限 = 状态数；+8 为条件重入留裕量）。 */
function stepBudget(def: CompiledStateMachine): number {
  return def.states.size + 8;
}

/**
 * 应用一条迁移：写目标状态、进入 tick = atTick，并在 atTick 语境下求值效果
 * （临时把 world.time.tick 拨到 atTick，保证 tick 相关效果与逐 tick 一致）。
 */
function applyTransition(
  world: GameWorld,
  eid: number,
  transition: CompiledTransition,
  atTick: number,
): void {
  const entry = StateMachine[eid];
  if (!entry) return;
  entry.state = transition.to;
  entry.enteredTick = atTick;

  if (transition.effects.length === 0) return;
  const saved = world.time.tick;
  world.time.tick = atTick;
  try {
    applyEffectSpecs(world, eid, [eid], transition.effects);
  } finally {
    world.time.tick = saved;
  }
}

/**
 * 把单实体状态机推进到 targetTick（纯迁移步进，不逐 tick）。
 * 自动边无环 ⇒ 最多 def.states.size 次迁移后进入终态。
 */
export function advanceStateMachine(world: GameWorld, eid: number, targetTick: number): void {
  const entry = StateMachine[eid];
  if (!entry) return;
  const def = stateMachineDefOf(world, eid);
  if (!def) return;

  const budget = stepBudget(def);
  for (let step = 0; step < budget; step++) {
    const state = def.states.get(entry.state);
    if (!state) {
      world.logger.warn("状态机当前状态未在配置中定义，跳过", { eid, state: entry.state });
      return;
    }

    // 1) 定时迁移：到期 tick ≤ target 且最早到期者
    let timed: CompiledTransition | undefined;
    let timedDue = Infinity;
    for (const transition of state.transitions) {
      if (transition.kind !== "timed") continue;
      const due = entry.enteredTick + (transition.afterTicks ?? 0);
      if (due <= targetTick && due < timedDue) {
        timedDue = due;
        timed = transition;
      }
    }
    if (timed) {
      applyTransition(world, eid, timed, timedDue);
      continue;
    }

    // 2) 条件迁移：在目标 tick 求值，按声明顺序取首个为真者
    let conditioned = false;
    for (const transition of state.transitions) {
      if (transition.kind !== "condition" || !transition.condition) continue;
      let condition: (w: GameWorld) => boolean;
      try {
        condition = getSpawnCondition(transition.condition);
      } catch (err) {
        world.logger.warn("状态机条件未注册，跳过", {
          eid,
          condition: transition.condition,
          error: err instanceof Error ? err.message : String(err),
        });
        continue;
      }
      const saved = world.time.tick;
      world.time.tick = targetTick;
      let truthy = false;
      try {
        truthy = condition(world);
      } finally {
        world.time.tick = saved;
      }
      if (truthy) {
        applyTransition(world, eid, transition, targetTick);
        conditioned = true;
        break;
      }
    }
    if (conditioned) continue;

    return; // 无可迁移
  }

  world.logger.warn("状态机单次推进超出步数上限（疑似配置环），已停止", { eid, state: entry.state });
}

/**
 * 即时信号：当前状态若有匹配该信号的迁移，立即应用（进入 tick = 当前 tick），
 * 随后立刻走到期链（afterTicks: 0 后续当 tick 收敛）。返回是否命中迁移。
 */
export function signalStateMachine(world: GameWorld, eid: number, signal: string): boolean {
  const entry = StateMachine[eid];
  if (!entry) return false;
  const def = stateMachineDefOf(world, eid);
  if (!def) return false;

  const state = def.states.get(entry.state);
  if (!state) return false;

  for (const transition of state.transitions) {
    if (transition.kind !== "signal" || transition.signal !== signal) continue;
    applyTransition(world, eid, transition, world.time.tick);
    advanceStateMachine(world, eid, world.time.tick);
    return true;
  }
  return false;
}

/** stateMachineSystem tick 体：把每个状态机推进到当前 tick。 */
export function stateMachineSystem(world: GameWorld): GameWorld {
  const target = world.time.tick;
  for (let eid = 0; eid < StateMachine.length; eid++) {
    if (StateMachine[eid]) advanceStateMachine(world, eid, target);
  }
  return world;
}

/**
 * 离线快进：把全部实体的状态机一次推进到 targetTick（迁移步进，非逐 tick）。
 * 条件迁移在 targetTick 求值；效果在其迁移 tick 语境下求值。函数返回时
 * world.time.tick 恢复为调用前的值（时钟推进归调用方的 advanceTickTo）。
 */
export function fastForwardStateMachines(world: GameWorld, targetTick: number): void {
  const saved = world.time.tick;
  world.time.tick = targetTick;
  try {
    for (let eid = 0; eid < StateMachine.length; eid++) {
      if (StateMachine[eid]) advanceStateMachine(world, eid, targetTick);
    }
  } finally {
    world.time.tick = saved;
  }
}
