/**
 * MapGeometry 地理查询（framework/map/geometry/query.ts）。
 *
 * 纯函数、零依赖、零副作用：对不可变地理数据做按格查询。
 *
 * 坐标约定：x/y 为 **tile 坐标**（列/行，整数），像素→tile 的换算属于
 * 消费方（移动/碰撞系统），不在数据层做。
 *
 * 越界安全：所有查询对越界坐标返回安全值（false / undefined / 0），
 * 永不抛错。
 */
import type { MapGeometry } from "map/geometry/types";

/**
 * 区域名数组缓存（按 geometry 弱引用；MapGeometry 约定不可变，regions 的
 * 插入序即 regionOfTile 的索引序，故数组缓存与位图恒一致）。
 *
 * 供 regionOf 把「regions 键线性遍历」降为一次数组下标访问；本模块不向
 * geometry 写入任何数据（WeakMap 挂在模块侧，MapGeometry 保持冻结语义）。
 */
const regionNamesCache = new WeakMap<MapGeometry, string[]>();

/** 取 geometry 的区域名数组（下标 = regionOfTile 的区域索引），带缓存。 */
function regionNamesOf(geometry: MapGeometry): string[] {
  let names = regionNamesCache.get(geometry);
  if (!names) {
    names = [...geometry.regions.keys()];
    regionNamesCache.set(geometry, names);
  }
  return names;
}

/**
 * 把 tile 坐标换算为展平数组索引；越界返回 -1。
 *
 * 非整数/NaN 坐标虽通过范围检查，但后续类型化数组按此类索引取值恒为
 * undefined，各查询据此自然落到安全值，同样不抛错。
 */
function tileIndexOf(geometry: MapGeometry, x: number, y: number): number {
  const { width, height } = geometry.grid;
  if (x < 0 || y < 0 || x >= width || y >= height) return -1;
  return y * width + x;
}

/**
 * 查询 (x, y) 格是否可通行。
 *
 * @param geometry 地图几何数据
 * @param x tile 列坐标
 * @param y tile 行坐标
 * @returns 该格 walkable=1 时 true；越界/不可通行时 false
 */
export function walkableAt(geometry: MapGeometry, x: number, y: number): boolean {
  const index = tileIndexOf(geometry, x, y);
  return geometry.walkable[index] === 1;
}

/**
 * 查询 (x, y) 格在指定层号的通行性（按层视角，v2 地图切片 5）。
 *
 * 规则（前置修正 8 的有向语义，地形侧）：
 * - walkable=1 → 可通行（与层无关）；
 * - walkable=0 且该格是 cliff 语义格、且格层号 ≤ 查询层号 → **可自上而下
 *   单向越过**（跳下：站在高层的实体可以越过/落经低于自己的崖格；低层
 *   视角下同一格仍不可走，禁止低→高攀爬）；
 * - 其余 walkable=0 → 不可通行（原有 nonWalkable 语义在任何层都阻挡）。
 *
 * 无 levelSemantics 的图（未量化 flat 图）与 walkableAt 完全同判——现有
 * 图零回归。建造层（楼板/墙实体）的通行性在楼层建造切片并线（前置修正 3
 * 的完整 walkableAtLevel = 地形 OR 建造）。
 *
 * @param geometry 地图几何数据
 * @param x tile 列坐标
 * @param y tile 行坐标
 * @param level 查询视角的层号（实体所在层）
 * @returns 该格在该层视角下可通行时 true；越界时 false
 */
export function walkableAtLevel(geometry: MapGeometry, x: number, y: number, level: number): boolean {
  const index = tileIndexOf(geometry, x, y);
  if (index < 0) return false;
  if (geometry.walkable[index] === 1) return true;
  const semantics = geometry.levelSemantics;
  if (!semantics) return false;
  if (geometry.tiles[index] !== semantics.cliff) return false;
  return (geometry.level[index] ?? 0) <= level;
}

/**
 * 取地图几何出现过的全部离散层号（升序，带 WeakMap 缓存）。
 *
 * 供按层碰撞运行时枚举「每层一个碰撞世界」的层清单；MapGeometry 约定
 * 不可变（level 数组运行期只经写回入口改写并重算 version——届时调用方
 * 需自行重建几何对象使缓存失效），缓存与位图恒一致。
 *
 * @param geometry 地图几何数据
 * @returns 升序层号数组（flat 图为 [0]）
 */
export function distinctLevels(geometry: MapGeometry): number[] {
  let levels = distinctLevelsCache.get(geometry);
  if (!levels) {
    const seen = new Set<number>();
    for (let i = 0; i < geometry.level.length; i++) seen.add(geometry.level[i]);
    levels = seen.size === 0 ? [0] : [...seen].sort((a, b) => a - b);
    distinctLevelsCache.set(geometry, levels);
  }
  return levels;
}

/** distinctLevels 的按几何弱引用缓存（本模块不向 geometry 写入任何数据）。 */
const distinctLevelsCache = new WeakMap<MapGeometry, number[]>();

/**
 * 查询 (x, y) 格所属区域。
 *
 * regionOfTile 存的是 regions 插入顺序的索引，据此直查区域名数组
 * （数组经 WeakMap 按 geometry 缓存，避免每次线性遍历区域键）。
 *
 * @param geometry 地图几何数据
 * @param x tile 列坐标
 * @param y tile 行坐标
 * @returns 区域名；越界 / 索引未落到任何已注册区域时 undefined
 */
export function regionOf(geometry: MapGeometry, x: number, y: number): string | undefined {
  const index = tileIndexOf(geometry, x, y);
  if (index < 0) return undefined;
  const regionIndex = geometry.regionOfTile[index] ?? -1;
  // 负值/越界索引在数组下标访问下自然得到 undefined，与线性遍历同判
  return regionNamesOf(geometry)[regionIndex];
}

/**
 * 查询 (x, y) 格的地面语义 id。
 *
 * @param geometry 地图几何数据
 * @param x tile 列坐标
 * @param y tile 行坐标
 * @returns 该格地面语义 id；越界时 0
 */
export function tileAt(geometry: MapGeometry, x: number, y: number): number {
  const index = tileIndexOf(geometry, x, y);
  return geometry.tiles[index] ?? 0;
}

/**
 * 查询 (x, y) 格的离散层号。
 *
 * 层是纯序数（0 = 地面基准层，负层为地下预留），没有物理高度；跨层判定
 * 由消费方（移动/碰撞/视线）按「比大小 + 判相邻」组合本查询实现。
 *
 * @param geometry 地图几何数据
 * @param x tile 列坐标
 * @param y tile 行坐标
 * @returns 该格 level；越界时 0
 */
export function levelAt(geometry: MapGeometry, x: number, y: number): number {
  const index = tileIndexOf(geometry, x, y);
  return geometry.level[index] ?? 0;
}
