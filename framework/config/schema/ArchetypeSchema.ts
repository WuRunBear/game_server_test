import { z } from "zod";

/**
 * 实体原型（archetype）配置 schema（game/entities/*.json 数组元素）。
 *
 * archetype 是实体生成模板：声明 kind（唯一标识）、tags（bitecs 标签组件）、
 * components（组件初值）、behavior（AI 行为树引用）与 team。实体原型注册表
 * （archetypeRegistry）按此生成实体；加载与校验流程见 loadGameDefinition
 * （framework/bootstrap/loadGameDefinition.ts 的 loadArchetypesFiles）。
 */

/**
 * 组件配置值可为对象（SoA 字段初值）或数组等任意结构（AoS 组件如 Needs/Inventory）。
 * AoS 组件的具体形态由组件自身的初始化钩子解读，schema 层不强制。
 */
const ComponentConfigSchema = z.unknown();

/**
 * 单个实体原型定义：
 * - kind：原型唯一标识（刷怪/放置/查询等引用目标）
 * - tags：bitecs 标签组件名列表（用于查询过滤，如 netSync 按 tags 限定同步范围）
 * - components：组件初值表（组件名 → 初值；AoS 组件的初值形态由组件初始化钩子解读）
 * - behavior：AI 行为树配置 id（引用 game/behaviors/*.json）
 * - team：队伍编号（战斗归属判断用；缺省无队伍）
 */
export const ArchetypeSchema = z.object({
  kind: z.string(),
  tags: z.array(z.string()).optional(),
  components: z.record(z.string(), ComponentConfigSchema),
  behavior: z.string().optional(),
  team: z.number().optional(),
});

/** 实体原型配置的类型推断（即 game/entities/*.json 数组元素类型）。 */
export type ArchetypeSchemaJson = z.infer<typeof ArchetypeSchema>;
