import { z } from "zod";
import type { MapGenerationStep } from "map/generate/types";

/**
 * 地图注册表配置 schema（game/maps/registry.json）——新地图系统的配置入口。
 *
 * 注册表声明全部地图条目（maps，key = 地图 registry key）；默认地图由
 * game.json 的 map.default 声明（本清单不再重复 default 字段）。条目两类：
 * - kind = "pipeline"：生成积木管道——按声明顺序执行积木（generator 引用
 *   生成积木注册表），seed 派生各步骤独立随机流；initialAgeTicks 为开机
 *   初始演化跨度（世界从 0 演化到该时刻）。
 * - kind = "tiled"：Tiled 编辑器地图，path 指向的 JSON 在加载期（loadGameDefinition）
 *   内联进 tiled-source 积木参数——积木本身不做文件 I/O。
 *
 * 各积木的自有参数（params）框架不解释，原样透传给积木自行收窄校验。
 */

/** 管道单步骤：积木注册名 + 自有参数切片（透传）。 */
export const MapGenerationStepSchema = z.object({
  /** 积木注册名（生成积木注册表中的 id，如 "noise-terrain"）。 */
  generator: z.string(),
  /** 该步骤的自有参数切片（结构由各积木定义，框架不校验内部）。 */
  params: z.record(z.string(), z.unknown()).optional(),
});

/** 管道地图条目：seed + 初始演化跨度 + 积木管道。 */
export const PipelineMapEntrySchema = z.object({
  kind: z.literal("pipeline"),
  /** 随机种子（各管道步骤经 seed + 步骤序号派生独立流，同 seed 同产出）。 */
  seed: z.number(),
  /** 开机初始演化跨度（tick）：无档启动时该图从 0 演化到该时刻。 */
  initialAgeTicks: z.number().int().min(0),
  /** 生成积木管道（按声明顺序执行，至少一步）。 */
  pipeline: z.array(MapGenerationStepSchema).min(1),
});

/** Tiled 地图条目：path 指向的 Tiled JSON 在加载期内联。 */
export const TiledMapEntrySchema = z.object({
  kind: z.literal("tiled"),
  /** Tiled JSON 文件路径（相对本清单文件；缺文件/解析失败在加载期报错）。 */
  path: z.string(),
  /** 开机初始演化跨度（tiled 图通常为 0——静态地图无初始生态）。 */
  initialAgeTicks: z.number().int().min(0).default(0),
});

/** 地图条目判别联合：按 kind 字段区分 pipeline / tiled 两种条目。 */
export const MapEntrySchema = z.discriminatedUnion("kind", [
  PipelineMapEntrySchema,
  TiledMapEntrySchema,
]);

/**
 * 地图注册表根结构：maps 表（key = 地图 registry key）。
 * 默认地图由 game.json 的 map.default 声明，不在本清单重复。
 */
export const MapRegistrySchema = z.object({
  /** 全部地图条目表（key = 地图 registry key）。 */
  maps: z.record(z.string(), MapEntrySchema),
});

/** 地图注册表 JSON 的类型推断（即 game/maps/registry.json 根对象类型）。 */
export type MapRegistryJson = z.infer<typeof MapRegistrySchema>;
/** 管道地图条目的类型推断。 */
export type PipelineMapEntryJson = z.infer<typeof PipelineMapEntrySchema>;
/** Tiled 地图条目的类型推断。 */
export type TiledMapEntryJson = z.infer<typeof TiledMapEntrySchema>;

/**
 * 解析后的单图生成配置（loadGameDefinition 的 resolveMapConfigs 产出）：
 * 与生成层 MapGenerationConfig（key/seed/pipeline）结构对齐并附加
 * initialAgeTicks，可直接传给 buildMapGeometry。
 */
export interface MapConfig {
  /** 地图 key（registry 中的稳定标识，运行时命名空间键）。 */
  key: string;
  /** 随机种子。 */
  seed: number;
  /** 开机初始演化跨度（tick）。 */
  initialAgeTicks: number;
  /** 生成积木管道。 */
  pipeline: MapGenerationStep[];
}
