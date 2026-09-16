/**
 * timerSystem：定时器 tick 体——到期/到周期触发效果引用并清理。
 *
 * 每 tick 扫描 ExpiresAt / Interval 两个 AoS 组件：
 * - ExpiresAt：tick ≥ expiresTick → 评估 effect（effectRegistry 求值）
 *   → 发 on-timer 事件（类型化事件总线，phase="expired"）→ 清除条目（到期清理）；
 * - Interval：tick ≥ nextTick → 评估 effect → 发 on-timer 事件（phase="interval"）
 *   → nextTick 前移一个周期、剩余次数递减；次数耗尽（=0）清除条目，
 *   负值无限重复；落后追帧（长期未触发）单 tick 最多补触发 64 次防病态循环。
 *
 * 无效果引用时仅发事件（供 on-timer 触发器经 Triggers 组件声明效果）。
 * 游戏无关——效果引用与周期参数全为通用机制配置。
 */
import type { GameWorld } from "framework/world";
import { ExpiresAt, Interval } from "framework/simulation/timer/timer";
import { applyEffectSpecs } from "framework/simulation/effects/effectRegistry";
import { queueEvent } from "framework/simulation/events/eventBus";

/** 周期定时器单 tick 最大补触发次数（落后追帧保护）。 */
const MAX_CATCHUP_FIRES = 64;

/** timerSystem tick 体：检查到期/到周期 → 触发效果 → 清理。 */
export function timerSystem(world: GameWorld): GameWorld {
  const tick = world.time.tick;

  // 一次性定时器：到期触发一次并清除
  for (let eid = 0; eid < ExpiresAt.length; eid++) {
    const entry = ExpiresAt[eid];
    if (!entry) continue;
    if (tick < entry.expiresTick) continue;

    if (entry.effect) {
      applyEffectSpecs(world, eid, [eid], [entry.effect]);
    }
    queueEvent(world, "on-timer", { eid, phase: "expired" });
    ExpiresAt[eid] = undefined;
  }

  // 周期定时器：到周期触发，剩余次数耗尽清除
  for (let eid = 0; eid < Interval.length; eid++) {
    const entry = Interval[eid];
    if (!entry) continue;
    // 非法周期（配置笔误防御）：直接清除，避免死循环
    if (!(entry.periodTicks > 0)) {
      Interval[eid] = undefined;
      continue;
    }

    let fires = 0;
    while (
      tick >= entry.nextTick &&
      (entry.remaining < 0 || entry.remaining > 0) &&
      fires < MAX_CATCHUP_FIRES
    ) {
      if (entry.effect) {
        applyEffectSpecs(world, eid, [eid], [entry.effect]);
      }
      queueEvent(world, "on-timer", { eid, phase: "interval" });
      entry.nextTick += entry.periodTicks;
      if (entry.remaining > 0) entry.remaining -= 1;
      fires += 1;
    }

    // 次数耗尽 → 清理；负值（无限）与被追帧上限截断的条目保留
    if (entry.remaining === 0) {
      Interval[eid] = undefined;
    }
  }

  return world;
}
