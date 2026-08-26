import { hasComponent, query } from "bitecs";
import { Health, Player, Transform, LootTable, entityMapOf } from "components";
import { spawnDroppedItem } from "framework/systems/gameplay/inventoryOps";
import { destroyEntity } from "framework/entities/destroyEntity";
import type { EntityId, GameWorld } from "world";

export interface RespawnMarker {
  respawnAtMs: number;
}

const DEATH_KEY = "death";
const DEFAULT_RESPAWN_DELAY_MS = 2000;
const LOOT_PICKUP_DELAY_MS = 300;

/** 取（或惰性创建）重生标记表：eid → 重生截止时刻（world.systemRuntimes 持久）。 */
export function getRespawnMarkers(world: GameWorld): Map<EntityId, RespawnMarker> {
  let markers = world.systemRuntimes.get(DEATH_KEY) as Map<EntityId, RespawnMarker> | undefined;
  if (markers) return markers;
  markers = new Map();
  world.systemRuntimes.set(DEATH_KEY, markers);
  return markers;
}

/**
 * deathSystem：统一死亡处理（所有致死源：战斗 / 饿死）。
 *
 * 对 Health ≤ 0 的实体：
 * - 有 LootTable → 逐条掷骰（chance）→ spawnDroppedItem 落地
 * - 玩家 → 写重生标记（含延迟），**不 removeEntity**（原地重置语义，
 *   同 networkId 免会话重绑；由 respawnSystem 重置并传送回出生点）
 * - 其他 → destroyEntity
 *
 * 游戏无关——掉落内容由 LootTable 的 kind 字符串决定。
 */
export function deathSystem(world: GameWorld): GameWorld {
  const markers = getRespawnMarkers(world);
  const rules = world.gameDef.resolvedRules["respawn"] as
    | { delayMs?: number }
    | undefined;
  const respawnDelayMs = rules?.delayMs ?? DEFAULT_RESPAWN_DELAY_MS;
  const now = world.time.tick * world.time.fixedDtMs;

  for (const eid of query(world, [Health])) {
    if ((Health.current[eid] ?? 0) > 0) continue;

    const isPlayer = hasComponent(world, eid, Player);
    // 已标记的玩家：掉落只掷一次（首帧），重生窗口内不再重复掷骰
    if (isPlayer && markers.has(eid)) continue;

    const table = LootTable[eid];
    if (table && table.length > 0) {
      for (const entry of table) {
        if (Math.random() < entry.chance) {
          spawnDroppedItem(
            world,
            { kind: entry.kind, count: entry.qty },
            Transform.x[eid] ?? 0,
            Transform.y[eid] ?? 0,
            now + LOOT_PICKUP_DELAY_MS,
            entityMapOf(world, eid),
          );
        }
      }
    }

    if (isPlayer) {
      // 原地重生：标记一次（已标记则保持原截止时间，避免每 tick 顺延）
      if (!markers.has(eid)) {
        markers.set(eid, { respawnAtMs: now + respawnDelayMs });
      }
      continue;
    }

    destroyEntity(world, eid);
  }

  return world;
}
