/**
 * 玩家/通用出生点选取（framework/map/runtime/spawn.ts）。
 *
 * pickSpawnPosition 按 spawn 规则三模式在 MapGeometry 上选一个落点
 * （返回 **像素坐标**——tile 中心，可直接写入 Transform）：
 * - random：可走候选池内独立随机（每玩家互不影响）；
 * - seededRandom：以地图内容指纹派生种子的确定性选点（同图同点）；
 * - exact：固定落点 at（tile 坐标）取中心，不做通行校验——静态落点的
 *   合法性由开机引用校验兜底（boot.ts U5）。
 *
 * 候选池：walkable=1 的 tile（声明 region 时再按 regionOf 过滤）。
 * 池为空（区域不存在/全不可走）时 random/seededRandom 返回 undefined，
 * 由调用方决定回退。
 */
import { regionOf, walkableAt } from "map/geometry/query";
import type { MapGeometry } from "map/geometry/types";

/** 出生点规则（与 PlayerRuleSchema 的 spawn 段结构对齐）。 */
export interface SpawnPointRule {
  /** 选点模式。 */
  mode: "random" | "seededRandom" | "exact";
  /** 限定区域（MapGeometry.regions 键；缺省全图）。 */
  region?: string;
  /** exact 固定落点（tile 坐标）。 */
  at?: { x: number; y: number };
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

/** mulberry32 确定性随机流（与 generate/rng.ts 同算法，独立轻量副本）。 */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** tile 索引 → 像素中心坐标。 */
function tileCenter(geometry: MapGeometry, index: number): { x: number; y: number } {
  const tx = index % geometry.grid.width;
  const ty = Math.floor(index / geometry.grid.width);
  return {
    x: (tx + 0.5) * geometry.grid.tileWidth,
    y: (ty + 0.5) * geometry.grid.tileHeight,
  };
}

/** 收集候选 tile 索引池（可走 + 可选区域过滤，行主序确定性顺序）。 */
function candidateTiles(geometry: MapGeometry, region: string | undefined): number[] {
  const pool: number[] = [];
  for (let i = 0; i < geometry.walkable.length; i++) {
    if (geometry.walkable[i] !== 1) continue;
    if (region !== undefined) {
      const tx = i % geometry.grid.width;
      const ty = Math.floor(i / geometry.grid.width);
      if (regionOf(geometry, tx, ty) !== region) continue;
    }
    pool.push(i);
  }
  return pool;
}

/**
 * 按 spawn 规则选取出生点（像素坐标，tile 中心）。
 *
 * @param geometry 地图几何
 * @param rule 出生规则
 * @returns 落点像素坐标；random/seededRandom 无候选时 undefined（exact 恒有值）
 */
export function pickSpawnPosition(
  geometry: MapGeometry,
  rule: SpawnPointRule,
): { x: number; y: number } | undefined {
  if (rule.mode === "exact") {
    const at = rule.at ?? { x: 0, y: 0 };
    return {
      x: (at.x + 0.5) * geometry.grid.tileWidth,
      y: (at.y + 0.5) * geometry.grid.tileHeight,
    };
  }

  const pool = candidateTiles(geometry, rule.region);
  if (pool.length === 0) return undefined;

  if (rule.mode === "seededRandom") {
    const rng = mulberry32(fnv1a32(geometry.version));
    return tileCenter(geometry, pool[Math.floor(rng() * pool.length)]);
  }
  return tileCenter(geometry, pool[Math.floor(Math.random() * pool.length)]);
}
