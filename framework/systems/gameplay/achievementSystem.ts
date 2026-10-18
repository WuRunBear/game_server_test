/**
 * achievementSystem：成就解锁检查（tick 系统，服务端权威）。
 *
 * - 定义来自 game/rules/achievements.json（id / condition / 可选 reward）；
 * - 条件复用 spawnConditions 注册表（支持 `progressAtLeast` /
 *   `factionRepAtLeast` 等带参条件）。条件按世界状态求值；带玩家语义的条件
 *   同时以每个在线玩家为主体求值（任一满足即解锁）；
 * - 解锁后写入 `world.progress["achievement:<id>"] = 1`（随 world.progress 入档），
 *   因此幂等——同一成就只解锁一次、只发一次 on-achievement 事件、只记一次日志；
 * - 解锁同时向全部玩家实体的 Achievements AoS 投影（netSync 经动态 values map
 *   推送 `Achievements.<id>`——不新增 PlayerState 字段，无协议字段索引断代）；
 * - 解锁事件走类型化事件总线（事件名 "on-achievement"）；未注册触发器求值器时
 *   triggerSystem 自然忽略；
 *
 * 检查按 tick 节流（systems[].config.checkIntervalTicks，缺省 20）。
 * 游戏无关：成就 id / 条件名 / 奖励内容全部来自配置字符串。
 */
import { query } from "bitecs";

import { Inventory, Player } from "components";
import {
  ACHIEVEMENT_PENDING_PREFIX,
  ACHIEVEMENT_PROGRESS_PREFIX,
  achievementPendingKey,
  achievementProgressKey,
  markAchievementUnlocked,
} from "framework/components/achievements";
import type { EntityId, GameWorld } from "world";
import type {
  AchievementReward,
  AchievementRule,
} from "framework/config/schema/RuleSchema";
import { getSpawnCondition, hasSpawnCondition } from "framework/systems/gameplay/spawnConditions";
import { addToInventory } from "framework/systems/gameplay/inventoryOps";
import { addFactionRep } from "framework/systems/gameplay/factions";
import { queueEvent } from "framework/simulation/events/eventBus";

/** 成就解锁进度键前缀（world.progress）；定义随 Achievements 组件（供同步复用）。 */
export { ACHIEVEMENT_PROGRESS_PREFIX, ACHIEVEMENT_PENDING_PREFIX, achievementProgressKey, achievementPendingKey };

/** 缺省检查间隔（tick）。 */
export const DEFAULT_ACHIEVEMENT_CHECK_INTERVAL = 20;

/** 成就是否已解锁（world.progress 幂等标记）。 */
export function isAchievementUnlocked(world: GameWorld, id: string): boolean {
  return (world.progress[achievementProgressKey(id)] ?? 0) > 0;
}

/** 取成就规则（未配置返回 undefined）。 */
export function getAchievementRule(world: GameWorld): AchievementRule | undefined {
  return world.gameDef?.resolvedRules?.["achievements"] as AchievementRule | undefined;
}

/** 发放成就奖励（物品/声望给触发玩家；进度写世界账本）。 */
function applyReward(world: GameWorld, reward: AchievementReward | undefined, playerEid?: EntityId): void {
  if (!reward) return;

  if (reward.progress) {
    for (const [key, delta] of Object.entries(reward.progress)) {
      if (!Number.isFinite(delta)) continue;
      world.progress[key] = (world.progress[key] ?? 0) + delta;
    }
  }

  if (playerEid === undefined) return;
  applyPlayerReward(world, playerEid, reward);
}

/** 奖励是否包含只能发给玩家的部分（物品 / 势力声望）。 */
function hasPlayerScopedReward(reward: AchievementReward | undefined): boolean {
  if (!reward) return false;
  return (reward.items?.length ?? 0) > 0 || (reward.factionRep?.length ?? 0) > 0;
}

