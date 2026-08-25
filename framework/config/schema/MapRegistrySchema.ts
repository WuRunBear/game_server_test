import { z } from "zod";

/**
 * 地图注册表配置 schema（game/maps/registry.json）。
 *
 * 注册表声明默认地图（default）与全部地图条目（maps，key = mapId）：
 * - kind = "generated"：程序化生成地图，由生成器（generatorId）按随机种子/尺寸产出
 * - kind = "tiled"：Tiled 编辑器地图，从 path 指向的 JSON 文件加载瓦片数据
 *
 * 由 loadGameDefinition 校验加载；运行时的解析结果（MapSource）见 config/map.ts。
 */

/**
 * 程序化生成地图条目：生成器（generatorId）按随机种子与网格尺寸产出地图。
 */
export const GeneratedMapEntrySchema = z.object({
  /** 条目类型标记："generated" = 程序化生成。 */
  kind: z.literal("generated"),
  /** 地图生成器 id（缺省 "simple"）。 */
  generatorId: z.string().default("simple"),
  /** 地图 id（缺省取注册表键名）。 */
  id: z.string().optional(),
  /** 地图显示名（缺省取注册表键名）。 */
  name: z.string().optional(),
  /** 随机种子（同种子可复现相同地图）。 */
  seed: z.number().default(1),
  /** 网格宽（格数）。 */
  width: z.number().default(64),
  /** 网格高（格数）。 */
  height: z.number().default(64),
  /** 单格宽（像素）。 */
  tileWidth: z.number().default(16),
  /** 单格高（像素）。 */
  tileHeight: z.number().default(16),
  /** 程序生成时布置的 NPC 出生点列表（可选，相对玩家出生点偏移）。 */
  npcSpawns: z
    .array(
      z.object({
        /** NPC 类型 id（数据，由配置给出）。 */
        kind: z.string(),
        /** 相对玩家出生点的偏移，单位：[tileX, tileY]。 */
        offsetTiles: z.tuple([z.number(), z.number()]),
        /** 归属的地图区域 id（可选）。 */
        zoneId: z.number().optional(),
      }),
    )
    .optional(),
});

/**
 * Tiled 编辑器地图条目：从外部 JSON 文件加载静态瓦片地图。
 */
export const TiledMapEntrySchema = z.object({
  /** 条目类型标记："tiled" = 外部 Tiled JSON 文件。 */
  kind: z.literal("tiled"),
  /** Tiled JSON 文件路径（运行时读取并内联进 MapSource）。 */
  path: z.string(),
  /** 地图 id（缺省取注册表键名）。 */
  id: z.string().optional(),
  /** 地图显示名（缺省取注册表键名）。 */
  name: z.string().optional(),
});

/** 地图条目判别联合：按 kind 字段区分 generated / tiled 两种条目。 */
export const MapEntrySchema = z.discriminatedUnion("kind", [
  GeneratedMapEntrySchema,
  TiledMapEntrySchema,
]);

/**
 * 地图注册表根结构：
 * - default：默认地图 id（缺省取 maps 表首个条目）
 * - maps：mapId → 地图条目
 */
export const MapRegistrySchema = z.object({
  /** 默认地图 id。 */
  default: z.string().optional(),
  /** 全部地图条目表（key = mapId）。 */
  maps: z.record(z.string(), MapEntrySchema),
});

/** 地图注册表 JSON 的类型推断（即 game/maps/registry.json 根对象类型）。 */
export type MapRegistryJson = z.infer<typeof MapRegistrySchema>;
/** 程序化生成地图条目的类型推断。 */
export type GeneratedMapEntryJson = z.infer<typeof GeneratedMapEntrySchema>;
/** Tiled 地图条目的类型推断。 */
export type TiledMapEntryJson = z.infer<typeof TiledMapEntrySchema>;
