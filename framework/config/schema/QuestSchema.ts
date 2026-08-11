import { z } from "zod";

/**
 * 任务定义配置 schema（game/quests/*.json）。
 *
 * 任务目标两种形态（通用机制词）：
 * - collect：背包持有 itemKind 物品 ≥ goal（进度由 questSystem tick 检查）
 * - kill：由玩家击杀 victimKind 实体计数（进度由击杀事件驱动）
 *
 * 完成（submit）效果：消耗任务物品（collect 型）+ 发奖励物品 + 好感增减
 * （好感对象为提交对话的 NPC kind，由 dialogueSystem 传入）。
 */

/** 任务提交效果：奖励物品 + 好感增减（缺省均无）。 */
export const QuestSubmitSchema = z.object({
  /** 提交奖励物品（kind 引用 item 目录）。 */
  rewards: z.array(z.object({ kind: z.string(), count: z.number().int().min(1) })).default([]),
  /** 提交后好感增减（对象=提交对话的 NPC kind）。 */
  relationDelta: z.number().default(0),
}).default({ rewards: [], relationDelta: 0 });

/** 单条任务定义（id 被对话效果 quest_accept/quest_submit 引用）。 */
export const QuestDefinitionSchema = z.object({
  /** 任务 id（对话效果 quest_accept/quest_submit 的 questId 引用）。 */
  id: z.string(),
  /** 目标形态：collect（收集物品）/ kill（击杀计数）。 */
  type: z.enum(["collect", "kill"]),
  /** 目标数量。 */
  goal: z.number().int().min(1),
  /** collect 型：目标物品 kind。 */
  itemKind: z.string().optional(),
  /** kill 型：目标实体 kind。 */
  victimKind: z.string().optional(),
  submit: QuestSubmitSchema,
});

/**
 * 任务注册表（game/quests/*.json 的根结构）：一组任务定义。
 */
export const QuestRegistrySchema = z.object({
  /** 任务定义列表。 */
  quests: z.array(QuestDefinitionSchema),
});

/** 任务定义的类型推断（即 game/quests/*.json 中的单个任务）。 */
export type QuestDefinitionJson = z.infer<typeof QuestDefinitionSchema>;
