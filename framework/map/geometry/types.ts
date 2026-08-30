/**
 * MapGeometry 数据层类型定义（framework/map/geometry/types.ts）。
 *
 * MapGeometry 是**不可变的地理数据**：地形一次生成、永不改变（由生成层
 * 产出，本层只存取）。它只承载地理本身——地面语义、通行位图、区域划分，
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
 * 地图几何数据：新地图系统的不可变地理层。
 *
 * 约定：
 * - `tiles` / `walkable` / `regionOfTile` 均为按行主序展平的一维数组，
 *   长度 = grid.width × grid.height，索引 = y * width + x；
 * - `tiles` 每格存地面语义 id（纯数字——id→含义的命名映射表在 game 配置，
 *   框架只见数字）；
 * - `walkable` 每格 0/1（1=可通行）；由生成层写入，本层不推导；
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
  /** 区域名 → 区域元信息（插入顺序即 regionOfTile 的索引序）。 */
  regions: Map<string, RegionMeta>;
  /** 每格所属区域的索引（行主序展平，指向 regions 的插入顺序）。 */
  regionOfTile: Uint16Array;
  /** 内容指纹（对 grid/tiles/walkable/regions/regionOfTile 的哈希）。 */
  version: string;
}
