import { hasComponent, query } from "bitecs";
import { Health, Player, Transform, LootTable, Kind, Inventory, entityMapOf } from "components";
import {
  spawnDroppedItem,
  addToInventory,
} from "framework/systems/gameplay/inventoryOps";
import { destroyEntity } from "framework/entities/destroyEntity";
import { spawnEntity } from "framework/entities/spawn";
import { rngFrom } from "framework/simulation/rng";
import { queueEvent } from "framework/simulation/events/eventBus";
import { setExpiresAt } from "framework/simulation/timer/timer";
import type { EffectSpec } from "framework/simulation/effects/effectRegistry";
import type { RespawnRule } from "framework/config/schema/RuleSchema";
import type { EntityId, GameWorld } from "world";

export interface RespawnMarker {
  respawnAtMs: number;
}

const DEATH_KEY = "death";
const DEFAULT_RESPAWN_DELAY_MS = 2000;
/** 战利品防误拾延迟（ms）：只需防同帧误拾、尽快可捡，与丢弃防瞬回的 DROP_PICKUP_AFTER_MS 语义不同。 */
const LOOT_PICKUP_DELAY_MS = 300;
/** 死亡容器缺省存活时限（tick）：6000 ≈ 5 分钟 @20tps（rules 的 deathContainer.ttlTicks 可覆盖）。 */
const DEFAULT_DEATH_CONTAINER_TTL_TICKS = 6000;
/** 容器到期效果：销毁容器实体（内容物作为其 AoS 数据一并清理）。 */
const DESPAWN_EFFECT: EffectSpec = { name: "despawn" };

/** 取（或惰性创建）重生标记表：eid → 重生截止时刻（world.systemRuntimes 持久）。 */
export function getRespawnMarkers(world: GameWorld): Map<EntityId, RespawnMarker> {
  let markers = world.systemRuntimes.get(DEATH_KEY) as Map<EntityId, RespawnMarker> | undefined;
  if (markers) return markers;
  markers = new Map();
  world.systemRuntimes.set(DEATH_KEY, markers);
  return markers;
}

/** 物品死亡保留判定：itemKinds 声明 keepOnDeath 的物品不转入死亡容器。 */
function keepOnDeathOf(world: GameWorld, kind: string): boolean {
  return world.gameDef.itemsByKind?.get(kind)?.keepOnDeath ?? false;
}

/**
 * 玩家死亡容器（通用死亡惩罚机制，配置驱动）：
 *
 * rules.respawn.deathContainer 声明容器原型与存活时限；缺省段 = 不生成
 * （维持无惩罚旧行为）。生成后把玩家背包整体转入容器（keepOnDeath 物品
 * 留在原槽位，装备槽引用的物品即背包槽物品、随之进容器），并按时限挂
 * 一次性定时器到期 despawn（内容物随之消失）。容器不落 LootTable、
 * 不参与战斗——它没有 Health，deathSystem 的非玩家路径天然不会碰它。
 *
 * 转移失败兜底：容器装不下（容量不足）时剩余物留在玩家背包，不销毁不丢地。
 */
function spawnDeathContainer(world: GameWorld, playerEid: EntityId, rules: RespawnRule | undefined): void {
  const cfg = rules?.deathContainer;
  if (!cfg) return;

  if (!world.archetypes.has(cfg.archetype)) {
    world.logger.error("死亡容器原型未注册，跳过生成", { archetype: cfg.archetype });
    return;
  }
  const playerInv = Inventory[playerEid];
  if (!playerInv) return;

  const corpseEid = spawnEntity(world, world.archetypes.get(cfg.archetype), world.components_registry, {
    x: Transform.x[playerEid] ?? 0,
    y: Transform.y[playerEid] ?? 0,
    mapId: entityMapOf(world, playerEid),
  });

  const containerInv = Inventory[corpseEid];
  if (!containerInv) {
    world.logger.error("死亡容器原型缺少 Inventory 组件，背包留在玩家身上", {
      archetype: cfg.archetype,
      corpseEid,
    });
    destroyEntity(world, corpseEid);
    return;
  }

  // 背包整体转移：逐槽搬入（并入同 kind 堆叠）；保留标志物与容器装不下的剩余留玩家
  const itemsByKind = world.gameDef.itemsByKind;
  for (let i = 0; i < playerInv.slots.length; i++) {
    const stack = playerInv.slots[i];
    if (!stack) continue;
    if (keepOnDeathOf(world, stack.kind)) continue;
    const leftover = addToInventory(containerInv, itemsByKind, stack.kind, stack.count);
    if (leftover <= 0) {
      playerInv.slots[i] = null;
    } else if (leftover < stack.count) {
      stack.count = leftover; // 部分转移：剩余留在玩家
    }
    // leftover === stack.count → 容器已满：整槽留在玩家
  }

  // 存活时限：到期经 despawn 效果销毁（0 = 永不过期；定时器为运行时瞬态）
  const ttlTicks = cfg.ttlTicks ?? DEFAULT_DEATH_CONTAINER_TTL_TICKS;
  if (ttlTicks > 0) {
    setExpiresAt(corpseEid, world.time.tick + ttlTicks, DESPAWN_EFFECT);
  }
}

/**
 * deathSystem：统一死亡处理（所有致死源：战斗 / 需求耗尽）。
 *
 * 对 Health ≤ 0 的实体：
 * - 有 LootTable → 逐条掷骰（chance）→ spawnDroppedItem 落地
 *   （掷骰流由 (tick, eid, kind) 经统一随机服务确定性派生，不再用 Math.random）
 * - 发 on-death 类型化事件（通用载荷：eid + kind；供声明式触发器消费）
 * - 玩家 → 写重生标记（含延迟），**不 removeEntity**（原地重置语义，
 *   同 networkId 免会话重绑；由 respawnSystem 重置并传送回出生点）；
 *   规则配置了 deathContainer 时，死亡当帧生成容器并整体转入背包
 *   （keepOnDeath 物品除外）——事件时序不受影响
 * - 其他 → destroyEntity
 *
 * 游戏无关——掉落内容由 LootTable 的 kind 字符串决定，容器行为由 rules 配置。
 */
export function deathSystem(world: GameWorld): GameWorld {
  const markers = getRespawnMarkers(world);
  const rules = world.gameDef.resolvedRules["respawn"] as RespawnRule | undefined;
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
        // 死亡容器：仅死亡当帧生成一次，与重生标记同生命周期
        spawnDeathContainer(world, eid, rules);
      }
      continue;
    }

    destroyEntity(world, eid);
  }

  return world;
}
