import { z } from "zod";

/**
 * 组件配置值可为对象（SoA 字段初值）或数组等任意结构（AoS 组件如 Needs/Inventory）。
 * AoS 组件的具体形态由组件自身的初始化钩子解读，schema 层不强制。
 */
const ComponentConfigSchema = z.unknown();

export const ArchetypeSchema = z.object({
  kind: z.string(),
  tags: z.array(z.string()).optional(),
  components: z.record(z.string(), ComponentConfigSchema),
  behavior: z.string().optional(),
  team: z.number().optional(),
});

export type ArchetypeSchemaJson = z.infer<typeof ArchetypeSchema>;
