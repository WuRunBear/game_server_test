/**
 * 测试夹具：手工构建最小 MapGeometry（核心切换后 world.maps 的元素形态）。
 *
 * 供需要向 world.maps 注入测试图的用例使用：默认全可走 + 单一命名区域，
 * 可选 blocked 回调刻画阻挡格。内容指纹按真实算法计算，保证 version 字段
 * 与生产一致。
 */
import { computeGeometryVersion } from "map/geometry/version";
import type { MapGeometry } from "map/geometry/types";

export interface TestGeometryOptions {
  key?: string;
  width?: number;
  height?: number;
  tileWidth?: number;
  tileHeight?: number;
  /** 返回 true 的格为阻挡（walkable=0）；缺省全可走。 */
  blocked?: (tx: number, ty: number) => boolean;
  /** 区域名列表（插入序即 regionOfTile 索引序）；缺省 ["default"]。 */
  regions?: string[];
  /** 每格区域索引；缺省全 0（指向第一个区域）。 */
  regionOfTile?: (tx: number, ty: number) => number;
}

export function makeTestGeometry(options: TestGeometryOptions = {}): MapGeometry {
  const width = options.width ?? 32;
  const height = options.height ?? 32;
  const tileWidth = options.tileWidth ?? 16;
  const tileHeight = options.tileHeight ?? 16;
  const regionNames = options.regions ?? ["default"];

  const total = width * height;
  const tiles = new Uint8Array(total);
  const walkable = new Uint8Array(total);
  const regionOfTile = new Uint16Array(total);
  for (let ty = 0; ty < height; ty++) {
    for (let tx = 0; tx < width; tx++) {
      const index = ty * width + tx;
      walkable[index] = options.blocked?.(tx, ty) ? 0 : 1;
      regionOfTile[index] = options.regionOfTile?.(tx, ty) ?? 0;
    }
  }

  const geometry: MapGeometry = {
    key: options.key ?? "test-map",
    grid: { width, height, tileWidth, tileHeight },
    tiles,
    walkable,
    regions: new Map(regionNames.map((name) => [name, { name, meta: {} }])),
    regionOfTile,
    version: "",
  };
  geometry.version = computeGeometryVersion(geometry);
  return geometry;
}
