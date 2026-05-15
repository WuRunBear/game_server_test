import { query, removeEntity } from "bitecs";

import { Health } from "components";
import type { GameWorld } from "world";

/**
 * 战斗系统（最小实现）：把血量 <= 0 的实体从 World 中移除。
 *
 * @param world ECS World
 * @returns 处理后的 World
 */
export function combatSystem(world: GameWorld): GameWorld {
  for (const eid of query(world, [Health])) {
    if (Health.current[eid] <= 0) removeEntity(world, eid);
  }

  return world;
}
