/**
 * Relation 组件：玩家对各 NPC 类的好感值（AoS 结构，挂玩家实体，持久入档）。
 *
 * 每项为玩家对某 npcKind 的好感值（对话选项效果 / 任务奖励增减）；
 * npcKind 引用实体 archetype 的 kind 字符串。持久组件：随玩家实体
 * 自动序列化入档，恢复后好感保留。
 */
export interface RelationState {
  /** NPC 的 kind 字符串（实体 archetype.kind）。 */
  npcKind: string;
  /** 好感值（正=友好，负=敌对，语义由 game/ 配置约定）。 */
  value: number;
}

export const Relation = [] as (RelationState[] | undefined)[];
