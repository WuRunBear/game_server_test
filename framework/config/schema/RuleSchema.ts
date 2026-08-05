import { z } from "zod";

export const CombatRuleSchema = z.object({
  friendlyFire: z.boolean().optional(),
  damageFormula: z.string().optional(),
  damageFormulaRef: z.string().optional(),
  attackCooldownMs: z.number().optional(),
  attackRange: z.number().optional(),
}).passthrough();

export type CombatRule = z.infer<typeof CombatRuleSchema>;

/**
 * Needs 全局规则：作用于 needDecaySystem 的衰减倍率。
 *
 * 每个 Need 自身的 decayPerSec/starveDmg 仍在实体 archetype 的 Needs 数组里声明，
 * 规则文件只放跨实体的全局调节项（衰减倍率）。游戏无关。
 */
export const NeedsRuleSchema = z.object({
  decayScale: z.number().optional(),
}).passthrough();

export type NeedsRule = z.infer<typeof NeedsRuleSchema>;

/**
 * 合成配方：inputs 消耗 → outputs 产出。
 *
 * - `stationType`：需要的站点类型编号（缺省 0 = 通用手搓，无需站点）；
 *   非 0 时要求合成者在 stationRange 内有匹配类型的 CraftingStation
 * - `inputs` / `outputs`：kind 字符串引用 item 表 + 数量
 *
 * 字段名保持游戏无关（kind/stationType 皆为通用机制词）。
 */
const RecipeInputSchema = z.object({
  kind: z.string(),
  count: z.number().int().positive(),
});

const RecipeSchema = z.object({
  id: z.string(),
  stationType: z.number().int().nonnegative().optional(),
  inputs: z.array(RecipeInputSchema).min(1),
  outputs: z.array(RecipeInputSchema).min(1),
});

export const CraftingRuleSchema = z.object({
  recipes: z.array(RecipeSchema).optional(),
  stationRange: z.number().positive().optional(),
}).passthrough();

export type CraftingRecipe = z.infer<typeof RecipeSchema>;
export type CraftingRule = z.infer<typeof CraftingRuleSchema>;

/**
 * 昼夜循环全局规则：作用于 dayNightCycleSystem。
 *
 * - `cycleLengthSec`：一个昼夜完整周期（小时 0→24）的时长（秒）
 * - `nightStartHour` / `nightEndHour`：夜晚区间（缺省 19 / 5，支持跨午夜）
 *
 * 相位相位编号（PHASE_DAY/PHASE_NIGHT）与小时推进均游戏无关。
 */
export const DayNightRuleSchema = z.object({
  cycleLengthSec: z.number().positive(),
  nightStartHour: z.number().min(0).max(24).optional(),
  nightEndHour: z.number().min(0).max(24).optional(),
}).passthrough();

export type DayNightRule = z.infer<typeof DayNightRuleSchema>;
