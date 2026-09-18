/**
 * 生态声明层展开器（framework/map/evolution/ecosystems.ts）——B1 编译器
 * 模式（map-system 设计 §5.5）。
 *
 * 把 ecosystems.json 的 biome 聚合声明展开为标准 EntityRule：每图几何就绪
 * 后（bootMaps 内、evolve 之前）调用，条目 biome ∈ 该图 regions 才展开，
 * 否则跳过（一个 biome 可匹配多张图——每图各自展开一份，density 的 max 按
 * **该图**区域面积推导）。产物只进内存不落盘，本函数是纯函数：同输入恒同
 * 输出（区域面积由 regionOfTile 位图统计，选点流的确定性归 placement.ts）。
 *
 * 展开形态：统一展开为 density 模式规则（exact/template 结构规则与 biome
 * 概念不契合，留在 entity-rules.json）。密度式 max = floor(area × density)；
 * 显式式条目原样透传。区域面积 = regionOfTile 中该区域索引的**可走**格数
 * （区域索引 = regions Map 插入序，与 placement.ts 的 regionTiles 同一约定）。
 */
import type { MapGeometry } from "map/geometry/types";
import type { EntityRule } from "map/evolution/schema";
import type { EcosystemEntry, SpawnEntry } from "framework/config/schema/EcosystemsSchema";

/** 密度式条目的缺省补足周期（tick）：当前配置的主导节奏（见 EcosystemsSchema）。 */
export const DEFAULT_DENSITY_EVERY = 20;

/**
 * 统计区域的**可走** tile 数（有效生态面积）。
 *
 * regionOfTile 每格存 regions 插入序索引——先定位区域索引，再全图计数。
 * 区域覆盖全图（含洋面等不可走格），而密度spawn的候选经 canPlace 只落在
 * 可走格上——面积按 walkable=1 的格数计，否则 density 推导的 max 会被
 * 不可走格稀释膨胀。区域未注册返回 0（boot 分支下 biome 已由 regions.has
 * 过滤，此处兜底）。
 */
function regionAreaOf(geometry: MapGeometry, region: string): number {
  let index = 0;
  let regionIndex = -1;
  for (const name of geometry.regions.keys()) {
    if (name === region) {
      regionIndex = index;
      break;
    }
    index += 1;
  }
  if (regionIndex < 0) return 0;
  let count = 0;
  for (let i = 0; i < geometry.regionOfTile.length; i++) {
    if (geometry.regionOfTile[i] === regionIndex && geometry.walkable[i] === 1) count += 1;
  }
  return count;
}

/** 展开单条 spawnTable 条目为该图该 biome 的 density 规则。 */
function expandEntry(mapKey: string, biome: string, entry: SpawnEntry, area: number): EntityRule {
  if ("density" in entry) {
    return {
      mode: "density",
      map: mapKey,
      region: biome,
      kind: entry.kind,
      max: Math.floor(area * entry.density),
      every: entry.every ?? DEFAULT_DENSITY_EVERY,
    };
  }
  const rule: EntityRule = {
    mode: "density",
    map: mapKey,
    region: biome,
    kind: entry.kind,
    max: entry.max,
    every: entry.every,
  };
  if (entry.condition !== undefined) rule.condition = entry.condition;
  return rule;
}

/**
 * 把生态条目展开为单张地图的 EntityRule 数组（纯函数）。
 *
 * @param mapKey 目标地图 key（展开产物 rule.map 的取值）
 * @param geometry 该图**已就绪**的几何（快照回填或新生成均可——都带 regions）
 * @param ecosystems 生态条目表（ecosystems.json 解析结果；未配置传空数组）
 * @returns 展开产物（biome 不在本图的条目整体跳过；条目数组序 = 规则序）
 */
export function expandEcosystemsForMap(
  mapKey: string,
  geometry: MapGeometry,
  ecosystems: readonly EcosystemEntry[],
): EntityRule[] {
  const rules: EntityRule[] = [];
  for (const eco of ecosystems) {
    if (!geometry.regions.has(eco.biome)) continue;
    const area = regionAreaOf(geometry, eco.biome);
    for (const entry of eco.spawnTable) {
      rules.push(expandEntry(mapKey, eco.biome, entry, area));
    }
  }
  return rules;
}
