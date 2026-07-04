import { z } from "zod";

export const SpawnRuleSchema = z.object({
  kind: z.string(),
  zoneId: z.number(),
  max: z.number(),
  respawnMs: z.number(),
});

export const SpawnRegistrySchema = z.object({
  rules: z.array(SpawnRuleSchema),
});

export type SpawnRuleJson = z.infer<typeof SpawnRuleSchema>;
