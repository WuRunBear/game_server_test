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
  /**
   * 可选：限定生效的地图 id（maps/registry.json 的 maps 键）。
   * 缺省全部地图生效；portal 场景切换后 world.map 变化，规则随之切换作用图。
   */
  mapId: z.string().optional(),
});

export const SpawnRegistrySchema = z.object({
  rules: z.array(SpawnRuleSchema),
});

export type SpawnRuleJson = z.infer<typeof SpawnRuleSchema>;
