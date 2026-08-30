import { hasComponent, query } from "bitecs";
import { Health, Player, Transform, Needs, SpawnPoint, entityMapOf } from "components";
import { getRespawnMarkers } from "framework/systems/gameplay/deathSystem";
import { movePlayerToMap } from "framework/map/switchMap";
import type { GameWorld } from "world";

/**
 * respawnSystem：消费死亡标记，重生玩家。
 *
 * 标记到期后：Health 回满 → 传送回**持久化出生点**（SpawnPoint 组件，
 * addPlayer 按出生规则选点后写入、随实体入档——Transform 会被移动覆盖，
 * 不能作为出生点依据；出生点含图归属，跨图死亡同样回到出生图）→
 * 按规则决定是否重置 Needs。实体本身不销毁（同 networkId），
 * 断线残留的标记（实体已 remove）直接清理。
 *
 * 无出生点字段（手工构造的实体）或出生点图已不存在（配置删图，error 日志）
 * 时回退：所在图几何中心；无图配置 (0,0)。
 */
export function respawnSystem(world: GameWorld): GameWorld {
  const markers = getRespawnMarkers(world);
  if (markers.size === 0) return world;

  const rules = world.gameDef.resolvedRules["respawn"] as
    | { resetNeeds?: boolean }
    | undefined;
  const resetNeeds = rules?.resetNeeds ?? true;
  const now = world.time.tick * world.time.fixedDtMs;

  for (const [eid, marker] of markers) {
    if (!hasComponent(world, eid, Player)) {
      markers.delete(eid);
      continue;
    }
    if (now < marker.respawnAtMs) continue;

    Health.current[eid] = Health.max[eid] ?? 100;

    const spawn = SpawnPoint[eid];
    const backAtSpawn = spawn
      ? movePlayerToMap(world, eid, spawn.mapId, { x: spawn.x, y: spawn.y })
      : false;
    if (!backAtSpawn) {
      if (spawn) {
        world.logger.error("重生出生点图不存在，回退所在图几何中心", {
          eid,
          spawnMapId: spawn.mapId,
        });
      }
      const geometry = world.maps[entityMapOf(world, eid)];
      const fallback = geometry
        ? {
            x: (geometry.grid.width / 2) * geometry.grid.tileWidth,
            y: (geometry.grid.height / 2) * geometry.grid.tileHeight,
          }
        : { x: 0, y: 0 };
      Transform.x[eid] = fallback.x;
      Transform.y[eid] = fallback.y;
    }

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
