/**
 * 地图模块的基础类型定义。
 *
 * 这些类型用于：
 * - 构建地图运行时数据（MapRuntime）
 * - 描述出生点、区域、多边形等地图信息
 * - 统一“地图来源”（Tiled 导入/程序生成）的输入结构
 */
export interface Vec2 {
  /**
   * X 坐标（世界坐标）。
   */
  x: number;
  /**
   * Y 坐标（世界坐标）。
   */
  y: number;
}

/**
 * 地图网格信息（以 tile 为单位的尺寸 + 单个 tile 的像素尺寸）。
 */
export interface MapGrid {
  /**
   * 地图宽度（tile 数）。
   */
  width: number;
  /**
   * 地图高度（tile 数）。
   */
  height: number;
  /**
   * 单个 tile 的宽度（像素）。
   */
  tileWidth: number;
  /**
   * 单个 tile 的高度（像素）。
   */
  tileHeight: number;
}

/**
 * 地图中的一个区域（Zone），通常用于触发、刷怪、归属等逻辑。
 */
export interface MapZone {
  /**
   * 区域 id（来自地图编辑器属性或生成逻辑）。
   */
  id: number;
  /**
   * 区域名称（用于调试与展示）。
   */
  name: string;
  /**
   * 区域多边形顶点（世界坐标，顺序按编辑器/生成逻辑给出）。
   */
  polygon: Vec2[];
}

/**
 * 地图出生点集合。
 */
export interface MapSpawns {
  /**
   * 玩家出生点；不存在则为 null。
   */
  player: Vec2 | null;
  /**
   * NPC 出生点列表。
   */
  npcs: Array<{ kind: string; pos: Vec2; zoneId?: number }>;
}

/**
 * 地图运行时数据：系统运行时实际依赖的地图结构。
 */
export interface MapRuntime {
  /**
   * 地图 id（稳定标识）。
   */
  id: string;
  /**
   * 地图名称（用于展示/调试）。
   */
  name: string;
  /**
   * 网格信息。
   */
  grid: MapGrid;
  /**
   * 阻挡网格（按 width*height 展平的一维数组；0=可走，1=阻挡）。
   */
  blocked: Uint8Array;
  /**
   * 出生点信息。
   */
  spawns: MapSpawns;
  /**
   * 区域列表。
   */
  zones: MapZone[];
}

/**
 * NPC 出生点配置项（游戏无关）：声明一个 NPC 出生点相对玩家出生点的偏移。
 *
 * 语义：kind 由配置（数据）给出，框架不硬编码任何 NPC 类型；
 * `offsetTiles` 是相对玩家出生点（地图中心）、以 tile 为单位的偏移；
 * `zoneId` 可选，用于把 NPC 出生点归属到某个地图区域。
 */
export interface NpcSpawnSpec {
  /**
   * NPC 类型 id（由配置给出，框架只透传）。
   */
  kind: string;
  /**
   * 相对玩家出生点（地图中心）的偏移，单位：[tileX, tileY]。
   */
  offsetTiles: [number, number];
  /**
   * 归属的地图区域 id（可选）。
   */
  zoneId?: number;
}

/**
 * 程序生成地图的来源描述。
 */
export interface GeneratedMapSource {
  /**
   * 来源类型：程序生成。
   */
  kind: "generated";
  /**
   * 生成器 id（用于选择具体生成算法）。
   */
  generatorId: string;
  /**
   * 地图 id（稳定标识）。
   */
  id: string;
  /**
   * 地图名称。
   */
  name: string;
  /**
   * 随机种子。
   */
  seed: number;
  /**
   * 地图宽度（tile 数）。
   */
  width: number;
  /**
   * 地图高度（tile 数）。
   */
  height: number;
  /**
   * 单个 tile 的宽度（像素）。
   */
  tileWidth: number;
  /**
   * 单个 tile 的高度（像素）。
   */
  tileHeight: number;
  /**
   * 可选：程序生成时布置的 NPC 出生点列表（相对玩家出生点偏移）。
   * 缺省时不生成任何 NPC 出生点。
   */
  npcSpawns?: NpcSpawnSpec[];
}

/**
 * 从 Tiled 导出的地图（JSON）来源描述。
 */
export interface TiledMapSource {
  /**
   * 来源类型：Tiled 导入。
   */
  kind: "tiled";
  /**
   * 地图 id（稳定标识）。
   */
  id: string;
  /**
   * 地图名称。
   */
  name: string;
  /**
   * Tiled 导出的 JSON 原始内容（未经校验的 unknown）。
   */
  json: unknown;
}

/**
 * 地图来源：程序生成 or Tiled 导入。
 */
export type MapSource = GeneratedMapSource | TiledMapSource;
