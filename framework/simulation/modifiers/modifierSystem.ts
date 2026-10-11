/**
 * modifierSystem：修饰符过期清理 tick 体。
 *
 * computeStat 对过期条目惰性失效（tick ≥ expiresTick 不参与合成），本系统
 * 在其上补主动回收：每 tick 移除全部过期条目，空 stat 键与空集合一并删除，
 * 避免持久化的 Modifiers 集合随状态反复施加无限膨胀。
 *
 * 语义与惰性路径一致（同一 isActive 判定），清理只影响存储、不改变任一时刻
 * 的 computeStat 结果；清理由读档恢复后的下一 tick 自然接手。
 *
 * 游戏无关——只按 ModifierEntry.expiresTick 通用字段处理。
 */
import type { GameWorld } from "framework/world";
import { Modifiers } from "framework/simulation/modifiers/modifiers";

/** 条目是否仍生效（与 modifiers.computeStat 的惰性判定同源）。 */
function isActive(world: GameWorld, expiresTick: number | undefined): boolean {
  return expiresTick === undefined || world.time.tick < expiresTick;
}

/** modifierSystem tick 体：剔除过期条目，回收空键与空集合。 */
export function modifierSystem(world: GameWorld): GameWorld {
  for (let eid = 0; eid < Modifiers.length; eid++) {
    const set = Modifiers[eid];
    if (!set) continue;

    let remainingKeys = 0;
    for (const statKey of Object.keys(set)) {
      const kept = set[statKey].filter((entry) => isActive(world, entry.expiresTick));
      if (kept.length === 0) {
        delete set[statKey];
      } else {
        set[statKey] = kept;
        remainingKeys += 1;
      }
    }
    if (remainingKeys === 0) {
      Modifiers[eid] = undefined;
    }
  }
  return world;
}