/** 玩家侧奖励发放（物品入包 + 势力声望；不做世界 progress 部分）。 */
function applyPlayerReward(world: GameWorld, playerEid: EntityId, reward: AchievementReward): void {
  if (reward.items && reward.items.length > 0) {
    const inv = Inventory[playerEid];
    if (inv) {
      for (const item of reward.items) {
        addToInventory(inv, world.gameDef.itemsByKind, item.kind, item.count, {
          nowTick: world.time.tick,
        });
      }
    }
  }

  if (reward.factionRep) {
    for (const entry of reward.factionRep) {
      addFactionRep(world, playerEid, entry.factionId, entry.delta);
    }
  }
}

/**
 * 奖励物品能否完整入包（dry-run 克隆槽位）：无背包/放不下返回 false。
 *
 * 只对 items 判定——声望无容量概念。用真实 addToInventory + nowTick 模拟，
 * 与正式发放走同一入包/混批规则（F-22 后不合并不同 spoilAt 堆叠）。
 */
function rewardFits(world: GameWorld, playerEid: EntityId, reward: AchievementReward): boolean {
  if (!reward.items || reward.items.length === 0) return true;
  const inv = Inventory[playerEid];
  if (!inv) return false;
  const dryInv = {
    capacity: inv.capacity,
    slots: inv.slots.map((slot) => (slot ? { ...slot } : null)),
  };
  for (const item of reward.items) {
    const leftover = addToInventory(dryInv, world.gameDef.itemsByKind, item.kind, item.count, {
      nowTick: world.time.tick,
    });
    if (leftover > 0) return false;
  }
  return true;
}

/** 系统级配置 schema（game.json systems[].config）。 */
export interface AchievementSystemConfig {
  /** 检查间隔（tick）；缺省 20。 */
  checkIntervalTicks?: number;
}

