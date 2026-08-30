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
 * 查询 (x, y) 格所属区域。
 *
 * regionOfTile 存的是 regions 插入顺序的索引，此处按序遍历区域名解析。
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

  let cursor = 0;
  for (const name of geometry.regions.keys()) {
    if (cursor === regionIndex) return name;
    cursor += 1;
  }
  return undefined;
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
