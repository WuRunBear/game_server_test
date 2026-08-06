import { z } from "zod";

/**
 * 对话树配置 schema（game/dialogues/*.json）。
 *
 * 树 = 节点表 + 起始节点：每节点有展示文本与选项；选项可带效果
 * （接任务/交任务/好感增减——均引用 quest/relation 通用机制，不含游戏语义）
 * 与跳转目标（to；缺省或 "__end__" = 结束对话）。
 */

export const DialogueEffectSchema = z.union([
  z.object({ type: z.literal("quest_accept"), questId: z.string() }),
  z.object({ type: z.literal("quest_submit"), questId: z.string() }),
  z.object({ type: z.literal("relation_delta"), npcKind: z.string(), delta: z.number() }),
]);

export const DialogueOptionSchema = z.object({
  /** 选项展示文本。 */
  label: z.string(),
  /** 跳转目标节点（缺省或 "__end__" = 结束对话）。 */
  to: z.string().optional(),
  /** 可选效果：推进前执行（失败则不推进，停留在当前节点）。 */
  effect: DialogueEffectSchema.optional(),
});

export const DialogueNodeSchema = z.object({
  /** 节点展示文本。 */
  text: z.string(),
  /** 选项列表（空 = 无选项节点，客户端仅展示文本）。 */
  options: z.array(DialogueOptionSchema).default([]),
});

export const DialogueTreeSchema = z.object({
  /** 树 id（DialogueSource 组件 treeId 引用）。 */
  id: z.string(),
  /** 起始节点 id（缺省 "start"）。 */
  start: z.string().default("start"),
  /** 节点表：nodeId → 节点。 */
  nodes: z.record(z.string(), DialogueNodeSchema),
});

export const DialogueRegistrySchema = z.object({
  trees: z.array(DialogueTreeSchema),
});

export type DialogueTreeJson = z.infer<typeof DialogueTreeSchema>;
export type DialogueNodeJson = z.infer<typeof DialogueNodeSchema>;
export type DialogueOptionJson = z.infer<typeof DialogueOptionSchema>;
export type DialogueEffectJson = z.infer<typeof DialogueEffectSchema>;
