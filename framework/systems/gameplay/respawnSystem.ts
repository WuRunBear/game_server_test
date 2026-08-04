import { hasComponent, query } from "bitecs";
import { Health, Player, Transform, Needs } from "components";
import { getRespawnMarkers } from "framework/systems/gameplay/deathSystem";
import type { GameWorld } from "world";

/**
 * respawnSystem：消费死亡标记，原地重生玩家。
 *
 * 标记到期后：Health 回满 → 传送回地图出生点（缺省 0,0）→
 * 按规则决定是否重置 Needs。实体本身不销毁（同 networkId），
 * 断线残留的标记（实体已 remove）直接清理。
 */
export function respawnSystem(world: GameWorld): GameWorld {
  const markers = getRespawnMarkers(world);
  if (markers.size === 0) return world;

  const rules = world.gameDef.resolvedRules["respawn"] as
    | { resetNeeds?: boolean }
    | undefined;
  const resetNeeds = rules?.resetNeeds ?? true;
  const spawnPoint = world.map?.spawns.player ?? { x: 0, y: 0 };
  const now = world.time.tick * world.time.fixedDtMs;

  for (const [eid, marker] of markers) {
    if (!hasComponent(world, eid, Player)) {
      markers.delete(eid);
      continue;
    }
    if (now < marker.respawnAtMs) continue;

    Health.current[eid] = Health.max[eid] ?? 100;
    Transform.x[eid] = spawnPoint.x;
    Transform.y[eid] = spawnPoint.y;

    if (resetNeeds) {
      const needs = Needs[eid];
      if (needs) {
        for (const need of needs) need.current = need.max;
      }
    }

    markers.delete(eid);
  }

  return world;
}