/** 创建成就系统（工厂形态，与其它系统一致）。 */
export function createAchievementSystem(config?: AchievementSystemConfig) {
  const rawInterval = config?.checkIntervalTicks;
  const checkInterval =
    typeof rawInterval === "number" && Number.isInteger(rawInterval) && rawInterval > 0
      ? rawInterval
      : DEFAULT_ACHIEVEMENT_CHECK_INTERVAL;
  /** 已告警过的未知条件名（防每 tick 刷日志）。 */
  const warnedConditions = new Set<string>();
  /** 已有待领取奖励但背包放不下的玩家（防每检查周期刷日志）。 */
  const warnedPending = new Set<string>();

  /**
   * 补发挂起的成就奖励（F-24）：无在线玩家时解锁写入的
   * `achievement-pending:<id>`，在玩家上线后由本函数发放并清除。
   *
   * - 接收者优先取「条件对其成立」的在线玩家，否则取首个在线玩家（世界级
   *   条件不区分主体；无人可发时保留 pending 等下一次检查）；
   * - 物品放不下 → 保留 pending 重试（不半发、不丢失）；
   * - 发放成功即删除 pending 键——成就标记仍为已解锁，不会二次挂起。
   */
  function deliverPendingRewards(world: GameWorld, players: EntityId[], rule: AchievementRule): void {
    if (players.length === 0) return;
    const pendingIds: string[] = [];
    for (const [key, value] of Object.entries(world.progress)) {
      if (!key.startsWith(ACHIEVEMENT_PENDING_PREFIX) || typeof value !== "number" || value <= 0) continue;
      pendingIds.push(key.slice(ACHIEVEMENT_PENDING_PREFIX.length));
    }

    for (const id of pendingIds) {
      const def = rule.achievements.find((entry) => entry.id === id);
      const pendingKey = achievementPendingKey(id);
      if (!def?.reward || !hasPlayerScopedReward(def.reward)) {
        // 配置已移除/无玩家侧奖励：清掉无意义的挂起键
        delete world.progress[pendingKey];
        continue;
      }

      let recipient: EntityId | undefined;
      if (hasSpawnCondition(def.condition)) {
        try {
          const condition = getSpawnCondition(def.condition);
          recipient = players.find((playerEid) => condition(world, playerEid));
        } catch {
          recipient = undefined;
        }
      }
      recipient ??= players[0];
      if (recipient === undefined) continue;

      if (!rewardFits(world, recipient, def.reward)) {
        if (!warnedPending.has(id)) {
          warnedPending.add(id);
          world.logger.warn("成就待领取奖励背包放不下，保留待领取", { id, playerEid: recipient });
        }
        continue;
      }

      applyPlayerReward(world, recipient, def.reward);
      delete world.progress[pendingKey];
      warnedPending.delete(id);
      world.logger.info("成就待领取奖励已补发", { id, playerEid: recipient });
    }
  }

  return function achievementSystem(world: GameWorld): GameWorld {
    if (world.time.tick % checkInterval !== 0) return world;

    const rule = getAchievementRule(world);
    if (!rule?.achievements?.length) return world;

    const players: EntityId[] = [...query(world, [Player])];

    // F-24：先补发上次无人在线时挂起的奖励（幂等键，只发一次）
    deliverPendingRewards(world, players, rule);

    for (const def of rule.achievements) {
      if (isAchievementUnlocked(world, def.id)) continue;

      if (!hasSpawnCondition(def.condition)) {
        if (!warnedConditions.has(def.condition)) {
          warnedConditions.add(def.condition);
          world.logger.warn("成就条件未注册，跳过", { id: def.id, condition: def.condition });
        }
        continue;
      }

      let triggerPlayer: EntityId | undefined;
      let satisfied = false;
      try {
        const condition = getSpawnCondition(def.condition);
        // 世界级条件（progressAtLeast 等）不依赖主体
        satisfied = condition(world);
        if (!satisfied) {
          for (const playerEid of players) {
            if (condition(world, playerEid)) {
              satisfied = true;
              triggerPlayer = playerEid;
              break;
            }
          }
        }
      } catch (err) {
        if (!warnedConditions.has(def.condition)) {
          warnedConditions.add(def.condition);
          world.logger.warn("成就条件求值失败，跳过", {
            id: def.id,
            condition: def.condition,
            error: err instanceof Error ? err.message : String(err),
          });
        }
        continue;
      }

      if (!satisfied) continue;

      // 世界级条件已满足时，仍尝试确定一个在线玩家作为奖励接收者/
      // 事件主体（纯世界条件的条件函数会忽略 subject，取首个在线玩家即可）。
      if (triggerPlayer === undefined && players.length > 0) {
        const condition = getSpawnCondition(def.condition);
        for (const playerEid of players) {
          if (condition(world, playerEid)) {
            triggerPlayer = playerEid;
            break;
          }
        }
      }

      // 幂等解锁：先写进度标记，再发一次事件/日志/奖励
      world.progress[achievementProgressKey(def.id)] = 1;
      // 玩家视图投影（netSync 消费；未配置 Achievements 组件的实体自动跳过）
      markAchievementUnlocked(world, def.id);
      queueEvent(world, "on-achievement", {
        eid: triggerPlayer ?? 0,
        id: def.id,
        ...(def.name ? { name: def.name } : {}),
      });
      world.logger.info("成就解锁", { id: def.id, name: def.name ?? def.id });
      applyReward(world, def.reward, triggerPlayer);
      // F-24：无触发玩家时玩家侧奖励不可发——挂起为待领取键，上线后补发
      if (triggerPlayer === undefined && hasPlayerScopedReward(def.reward)) {
        world.progress[achievementPendingKey(def.id)] = 1;
        world.logger.info("成就奖励挂起待领取（无在线玩家）", { id: def.id });
      }
    }

    return world;
  };
}

/** 无配置默认实例（向后兼容直接注册形态）。 */
export function achievementSystem(world: GameWorld): GameWorld {
  return createAchievementSystem()(world);
}
