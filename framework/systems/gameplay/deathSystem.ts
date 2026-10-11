import { hasComponent, query } from "bitecs";
import { Health, Player, Transform, LootTable, Kind, entityMapOf } from "components";
import { spawnDroppedItem } from "framework/systems/gameplay/inventoryOps";
import { destroyEntity } from "framework/entities/destroyEntity";
import { rngFrom } from "framework/simulation/rng";
import { queueEvent } from "framework/simulation/events/eventBus";
import type { EntityId, GameWorld } from "world";

export interface RespawnMarker {
  respawnAtMs: number;
}

const DEATH_KEY = "death";
const DEFAULT_RESPAWN_DELAY_MS = 2000;
/** 战利品防误拾延迟（ms）：只需防同帧误拾、尽快可捡，与丢弃防瞬回的 DROP_PICKUP_AFTER_MS 语义不同。 */
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
 * deathSystem：统一死亡处理（所有致死源：战斗 / 需求耗尽）。
 *
 * 对 Health ≤ 0 的实体：
 * - 有 LootTable → 逐条掷骰（chance）→ spawnDroppedItem 落地
 *   （掷骰流由 (tick, eid, kind) 经统一随机服务确定性派生，不再用 Math.random）
 * - 发 on-death 类型化事件（通用载荷：eid + kind；供声明式触发器消费）
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
  const tick = world.time.tick;
  const now = tick * world.time.fixedDtMs;

  for (const eid of query(world, [Health])) {
    if ((Health.current[eid] ?? 0) > 0) continue;

    const isPlayer = hasComponent(world, eid, Player);
    // 已标记的玩家：掉落只掷一次（首帧），重生窗口内不再重复掷骰
    if (isPlayer && markers.has(eid)) continue;

    const kind = Kind[eid] ?? "";
    const table = LootTable[eid];
    if (table && table.length > 0) {
      // 确定性掷骰流：(tick, eid, kind) 派生——同世界状态恒产生同掉落序列
      const rng = rngFrom(tick, eid, kind, "death-loot");
      for (const entry of table) {
        if (rng.next() < entry.chance) {
          spawnDroppedItem(
            world,
            { kind: entry.kind, count: entry.qty },
            Transform.x[eid] ?? 0,
            Transform.y[eid] ?? 0,
            now + LOOT_PICKUP_DELAY_MS,
            entityMapOf(world, eid),
            eid,
          );
        }
      }
    }

    // 死亡事件（产生方接线）：通用载荷只放 eid + kind
    queueEvent(world, "on-death", { eid, kind });

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
