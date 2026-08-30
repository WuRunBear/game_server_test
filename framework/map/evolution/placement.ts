/**
 * 确定性选点（framework/map/evolution/placement.ts）。
 *
 * 候选点序列是 (seed, mapKey, ruleId, timeSlot) 的**纯函数**：四值经 FNV-1a 32
 * （与 geometry/version.ts 同款常量与算法）派生 32 位流种子，再经
 * generate/rng.ts 的 mulberry32 流在区域 tile 池（行主序，确定性顺序）上采样。
 * 同四参数跨运行/跨实例恒产生同一候选序列（U4）。
 *
 * 占用状态只**过滤**候选（pickPoint 取第一个通过合法性检查的候选），
 * 永不改变候选序列本身。合法性 = walkableAt（map/geometry/query）且未被占用
 * （回调注入）；区域归属由构造保证（候选只从区域 tile 池采样）。
 *
 * 单次放置至多尝试 PLACEMENT_MAX_ATTEMPTS 个候选，耗尽即放弃本次放置
 * （区域饱和时不会死循环）。
 */
import { createRng } from "map/generate/rng";
import { walkableAt } from "map/geometry/query";
import type { MapGeometry } from "map/geometry/types";

/** 单次放置的候选尝试硬上限。 */
export const PLACEMENT_MAX_ATTEMPTS = 32;

/** 候选/落点（tile 坐标）。 */
export interface PlacementPoint {
  x: number;
  y: number;
}

/** FNV-1a 32 位哈希（与 geometry/version.ts 同款常量与算法）。 */
function fnv1a32(source: string): number {
  const bytes = new TextEncoder().encode(source);
  let hash = 0x811c9dc5;
  for (let i = 0; i < bytes.length; i++) {
    hash ^= bytes[i];
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/**
 * 从 (seed, mapKey, ruleId, timeSlot) 派生 32 位选点流种子。
 *
 * 纯函数：同四参数恒同种子。字段间以 NUL 分隔，防拼接歧义
 * （("ab","c") 与 ("a","bc") 派生不同）。
 */
export function derivePlacementSeed(seed: number, mapKey: string, ruleId: string, timeSlot: number): number {
  return fnv1a32(`${seed}\u0000${mapKey}\u0000${ruleId}\u0000${timeSlot}`);
}

/** 求区域在 regions 插入序中的索引（即 regionOfTile 的取值）；未注册区域返回 -1。 */
function regionIndexOf(geometry: MapGeometry, region: string): number {
  let cursor = 0;
  for (const name of geometry.regions.keys()) {
    if (name === region) return cursor;
    cursor += 1;
  }
  return -1;
}

/** 收集区域全部 tile 索引（行主序 = 确定性顺序）；区域未注册或无格返回 []。 */
function regionTiles(geometry: MapGeometry, region: string): number[] {
  const regionIndex = regionIndexOf(geometry, region);
  const tiles: number[] = [];
  if (regionIndex < 0) return tiles;
  for (let i = 0; i < geometry.regionOfTile.length; i++) {
    if (geometry.regionOfTile[i] === regionIndex) tiles.push(i);
  }
  return tiles;
}

/**
 * 生成某 (ruleId, timeSlot) 的确定性候选点序列（至多 PLACEMENT_MAX_ATTEMPTS 个）。
 *
 * 纯函数：同参数恒同序列；不读占用、不做合法性过滤（过滤归 pickPoint）。
 * 区域未注册或无格时返回空序列（本次放置必然放弃）。
 */
export function placementCandidates(
  geometry: MapGeometry,
  region: string,
  ruleId: string,
  timeSlot: number,
  seed: number,
): PlacementPoint[] {
  const pool = regionTiles(geometry, region);
  const candidates: PlacementPoint[] = [];
  if (pool.length === 0) return candidates;

  const rng = createRng(derivePlacementSeed(seed, geometry.key, ruleId, timeSlot));
  for (let attempt = 0; attempt < PLACEMENT_MAX_ATTEMPTS; attempt++) {
    const tileIndex = pool[rng.int(pool.length)];
    candidates.push({
      x: tileIndex % geometry.grid.width,
      y: Math.floor(tileIndex / geometry.grid.width),
    });
  }
  return candidates;
}

/**
 * 从候选序列中取第一个合法落点（可走且未被占用）；候选耗尽返回 undefined。
 *
 * 占用回调只过滤候选，不改变候选序列（U4）：被占用的候选被跳过，
 * 后续候选仍按同一序列依次尝试。
 */
export function pickPoint(
  geometry: MapGeometry,
  region: string,
  ruleId: string,
  timeSlot: number,
  seed: number,
  isOccupied: (x: number, y: number) => boolean,
): PlacementPoint | undefined {
  for (const candidate of placementCandidates(geometry, region, ruleId, timeSlot, seed)) {
    if (walkableAt(geometry, candidate.x, candidate.y) && !isOccupied(candidate.x, candidate.y)) {
      return candidate;
    }
  }
  return undefined;
}
