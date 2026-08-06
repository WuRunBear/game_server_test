/**
 * questSystem：任务进度推进（tick 系统）+ 接受/提交原子。
 *
 * - **tick 体**：对进行中（ACTIVE）任务检查进度——
 *   collect 型读背包持有量、kill 型消费本帧击杀事件计数；达标 → READY（可交）。
 *   击杀事件每 tick 先整体取出一次再分发（consumeEvents 是清空式消费，
 *   多个击杀型任务共享同一批事件）。
 * - **acceptQuest 原子**：接受任务（未接才可接，零副作用失败）。
 * - **submitQuest 原子**：提交 READY 任务——collect 型校验并消耗任务物品
 *   （dry-run 奖励先验可放，防消耗后丢产出）→ 发奖励物品 → 好感增减
 *   （对象=提交对话的 NPC kind，由 dialogueSystem 传入）→ 标记 DONE。
 *
 * 游戏无关——任务目标/奖励/好感全部经 game/quests/*.json 配置引用。
 */
import { query } from "bitecs";

import { Player, Inventory, Quest, QUEST_ACTIVE, QUEST_READY, QUEST_DONE } from "components";
import type { GameWorld, EntityId } from "world";
import { consumeEvents } from "framework/events/gameEvents";
import { addToInventory } from "framework/systems/gameplay/inventoryOps";
import { addRelation } from "framework/systems/gameplay/relation";
import type { QuestDefinitionJson } from "framework/config/schema/QuestSchema";

/** 背包中 kind 物品总数。 */
function inventoryCount(world: GameWorld, playerEid: EntityId, kind: string): number {
  const inv = Inventory[playerEid];
  if (!inv) return 0;
  let total = 0;
  for (const slot of inv.slots) {
    if (slot && slot.kind === kind) total += slot.count;
  }
  return total;
}

/** 跨槽贪婪消耗 kind 物品（调用前已校验数量足够，必然扣足）。 */
function consumeKind(inv: NonNullable<(typeof Inventory)[number]>, kind: string, amount: number): void {
  let remaining = amount;
  for (let i = 0; i < inv.slots.length && remaining > 0; i++) {
    const slot = inv.slots[i];
    if (!slot || slot.kind !== kind) continue;
    const take = Math.min(remaining, slot.count);
    slot.count -= take;
    remaining -= take;
    if (slot.count <= 0) inv.slots[i] = null;
  }
}

/**
 * 接受任务原子：把任务加入玩家任务列表（ACTIVE）。
 *
 * @returns 是否接受成功（任务定义存在且玩家未持有该任务）
 */
export function acceptQuest(world: GameWorld, playerEid: EntityId, questId: string): boolean {
  const def = world.gameDef.questsByKind?.get(questId);
  if (!def) return false;

  let quests = Quest[playerEid];
  if (!quests) {
    quests = Quest[playerEid] = [];
  }
  if (quests.some((q) => q.questId === questId)) return false;

  quests.push({ questId, state: QUEST_ACTIVE, count: 0 });
  return true;
}

/**
 * 提交任务原子：READY 任务结算——collect 型消耗任务物品 + 发奖励 + 好感。
 *
 * @param npcKind 好感增减对象（提交对话的 NPC kind；无则只结算物品）
 * @returns 是否提交成功（任务 READY 且 collect 型物品足量且奖励可放入）
 */
export function submitQuest(world: GameWorld, playerEid: EntityId, questId: string, npcKind?: string): boolean {
  const def = world.gameDef.questsByKind?.get(questId);
  const quests = Quest[playerEid];
  const quest = quests?.find((q) => q.questId === questId);
  if (!def || !quest || quest.state !== QUEST_READY) return false;

  const inv = Inventory[playerEid];
  if (!inv) return false;

  // collect 型：任务物品足量校验 + 奖励 dry-run（防消耗后丢产出）
  if (def.type === "collect") {
    if (inventoryCount(world, playerEid, def.itemKind ?? "") < def.goal) return false;
  }
  const dryInv = {
    capacity: inv.capacity,
    slots: inv.slots.map((s) => (s ? { ...s } : null)),
  };
  for (const reward of def.submit.rewards) {
    const leftover = addToInventory(dryInv, world.gameDef.itemsByKind, reward.kind, reward.count);
    if (leftover > 0) return false;
  }

  // 结算：消耗任务物品 → 发奖励 → 好感 → DONE
  if (def.type === "collect") {
    consumeKind(inv, def.itemKind ?? "", def.goal);
  }
  for (const reward of def.submit.rewards) {
    addToInventory(inv, world.gameDef.itemsByKind, reward.kind, reward.count);
  }
  if (npcKind) {
    addRelation(world, playerEid, npcKind, def.submit.relationDelta);
  }
  quest.state = QUEST_DONE;
  return true;
}

/** questSystem tick 体：推进 ACTIVE 任务进度（收集背包计数 / 击杀事件计数）。 */
export function createQuestSystem() {
  return function questSystem(world: GameWorld): GameWorld {
    // 击杀事件先整体取出（consumeEvents 为清空式消费，多个任务共享同一批事件）
    const killed = consumeEvents(world, "killed");

    for (const playerEid of query(world, [Player])) {
      const quests = Quest[playerEid];
      if (!quests || quests.length === 0) continue;

      for (const quest of quests) {
        if (quest.state !== QUEST_ACTIVE) continue;
        const def: QuestDefinitionJson | undefined = world.gameDef.questsByKind?.get(quest.questId);
        if (!def) continue;

        if (def.type === "collect") {
          if (inventoryCount(world, playerEid, def.itemKind ?? "") >= def.goal) {
            quest.state = QUEST_READY;
          }
        } else if (def.type === "kill") {
          for (const evt of killed) {
            if (evt.data.kind === def.victimKind && evt.data.killer === playerEid) {
              quest.count += 1;
            }
          }
          if (quest.count >= def.goal) {
            quest.state = QUEST_READY;
          }
        }
      }
    }

    return world;
  };
}

/** 无配置默认实例（向后兼容直接注册形态）。 */
export function questSystem(world: GameWorld): GameWorld {
  return createQuestSystem()(world);
}
