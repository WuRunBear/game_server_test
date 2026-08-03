import { query, removeEntity } from "bitecs";
import { Health, Needs } from "components";
import type { GameWorld } from "world";

interface NeedsRule {
  decayScale?: number;
}

/**
 * needDecaySystem：按 dt 衰减实体的所有需求；归零则每秒扣 Health。
 *
 * 死亡处理沿用现行 combatSystem 语义：Health ≤ 0 → removeEntity。
 * （统一 deathSystem / 重生属 Slice 2，本切片不引入）
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
      if (Health.current[eid] <= 0) {
        removeEntity(world, eid);
      }
    }
  }

  return world;
}