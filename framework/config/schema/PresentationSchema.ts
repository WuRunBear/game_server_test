import { z } from "zod";

/**
 * 表现语义配置 schema（game/presentation/*.json）——地图与地面语义 id 的
 * 「表现层命名表」。
 *
 * 设计边界：
 * - 框架只做**结构校验与搬运**：`category` / `autotileGroup` / `footstepId` /
 *   `visualId` / `minimap.color` / `sceneId` 等全部是不透明字符串，含义由游戏
 *   与客户端约定，框架不解释；
 * - 数值 `tile id` 是 `MapGeometry.tiles` 的语义 id（Uint8Array），必须是
 *   0..255 的规范整数（record 键为十进制字符串，禁止 "01" / "1.5" / "-1"）；
 * - 支持「全局默认 + 每图覆盖」双层结构：全局 `tileSemantics` 描述同名语义的
 *   默认表现，`maps[mapId].tileSemantics` 只覆盖该图冲突的 id（同一个 id 在
 *   一张图是水、另一张图是墙时，各自用覆盖条目明确）。
 *
 * 本文件只描述形状；查询/合并/完整性校验见 framework/content/presentation.ts。
 */

/** 地面语义 id（0..255 整数；tiles 缓冲为 Uint8Array）。 */
export const TileSemanticIdSchema = z.number().int().min(0).max(255);

/** 单个地面语义条目：名称必填，其余表现字段均为可选不透明引用。 */
export const TileSemanticSchema = z.object({
  /** 语义名（稳定标识，如 "deep_ocean"；客户端按此选图块）。 */
  name: z.string().min(1),
  /** 分类（不透明字符串，如 "water"/"terrain"；框架不解释）。 */
  category: z.string().min(1).optional(),
  /** 是否可通行（表现元数据；真实通行以 MapGeometry.walkable 为准）。 */
  walkable: z.boolean().optional(),
  /** 自动拼接组（不透明字符串，如 "water"；客户端自行解释）。 */
  autotileGroup: z.string().min(1).optional(),
  /** 脚步声/地表音效引用（不透明字符串）。 */
  footstepId: z.string().min(1).optional(),
  /** 视觉资源引用（不透明字符串；框架不落贴图路径/图集坐标）。 */
  visualId: z.string().min(1).optional(),
  /** 表现/规则说明（不透明文本；客户端可展示，框架不解释）。 */
  description: z.string().min(1).optional(),
  /** 小地图颜色（不透明字符串，如 "#182c60"；框架不解释格式）。 */
  minimapColor: z.string().min(1).optional(),
});

/** 地面语义表：规范整数字符串键 → 条目。 */
export const TileSemanticsSchema = z.record(z.string(), TileSemanticSchema).superRefine((table, ctx) => {
  for (const key of Object.keys(table)) {
    const id = Number(key);
    if (!Number.isInteger(id) || id < 0 || id > 255 || String(id) !== key) {
      ctx.addIssue({
        code: "custom",
        path: [key],
        message: `tile semantic key "${key}" must be a canonical integer id in [0, 255]`,
      });
    }
  }
});

/** 地图小地图表现（颜色/图标均为不透明字符串）。 */
export const MapMinimapSchema = z.object({
  /** 小地图底色（不透明字符串，如 "#3a6b4a"）。 */
  color: z.string().min(1).optional(),
  /** 小地图图标引用（不透明字符串）。 */
  icon: z.string().min(1).optional(),
});

/**
 * 地图间连接：只声明能从配置确定的去向与入口坐标。
 * `x`/`y` 为 tile 坐标（与 `entity-rules.json` 的 exact 落点一致）。
 */
export const MapConnectionSchema = z.object({
  /** 目标地图 key（必须存在于地图 registry）。 */
  to: z.string().min(1),
  /** 连接类型（不透明字符串，如 "portal"）。 */
  kind: z.string().min(1),
  /** 入口 tile x 坐标（可选；配置能确定时填写）。 */
  x: z.number().int().min(0).optional(),
  /** 入口 tile y 坐标（可选；配置能确定时填写）。 */
  y: z.number().int().min(0).optional(),
});

/** 层边界语义对（与 MapGeometry.levelSemantics 同形）。 */
export const PresentationLevelSemanticsSchema = z.object({
  /** slope 语义 id（±1 层过渡格，可走）。 */
  slope: TileSemanticIdSchema,
  /** cliff 语义 id（|Δlevel| ≥ 2 的边界带，不可走）。 */
  cliff: TileSemanticIdSchema,
});

/** 单张地图的表现条目。 */
export const MapPresentationSchema = z.object({
  /** 展示名（客户端 UI/小地图标题）。 */
  displayName: z.string().min(1),
  /** 场景引用（不透明字符串；框架不加载场景）。 */
  sceneId: z.string().min(1).optional(),
  /** 图块集引用（不透明字符串；不写贴图路径）。 */
  tilesetId: z.string().min(1).optional(),
  /** 环境氛围引用（不透明字符串）。 */
  ambientId: z.string().min(1).optional(),
  /** 音乐引用（不透明字符串）。 */
  musicId: z.string().min(1).optional(),
  /** 小地图表现。 */
  minimap: MapMinimapSchema.optional(),
  /** 地图连接（缺省 = 无已知连接；不要猜坐标）。 */
  connections: z.array(MapConnectionSchema).optional(),
  /** 该图的层边界语义（有 quantize-terrain 的图应与管道参数一致）。 */
  levelSemantics: PresentationLevelSemanticsSchema.optional(),
  /** 该图对全局地面语义的覆盖（同 id 覆盖全局条目）。 */
  tileSemantics: TileSemanticsSchema.optional(),
});

/** 表现配置根结构：全局语义表 + 每图条目。 */
export const PresentationConfigSchema = z.object({
  /** 全局默认地面语义表（键为规范整数字符串 id）。 */
  tileSemantics: TileSemanticsSchema.default({}),
  /** 每张地图的表现条目（键 = 地图 registry key）。 */
  maps: z.record(z.string(), MapPresentationSchema),
});

/** 地面语义条目类型。 */
export type TileSemanticSpec = z.infer<typeof TileSemanticSchema>;
/** 地面语义表类型。 */
export type TileSemanticsTable = z.infer<typeof TileSemanticsSchema>;
/** 小地图表现类型。 */
export type MapMinimapSpec = z.infer<typeof MapMinimapSchema>;
/** 地图连接类型。 */
export type MapConnectionSpec = z.infer<typeof MapConnectionSchema>;
/** 层边界语义对类型。 */
export type PresentationLevelSemantics = z.infer<typeof PresentationLevelSemanticsSchema>;
/** 单图表现条目类型。 */
export type MapPresentation = z.infer<typeof MapPresentationSchema>;
/** 表现配置根类型。 */
export type PresentationConfig = z.infer<typeof PresentationConfigSchema>;
