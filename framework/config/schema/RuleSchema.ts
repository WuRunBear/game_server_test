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
