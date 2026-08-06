/**
 * Relation 好感原子（无 tick 体）。
 *
 * 玩家对各 NPC 类的好感值增减（对话效果 relation_delta / 任务提交奖励写入）。
 * 值语义由 game/ 配置约定（如对话选项可按好感解锁——当前无消费方，先存后用）。
 */
import { Relation, type RelationState } from "components";
import type { EntityId, GameWorld } from "world";

/** 玩家对 npcKind 的好感增减（不存在则初始化为 delta）。 */
export function addRelation(world: GameWorld, playerEid: EntityId, npcKind: string, delta: number): void {
  if (!npcKind || !delta) return;

  let relations = Relation[playerEid];
  if (!relations) {
    relations = Relation[playerEid] = [];
  }

  const existing = relations.find((r) => r.npcKind === npcKind);
  if (existing) {
    existing.value += delta;
  } else {
    relations.push({ npcKind, value: delta });
  }
}

/** 读取玩家对 npcKind 的好感（无记录返回 0）。 */
export function getRelation(world: GameWorld, playerEid: EntityId, npcKind: string): number {
  const relations: RelationState[] | undefined = Relation[playerEid];
  return relations?.find((r) => r.npcKind === npcKind)?.value ?? 0;
}
