import { query } from "bitecs";
import { Transform, Player, NPC } from "components";
import type { GameWorld, EntityId } from "world";

const INTERACTION_DISTANCE = 24;

export function interactionSystem(world: GameWorld): GameWorld {
  for (const playerEid of query(world, [Player, Transform])) {
    for (const npcEid of query(world, [NPC, Transform])) {
      const dist = Math.hypot(
        Transform.x[playerEid] - Transform.x[npcEid],
        Transform.y[playerEid] - Transform.y[npcEid],
      );

      if (dist <= INTERACTION_DISTANCE) {
        world.logger.info("玩家靠近NPC", {
          playerEid,
          npcEid,
          dist: Math.round(dist),
        });
      }
    }
  }

  return world;
}
