import { query } from "bitecs";
import { Health, Needs } from "components";
import type { GameWorld } from "world";

interface NeedsRule {
  decayScale?: number;
}

/**
 * needDecaySystem：按 dt 衰减实体的所有需求；归零则每秒扣 Health。
 *
 * 死亡处理统一归 deathSystem（Slice 2 起不再自行 removeEntity）——
 * 本系统只负责扣血，Health ≤ 0 的实体由 deathSystem 做掉落/重生/移除。
 * 游戏无关——只按 Need.{name,decayPerSec,starveDmg} 通用字段处理。
 */
export function needDecaySystem(world: GameWorld): GameWorld {
  const rules = world.gameDef.resolvedRules["needs"] as NeedsRule | undefined;
  const decayScale = rules?.decayScale ?? 1;
  const dtSec = world.time.dtMs / 1000;
  if (dtSec <= 0) return world;

  for (const eid of query(world, [Health])) {
    // 需求只作用于活物（需 Health），避免给无血量实体套 AoS
    const needs = Needs[eid];
    if (!needs || needs.length === 0) continue;

    let starving = false;
    for (const need of needs) {
      need.current = Math.max(0, need.current - need.decayPerSec * decayScale * dtSec);
      if (need.current <= 0 && need.starveDmg > 0) {
        starving = true;
      }
    }

    if (starving) {
      let totalStarveDmg = 0;
      for (const need of needs) {
        if (need.current <= 0) {
          totalStarveDmg += need.starveDmg;
        }
      }
      Health.current[eid] = (Health.current[eid] ?? 0) - totalStarveDmg * dtSec;
    }
  }

  return world;
}