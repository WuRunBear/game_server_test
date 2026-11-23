import { z } from "zod";

/**
 * 表现语义配置 schema（game/presentation/*.json）——地图、地面语义与实体
 * kind 的「表现层命名表」。
 *
 * 设计边界：
 * - 框架只做**结构校验与搬运**：`category` / `autotileGroup` / `footstepId` /
 *   `visualId` / `minimap.color` / `sceneId` 等全部是不透明字符串，含义由游戏
 *   与客户端约定，框架不解释；
 * - 数值 `tile id` 是 `MapGeometry.tiles` 的语义 id（Uint8Array），必须是
 *   0..255 的规范整数（record 键为十进制字符串，禁止 "01" / "1.5" / "-1"）；
 * - 支持「全局默认 + 每图覆盖」双层结构：全局 `tileSemantics` 描述同名语义的
 *   默认表现，`maps[mapId].tileSemantics` 只覆盖该图冲突的 id（同一个 id 在
 *   一张图是水、另一张图是墙时，各自用覆盖条目明确）；
 * - `entities` 按 archetype kind 给实体表现（展示名/分类/尺寸/锚点/不透明资源
 *   id/投影开关）；每份配置文件的 `tileSemantics` / `maps` / `entities` 都可
 *   缺省（缺省为空表），便于按关注点拆文件。
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

/** 实体表现尺寸（像素；与运行时 Size 组件同口径）。 */
export const EntitySizeSchema = z.object({
  /** 宽度（像素）。 */
  w: z.number().positive(),
  /** 高度（像素）。 */
  h: z.number().positive(),
});

/**
 * 实体锚点（归一化 0..1；世界坐标 = 实体位置 + 锚点偏移）。
 * 缺省底部中心 `{x:0.5, y:1}`——多数俯视/侧视贴图以脚底为原点。
 */
export const EntityAnchorSchema = z.object({
  /** 横向锚点（0=左，0.5=中心，1=右）。 */
  x: z.number().min(0).max(1).default(0.5),
  /** 纵向锚点（0=上，1=底）。 */
  y: z.number().min(0).max(1).default(1),
});

/**
 * 单个实体 kind 的表现条目。
 *
 * 所有 id 均为**不透明字符串**（visualId / animationSetId / audioSetId）：
 * 框架不解释，也不落贴图路径/图集坐标/动画帧——资源绑定归客户端。
 */
export const EntityPresentationSchema = z.object({
  /** 展示名（缺省由客户端回退 kind 原文）。 */
  displayName: z.string().min(1).optional(),
  /** 分类（不透明字符串，建议取 archetype tags 的小写名；框架不解释）。 */
  category: z.string().min(1).optional(),
  /** 尺寸（像素）；manifest 优先取 archetype 的 Size，此处用于无 Size 原型的兜底。 */
  size: EntitySizeSchema.optional(),
  /** 锚点（归一化 0..1；缺省底部中心）。 */
  anchor: EntityAnchorSchema.default({ x: 0.5, y: 1 }),
  /** 视觉资源引用（不透明字符串；缺省 = kind）。 */
  visualId: z.string().min(1).optional(),
  /** 动画集引用（不透明字符串；缺省 = kind）。 */
  animationSetId: z.string().min(1).optional(),
  /** 音频集引用（不透明字符串；缺省 = kind）。 */
  audioSetId: z.string().min(1).optional(),
  /** 是否绘制投影（生物类建议 true；缺省 false）。 */
  shadow: z.boolean().optional(),
});

/** 实体表现表：kind → 条目。 */
export const EntityPresentationTableSchema = z.record(z.string(), EntityPresentationSchema);

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

/** 表现配置根结构：全局语义表 + 每图条目 + 实体表现表。 */
export const PresentationConfigSchema = z.object({
  /** 全局默认地面语义表（键为规范整数字符串 id）。 */
  tileSemantics: TileSemanticsSchema.default({}),
  /** 每张地图的表现条目（键 = 地图 registry key）。 */
  maps: z.record(z.string(), MapPresentationSchema).default({}),
  /** 实体 kind → 表现条目（可选；旧游戏无实体表现层时缺省）。 */
  entities: EntityPresentationTableSchema.optional(),
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
/** 实体表现尺寸类型。 */
export type EntityPresentationSize = z.infer<typeof EntitySizeSchema>;
/** 实体锚点类型。 */
export type EntityPresentationAnchor = z.infer<typeof EntityAnchorSchema>;
/** 单个实体表现条目类型。 */
export type EntityPresentation = z.infer<typeof EntityPresentationSchema>;
/** 实体表现表类型。 */
export type EntityPresentationTable = z.infer<typeof EntityPresentationTableSchema>;
/** 单图表现条目类型。 */
export type MapPresentation = z.infer<typeof MapPresentationSchema>;
/** 表现配置根类型。 */
export type PresentationConfig = z.infer<typeof PresentationConfigSchema>;
