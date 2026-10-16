/**
 * MapGeometry 数据层类型定义（framework/map/geometry/types.ts）。
 *
 * MapGeometry 是**生成期产出、运行时受控修改**的地理数据：地形由生成层一次
 * 产出；设计上运行期修改只允许走统一的写回入口（原地改数组 + 重算 version
 * 指纹 + 失效重建碰撞缓存 + 脏格 diff 推送，见 docs/map-system-v2-design.md
 * §3.2——该入口尚未实现，本层先把表述与数据载体落准，当前写入方仍只有
 * 生成层）。它只承载地理本身——地面语义、通行位图、离散层号、区域划分，
 * 不含任何实体/出生点/建造物语义。
 *
 * 纯数据层：不 import bitecs/ECS/任何 world 类型。
 */

/**
 * 地图网格信息（tile 单位尺寸 + 单 tile 像素尺寸）。
 */
export interface MapGeometryGrid {
  /** 地图宽度（tile 数）。 */
  width: number;
  /** 地图高度（tile 数）。 */
  height: number;
  /** 单个 tile 的宽度（像素）。 */
  tileWidth: number;
  /** 单个 tile 的高度（像素）。 */
  tileHeight: number;
}

/**
 * 区域元信息（regions Map 的值）。
 *
 * 只含名称与自由元信息——**不含多边形坐标**：区域范围由 regionOfTile
 * 位图承载（哪些格属于本区域），此处不重复几何描述。
 */
export interface RegionMeta {
  /** 区域名称（与 regions Map 的键一致，便于快照/日志自描述）。 */
  name: string;
  /** 自由元信息（由配置/生成层决定含义，框架不解释）。 */
  meta: Record<string, unknown>;
}

/**
 * 层边界语义 id 对（framework 侧只存数字 id，含义命名映射在 game 配置）。
 *
 * 由量化类积木（quantize-terrain）在派生 slope/cliff 边界带时写入几何，
 * 供跨层移动与按层碰撞的运行时消费：
 * - slope：±1 层过渡格（可走，双向）；
 * - cliff：|Δlevel| ≥ 2 的边界带格（不可走；唯一例外是「自上而下单向可越」
 *   的跳下语义，见 walkableAtLevel）。
 */
export interface LevelSemantics {
  /** slope 语义 id（相邻层差 1 的边界带，可走）。 */
  slope: number;
  /** cliff 语义 id（相邻层差 ≥2 的边界带，不可走、可自上而下单向越过）。 */
  cliff: number;
}

/**
 * 地图几何数据：新地图系统的地理数据层。
 *
 * 约定：
 * - `tiles` / `walkable` / `level` / `regionOfTile` 均为按行主序展平的一维
 *   数组，长度 = grid.width × grid.height，索引 = y * width + x；
 * - `tiles` 每格存地面语义 id（纯数字——id→含义的命名映射表在 game 配置，
 *   框架只见数字）；
 * - `walkable` 每格 0/1（1=可通行）；由生成层写入，本层不推导；
 * - `level` 每格存离散层号（Int8 有符号——负层留给地下，0 = 地面基准层）；
 *   层是纯序数、没有物理高度（服务端只比大小/判相邻）；未分层地形全 0
 *   （flat）；
 * - `regions` 键为区域名，**插入顺序即区域索引序**：regionOfTile 每格存的
 *   数值是对该顺序的索引（0 = 第一个插入的区域，依此类推）；
 * - `version` 为内容指纹（见 geometry/version.ts），由生成层在冻结时计算。
 */
export interface MapGeometry {
  /** 地图 key（registry 中的稳定标识）。 */
  key: string;
  /** 网格信息。 */
  grid: MapGeometryGrid;
  /** 每格地面语义 id（行主序展平）。 */
  tiles: Uint8Array;
  /** 每格通行位图（行主序展平，1=可通行，0=不可通行）。 */
  walkable: Uint8Array;
  /** 每格离散层号（行主序展平，Int8 有符号，负层留给地下；flat 地形全 0）。 */
  level: Int8Array;
  /**
   * 层边界语义 id 对（可选——量化类积木派生 slope/cliff 带时写入；未量化
   * 的 flat 图缺省，缺省即无跨层语义：±1 过渡不可达、cliff 跳下不生效）。
   */
  levelSemantics?: LevelSemantics;
  /** 区域名 → 区域元信息（插入顺序即 regionOfTile 的索引序）。 */
  regions: Map<string, RegionMeta>;
  /** 每格所属区域的索引（行主序展平，指向 regions 的插入顺序）。 */
  regionOfTile: Uint16Array;
  /** 内容指纹（对 grid/tiles/walkable/level/regions/regionOfTile 的哈希）。 */
  version: string;
}
