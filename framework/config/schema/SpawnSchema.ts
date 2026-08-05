import { z } from "zod";

export const SpawnRuleSchema = z.object({
  kind: z.string(),
  zoneId: z.number(),
  max: z.number(),
  respawnMs: z.number(),
  /**
   * 可选：刷怪条件（引用 spawnConditions 注册表，如 "isNight"）。
   * 缺省无条件——规则按计时器恒定生效。
   */
  condition: z.string().optional(),
});

export const SpawnRegistrySchema = z.object({
  rules: z.array(SpawnRuleSchema),
});

export type SpawnRuleJson = z.infer<typeof SpawnRuleSchema>;
