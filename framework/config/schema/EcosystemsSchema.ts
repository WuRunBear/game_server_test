import { z } from "zod";

/**
 * 生态声明层配置 schema（game/ecosystems.json）——B1 编译器模式
 * （map-system 设计 §5.5）。
 *
 * 生物分布（density 类）按 biome（= MapGeometry.regions 键）聚合声明；
 * bootMaps 在每图几何就绪后、evolve 之前展开为标准 EntityRule 与静态规则
 * 合并（展开器见 map/evolution/ecosystems.ts）。exact/template 结构规则
 * （portal/建筑组）与 biome 概念不契合，留在 entity-rules.json 不入本表。
 *
 * spawnTable 条目为「密度式 | 显式式」二选一（结构互斥，走 strict 校验）：
 * - 密度式 `{ kind, density, every? }`：max 由展开器按区域面积推导
 *   （max = floor(area × density)）；
 * - 显式式 `{ kind, max, every, condition? }`：原样展开。
 *
 * 未知字段一律拒绝（strictObject）——拼写错误在加载期 fail-fast，而非静默
 * 丢字段。
 */

/**
 * 密度式条目：区域内确定性选点补足到 max = floor(area × density)。
 *
 * every 缺省 20 tick——当前配置的主导补足周期（world tick 20tps 下的现行
 * 节奏），展开器按 DEFAULT_EVERY 兜底；显式覆盖请声明 every 字段。
 */
export const DensitySpawnEntrySchema = z.strictObject({
  /** 计数与补足的实体原型 kind。 */
  kind: z.string(),
  /** 目标密度：(0, 1] 区间；max = floor(区域面积 × density)。 */
  density: z.number().gt(0).lte(1),
  /** 补足周期（tick 数）；缺省 20（见本条目注释）。 */
  every: z.number().int().min(1).optional(),
});

/** 显式式条目：max/every/condition 原样展开为 density 模式 EntityRule。 */
export const ExplicitSpawnEntrySchema = z.strictObject({
  /** 计数与补足的实体原型 kind。 */
  kind: z.string(),
  /** 数量上限（区域内该 kind 实体数封顶）。 */
  max: z.number().int().min(0),
  /** 补足周期（tick 数），必填。 */
  every: z.number().int().min(1),
  /** 可选门控条件名（spawnConditions 注册表）。 */
  condition: z.string().optional(),
});

/** spawnTable 条目：密度式 | 显式式判别联合（结构互斥，二者字段不兼容）。 */
export const SpawnEntrySchema = z.union([DensitySpawnEntrySchema, ExplicitSpawnEntrySchema]);

/** 单个生态条目：一个 biome 的物种表（一个 biome 可匹配多张地图）。 */
export const EcosystemEntrySchema = z.strictObject({
  /** 对应 MapGeometry.regions 键（非空；须至少落在一张配置图的区域集合内）。 */
  biome: z.string().min(1),
  /** 区域×物种表（密度式 / 显式式条目，可混排）。 */
  spawnTable: z.array(SpawnEntrySchema),
});

/** 生态声明层根结构（game/ecosystems.json）。 */
export const EcosystemsSchema = z.strictObject({
  /** 生态条目表（每条一个 biome）。 */
  ecosystems: z.array(EcosystemEntrySchema),
});

/** 生态声明层 JSON 的类型推断（即 game/ecosystems.json 根对象类型）。 */
export type EcosystemsJson = z.infer<typeof EcosystemsSchema>;
/** 单个生态条目（biome + spawnTable）。 */
export type EcosystemEntry = z.infer<typeof EcosystemEntrySchema>;
/** spawnTable 条目（密度式 | 显式式）。 */
export type SpawnEntry = z.infer<typeof SpawnEntrySchema>;
/** 密度式条目。 */
export type DensitySpawnEntry = z.infer<typeof DensitySpawnEntrySchema>;
/** 显式式条目。 */
export type ExplicitSpawnEntry = z.infer<typeof ExplicitSpawnEntrySchema>;
