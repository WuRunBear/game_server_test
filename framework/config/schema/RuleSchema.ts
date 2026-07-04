import { z } from "zod";

export const CombatRuleSchema = z.object({
  friendlyFire: z.boolean().optional(),
  damageFormula: z.string().optional(),
  damageFormulaRef: z.string().optional(),
  attackCooldownMs: z.number().optional(),
}).passthrough();

export type CombatRule = z.infer<typeof CombatRuleSchema>;
