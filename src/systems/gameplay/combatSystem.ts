import { query, removeEntity } from "bitecs";

import { Health } from "components";
import type { GameWorld } from "world";

export function combatSystem(world: GameWorld): GameWorld {
  for (const eid of query(world, [Health])) {
    if (Health.current[eid] <= 0) removeEntity(world, eid);
  }

  return world;
}
