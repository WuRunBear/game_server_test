import { z } from "zod";

/**
 * 刷怪规则配置 schema（game/spawns/*.json）。
 *
 * 规则声明某 kind 实体在指定区域（zoneId）内的刷新：同时存活上限（max）、
 * 刷新间隔（respawnMs）与可选生效条件/地图限定。由 spawnSystem 读取执行，
 * 经 loadGameDefinition 的 loadSpawnsFile 校验加载。
 */

/**
 * 单条刷怪规则：
 * - kind：要刷出的实体原型 kind（引用 entities 目录）
 * - zoneId：刷怪区域编号（对应地图 zone 定义）
 * - max：该区域该 kind 的同时存活上限（到达上限后停止刷新）
 * - respawnMs：击杀/消耗后重新刷出的间隔（毫秒）
 * - condition / mapId：可选的生效条件与生效地图限定
 */
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

/**
 * 刷怪规则注册表（game/spawns/*.json 的根结构）：规则列表。
 */
export const SpawnRegistrySchema = z.object({
  /** 刷怪规则列表。 */
  rules: z.array(SpawnRuleSchema),
});

/** 单条刷怪规则的类型推断。 */
export type SpawnRuleJson = z.infer<typeof SpawnRuleSchema>;
