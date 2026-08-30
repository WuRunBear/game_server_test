/**
 * MapGeometry 快照序列化（framework/map/geometry/snapshot.ts）。
 *
 * MapGeometry 含类型化数组（Uint8Array/Uint16Array）与 Map，不能直接
 * JSON.stringify；本模块在「运行时几何 ↔ 纯 JSON 可序列化快照」间互转，
 * 供持久化落盘（WorldRecord.maps）与 /maps/runtime 响应使用。
 *
 * 纯函数：serialize 输出全新对象（不共享可变引用），serialize→deserialize
 * 往返与原值深相等（含 regions Map 与区域插入顺序）。
 */
import type { MapGeometry, MapGeometryGrid, RegionMeta } from "map/geometry/types";

/**
 * MapGeometry 的 JSON 可序列化快照形态。
 *
 * - 类型化数组编码为普通 number[]；
 * - regions Map 编码为普通对象（键为区域名；区域名为非数字字符串时
 *   JSON 往返保持插入顺序，即 regionOfTile 的索引序）。
 */
export interface SerializedMapGeometry {
  /** 地图 key。 */
  key: string;
  /** 网格信息。 */
  grid: MapGeometryGrid;
  /** 每格地面语义 id（number[] 形态）。 */
  tiles: number[];
  /** 每格通行位图（number[] 形态）。 */
  walkable: number[];
  /** 区域名 → 区域元信息（普通对象形态）。 */
  regions: Record<string, RegionMeta>;
  /** 每格所属区域索引（number[] 形态）。 */
  regionOfTile: number[];
  /** 内容指纹。 */
  version: string;
}

/**
 * 把运行时 MapGeometry 序列化为纯 JSON 可序列化快照。
 *
 * @param geometry 地图几何数据
 * @returns 全新快照对象（不与原几何共享可变引用）
 */
export function serializeGeometry(geometry: MapGeometry): SerializedMapGeometry {
  return {
    key: geometry.key,
    grid: { ...geometry.grid },
    tiles: Array.from(geometry.tiles),
    walkable: Array.from(geometry.walkable),
    regions: Object.fromEntries(geometry.regions),
    regionOfTile: Array.from(geometry.regionOfTile),
    version: geometry.version,
  };
}

/**
 * 把快照还原为运行时 MapGeometry。
 *
 * @param snapshot serializeGeometry 的产出（可经 JSON 往返）
 * @returns 与序列化前深相等的 MapGeometry（regions 复原为 Map）
 */
export function deserializeGeometry(snapshot: SerializedMapGeometry): MapGeometry {
  return {
    key: snapshot.key,
    grid: { ...snapshot.grid },
    tiles: Uint8Array.from(snapshot.tiles),
    walkable: Uint8Array.from(snapshot.walkable),
    regions: new Map(Object.entries(snapshot.regions)),
    regionOfTile: Uint16Array.from(snapshot.regionOfTile),
    version: snapshot.version,
  };
}
