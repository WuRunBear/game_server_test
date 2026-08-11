import { z } from "zod";

/**
 * 对话树配置 schema（game/dialogues/*.json）。
 *
 * 树 = 节点表 + 起始节点：每节点有展示文本与选项；选项可带效果
 * （接任务/交任务/好感增减——均引用 quest/relation 通用机制，不含游戏语义）
 * 与跳转目标（to；缺省或 "__end__" = 结束对话）。
 */

/**
 * 对话选项效果：选项被选中后执行的一次性副作用（失败则停留在当前节点）。
 * - quest_accept：接受任务（任务进入进行中）
 * - quest_submit：提交任务（校验完成条件，发放奖励）
 * - relation_delta：对指定 NPC kind 增减好感
 */
export const DialogueEffectSchema = z.union([
  z.object({ type: z.literal("quest_accept"), questId: z.string() }),
  z.object({ type: z.literal("quest_submit"), questId: z.string() }),
  z.object({ type: z.literal("relation_delta"), npcKind: z.string(), delta: z.number() }),
]);

/** 对话选项：展示文本 + 跳转目标 + 可选效果。 */
export const DialogueOptionSchema = z.object({
  /** 选项展示文本。 */
  label: z.string(),
  /** 跳转目标节点（缺省或 "__end__" = 结束对话）。 */
  to: z.string().optional(),
  /** 可选效果：推进前执行（失败则不推进，停留在当前节点）。 */
  effect: DialogueEffectSchema.optional(),
});

/** 对话节点：展示文本 + 选项列表。 */
export const DialogueNodeSchema = z.object({
  /** 节点展示文本。 */
  text: z.string(),
  /** 选项列表（空 = 无选项节点，客户端仅展示文本）。 */
  options: z.array(DialogueOptionSchema).default([]),
});

/** 单棵对话树：起始节点 + 节点表。 */
export const DialogueTreeSchema = z.object({
  /** 树 id（DialogueSource 组件 treeId 引用）。 */
  id: z.string(),
  /** 起始节点 id（缺省 "start"）。 */
  start: z.string().default("start"),
  /** 节点表：nodeId → 节点。 */
  nodes: z.record(z.string(), DialogueNodeSchema),
});

/** 对话树注册表（game/dialogues/*.json 的根结构）：一组对话树。 */
export const DialogueRegistrySchema = z.object({
  /** 对话树列表。 */
  trees: z.array(DialogueTreeSchema),
});

/** 对话树的类型推断（即 game/dialogues/*.json 中的单个树）。 */
export type DialogueTreeJson = z.infer<typeof DialogueTreeSchema>;
/** 对话节点的类型推断。 */
export type DialogueNodeJson = z.infer<typeof DialogueNodeSchema>;
/** 对话选项的类型推断。 */
export type DialogueOptionJson = z.infer<typeof DialogueOptionSchema>;
/** 对话效果的类型推断。 */
export type DialogueEffectJson = z.infer<typeof DialogueEffectSchema>;
