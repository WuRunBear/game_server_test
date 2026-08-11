import { z } from "zod";

/**
 * AI 行为树配置 schema（game/behaviors/*.json 数组元素）。
 *
 * behavior 描述实体的自主行为（决策/动作组合），definition 为不透明载荷：
 * schema 层只校验外壳（id + definition 存在），行为树内部结构由行为树运行时
 * 按 id 解析执行，动作/条件名由动作注册表解读（加载时经 validateIntegrity
 * 校验引用的动作均已注册）。
 */
export const BehaviorSchema = z.object({
  /** 行为树 id（被实体原型的 behavior 字段引用）。 */
  id: z.string(),
  /** 行为树定义（树节点结构等，schema 层不校验内部）。 */
  definition: z.unknown(),
});

/** 行为树配置的类型推断（即 game/behaviors/*.json 数组元素类型）。 */
export type BehaviorSchemaJson = z.infer<typeof BehaviorSchema>;
