/**
 * MapGeometry 内容指纹（framework/map/geometry/version.ts）。
 *
 * 迁移自 framework/map/version.ts 的 fnv1a32 + computeMapVersion 思路：
 * 对几何内容构造固定键序的规范化对象，对其 JSON.stringify 结果的 UTF-8
 * 字节流做 FNV-1a 32 位哈希，输出 8 位小写十六进制。
 *
 * 纯函数、零依赖、零副作用；同内容恒定、任一内容字段变化即变，
 * 客户端/存档可作 {key, version} 缓存键。
 */
import type { MapGeometry } from "map/geometry/types";

/**
 * 参与内容指纹计算的几何字段（即 MapGeometry 去掉 version）。
 *
 * key 不参与：指纹是**内容**指纹，同内容不同 key 的图哈希一致，
 * 身份（key）与内容（version）正交。传入完整 MapGeometry 亦可
 * （version 字段被类型层面排除在计算输入之外）。
 */
export type GeometryVersionInput = Omit<MapGeometry, "version">;

/**
 * FNV-1a 32 位哈希（返回 8 位小写十六进制字符串）。
 *
 * 与 framework/map/version.ts 同款实现（原函数为模块私有，无法复用导入）。
 *
 * @param bytes 字节流
 * @returns 8 位小写十六进制（如 "a1b2c3d4"）
 */
function fnv1a32Hex(bytes: Uint8Array): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < bytes.length; i++) {
    hash ^= bytes[i] ?? 0;
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

/**
 * 计算 MapGeometry 的内容版本（内容哈希）。
 *
 * 规范序列化布局（JSDoc 即契约）：先构造固定键序的规范化对象，再对其
 * JSON.stringify 结果的 UTF-8 字节流做 FNV-1a 32 位哈希。规范化对象形状：
 *
 * ```
 * {
 *   grid: { width, height, tileWidth, tileHeight },
 *   tiles: [语义id, ...],        // 行主序展平
 *   walkable: [0|1, ...],        // 行主序展平
 *   regions: [{ key, name, meta }, ...],  // Map 插入顺序（即 regionOfTile 索引序）
 *   regionOfTile: [区域索引, ...],         // 行主序展平
 * }
 * ```
 *
 * 说明：
 * - regions 以条目数组（插入顺序）参与序列化——插入顺序决定 regionOfTile
 *   的解释，属于内容的一部分，顺序变化即版本变化；
 * - key 与 version 不参与（见 GeometryVersionInput）；
 * - 选择 JSON.stringify 而非手工字节拼接，理由同旧 computeMapVersion：
 *   规范对象形状直观可审计，键序在本函数内显式固定。
 *
 * @param geometry 地图几何内容（含 version 的完整 MapGeometry 亦可，version 被忽略）
 * @returns 8 位小写十六进制内容哈希
 */
export function computeGeometryVersion(geometry: GeometryVersionInput): string {
  const canonical = {
    grid: {
      width: geometry.grid.width,
      height: geometry.grid.height,
      tileWidth: geometry.grid.tileWidth,
      tileHeight: geometry.grid.tileHeight,
    },
    tiles: Array.from(geometry.tiles),
    walkable: Array.from(geometry.walkable),
    regions: Array.from(geometry.regions.entries()).map(([key, meta]) => ({
      key,
      name: meta.name,
      meta: meta.meta,
    })),
    regionOfTile: Array.from(geometry.regionOfTile),
  };

  return fnv1a32Hex(new TextEncoder().encode(JSON.stringify(canonical)));
}
