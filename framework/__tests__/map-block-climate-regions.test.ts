/**
 * climate-regions 生成积木测试（framework/__tests__/map-block-climate-regions.test.ts）。
 *
 * 覆盖计划 todo 4 验收：
 * - names 全部按声明顺序写入 regions（插入序 = regionOfTile 索引序）；
 * - regionOfTile 每格索引合法（落在 regions 数量内）且长度与网格一致；
 * - 同 seed 两次运行 regions + regionOfTile 深相等（确定性），异 seed 不同；
 * - minArea 重平衡生效：未重平衡时面积不足的碎片区，重平衡后命名区域
 *   面积全部 ≥ minArea（碎片区并入相邻区域并从 regions 移除）；
 * - 未定尺寸草稿 → 抛错点名地图 key；
 * - params 边界校验：style 仅支持 "noise"、names 为非空字符串数组且不含
 *   保留名/重复名、minArea 为 ≥ 1 的有限数；
 * - 每个命名区域覆盖的格子 4-连通成片（非盐粒噪声）。
 */
import { describe, expect, it } from "vitest";

import { climateRegions } from "map/generate/blocks/climateRegions";
import { createGeneratorRegistry, type GeneratorRegistry } from "map/generate/generatorRegistry";
import { buildMapGeometry } from "map/generate/pipeline";
import type { MapGenerationConfig, MapGenerator } from "map/generate/types";
import type { MapGeometry } from "map/geometry/types";

/** 测试用区域名（通用占位名，顺序即 regionOfTile 索引序）。 */
const NAMES = ["alpha", "beta", "gamma"];

/** 假 sizing 积木：按 params 设定网格尺寸并分配缓冲（不声明区域）。 */
const sizingBlock: MapGenerator = (ctx) => {
  const { width, height } = ctx.params as { width: number; height: number };
  const draft = ctx.geometry;
  draft.width = width;
  draft.height = height;
  draft.tileWidth = 16;
  draft.tileHeight = 16;
  draft.tiles = new Uint8Array(width * height);
  draft.walkable = new Uint8Array(width * height).fill(1);
  draft.regionOfTile = new Uint16Array(width * height);
};

/** 构造注册了 sizing + climate-regions 的注册表。 */
function makeRegistry(): GeneratorRegistry {
  const registry = createGeneratorRegistry();
  registry.register("size", sizingBlock);
  registry.register("climate-regions", climateRegions);
  return registry;
}

/** 跑「sizing → climate-regions」两步管道，返回冻结几何。 */
function runClimate(params: Record<string, unknown>, seed = 11, width = 16, height = 16): MapGeometry {
  const config: MapGenerationConfig = {
    key: "climate-map",
    seed,
    pipeline: [
      { generator: "size", params: { width, height } },
      { generator: "climate-regions", params },
    ],
  };
  return buildMapGeometry(config, makeRegistry());
}

/** regions 插入序的区域名数组。 */
function regionNames(geometry: MapGeometry): string[] {
  return [...geometry.regions.keys()];
}

/** 每个区域索引覆盖的格数（下标 = 区域索引）。 */
function coverageByIndex(geometry: MapGeometry): number[] {
  const counts = new Array<number>(geometry.regions.size).fill(0);
  for (let i = 0; i < geometry.regionOfTile.length; i++) {
    counts[geometry.regionOfTile[i]]++;
  }
  return counts;
}

/** 判断一组格子（展平索引）是否 4-连通。 */
function isConnected(tiles: number[], width: number, height: number): boolean {
  if (tiles.length <= 1) return true;
  const set = new Set(tiles);
  const seen = new Set<number>([tiles[0]]);
  const queue = [tiles[0]];
  for (let head = 0; head < queue.length; head++) {
    const tile = queue[head];
    const x = tile % width;
    const y = (tile - x) / width;
    const neighbors = [
      x > 0 ? tile - 1 : -1,
      x < width - 1 ? tile + 1 : -1,
      y > 0 ? tile - width : -1,
      y < height - 1 ? tile + width : -1,
    ];
    for (const n of neighbors) {
      if (n >= 0 && set.has(n) && !seen.has(n)) {
        seen.add(n);
        queue.push(n);
      }
    }
  }
  return seen.size === set.size;
}

describe("climate-regions 区域划分", () => {
  it("POSITIVE：names 全部按声明顺序写入 regions（插入序 = 索引序）", () => {
    const geometry = runClimate({ names: NAMES, style: "noise" });

    const keys = regionNames(geometry);
    expect(keys.slice(0, NAMES.length)).toEqual(NAMES);
    // 额外条目只允许隐式 wilderness，且必须排在末尾
    for (const extra of keys.slice(NAMES.length)) {
      expect(extra).toBe("wilderness");
    }
    for (const name of keys) {
      expect(geometry.regions.get(name)).toEqual({ name, meta: {} });
    }
  });

  it("POSITIVE：regionOfTile 每格索引合法且长度与网格一致", () => {
    const geometry = runClimate({ names: NAMES, style: "noise" });

    expect(geometry.regionOfTile.length).toBe(16 * 16);
    for (let i = 0; i < geometry.regionOfTile.length; i++) {
      const index = geometry.regionOfTile[i];
      expect(index).toBeGreaterThanOrEqual(0);
      expect(index).toBeLessThan(geometry.regions.size);
    }
  });

  it("POSITIVE：每个命名区域覆盖的格子 4-连通成片（非盐粒噪声）", () => {
    const geometry = runClimate({ names: NAMES, style: "noise" });
    const { width, height } = geometry.grid;

    const tilesByRegion = new Map<number, number[]>();
    for (let i = 0; i < geometry.regionOfTile.length; i++) {
      const index = geometry.regionOfTile[i];
      const tiles = tilesByRegion.get(index) ?? [];
      tiles.push(i);
      tilesByRegion.set(index, tiles);
    }
    regionNames(geometry).forEach((name, index) => {
      if (name === "wilderness") return; // 野区是剩余格拼盘，不要求连通
      expect(isConnected(tilesByRegion.get(index) ?? [], width, height)).toBe(true);
    });
  });

  it("POSITIVE：wilderness 仅在存在未认领格时追加，且确有格子指向它", () => {
    const geometry = runClimate({ names: NAMES, style: "noise" });
    const keys = regionNames(geometry);
    const wildIndex = keys.indexOf("wilderness");
    const coverage = coverageByIndex(geometry);

    if (wildIndex >= 0) {
      expect(coverage[wildIndex]).toBeGreaterThan(0);
      expect(keys.slice(wildIndex)).toEqual(["wilderness"]);
    } else {
      expect(keys).toEqual(NAMES);
    }
  });

  it("U1：同 seed 两次运行 regions 与 regionOfTile 深相等（确定性）", () => {
    const a = runClimate({ names: NAMES, style: "noise" }, 42);
    const b = runClimate({ names: NAMES, style: "noise" }, 42);

    expect([...a.regions.entries()]).toEqual([...b.regions.entries()]);
    expect(a.regionOfTile).toEqual(b.regionOfTile);
  });

  it("U1：异 seed 产出不同的区域位图", () => {
    const a = runClimate({ names: NAMES, style: "noise" }, 42);
    const b = runClimate({ names: NAMES, style: "noise" }, 43);

    expect(b.regionOfTile).not.toEqual(a.regionOfTile);
  });

  it("POSITIVE：minArea 重平衡——面积不足的碎片区并入相邻区域", () => {
    // 前提（seed=95, 12x12 实测）：未重平衡运行中 alpha 仅覆盖 2 格 < minArea
    const unrebalanced = runClimate({ names: NAMES, style: "noise" }, 95, 12, 12);
    const before = coverageByIndex(unrebalanced).slice(0, NAMES.length);
    expect(Math.min(...before)).toBeLessThan(3);

    // 重平衡后：所有命名区域面积 ≥ minArea，碎片区从 regions 移除，
    // 幸存区域保持原声明相对顺序
    const rebalanced = runClimate({ names: NAMES, style: "noise", minArea: 3 }, 95, 12, 12);
    const keys = regionNames(rebalanced);
    const coverage = coverageByIndex(rebalanced);

    const namedKeys = keys.filter((name) => name !== "wilderness");
    expect(namedKeys.length).toBeLessThan(NAMES.length); // 碎片区确被并走
    expect(namedKeys).toEqual(NAMES.filter((name) => namedKeys.includes(name)));
    for (const name of namedKeys) {
      const index = keys.indexOf(name);
      expect(coverage[index]).toBeGreaterThanOrEqual(3);
    }
  });

  it("NEGATIVE：未定尺寸草稿 → 抛错点名地图 key", () => {
    // 管道只有 climate-regions 一步：草稿从未被 sizing
    expect(() =>
      buildMapGeometry(
        {
          key: "bare-map",
          seed: 1,
          pipeline: [{ generator: "climate-regions", params: { names: ["alpha"], style: "noise" } }],
        },
        makeRegistry(),
      ),
    ).toThrowError(/map "bare-map" climate-regions: draft is not sized/);
  });
});

describe("climate-regions params 校验", () => {
  it("NEGATIVE：style 非 noise → 抛错点名 style", () => {
    expect(() => runClimate({ names: ["alpha"], style: "voronoi" })).toThrowError(/params\.style/);
  });

  it("NEGATIVE：style 缺失 → 抛错点名 style", () => {
    expect(() => runClimate({ names: ["alpha"] })).toThrowError(/params\.style/);
  });

  it("NEGATIVE：names 空数组 → 抛错点名 names", () => {
    expect(() => runClimate({ names: [], style: "noise" })).toThrowError(/params\.names/);
  });

  it("NEGATIVE：names 含非字符串条目 → 抛错点名 names", () => {
    expect(() => runClimate({ names: ["alpha", 3], style: "noise" })).toThrowError(/params\.names/);
  });

  it("NEGATIVE：names 含重复名 → 抛错点名重复名", () => {
    expect(() => runClimate({ names: ["alpha", "alpha"], style: "noise" })).toThrowError(/duplicate/);
  });

  it("NEGATIVE：names 含保留名 wilderness → 抛错点名保留名", () => {
    expect(() => runClimate({ names: ["alpha", "wilderness"], style: "noise" })).toThrowError(
      /reserved region name "wilderness"/,
    );
  });

  it("NEGATIVE：minArea < 1 → 抛错点名 minArea", () => {
    expect(() => runClimate({ names: ["alpha"], style: "noise", minArea: 0 })).toThrowError(
      /params\.minArea/,
    );
  });

  it("NEGATIVE：minArea 非有限数 → 抛错点名 minArea", () => {
    expect(() => runClimate({ names: ["alpha"], style: "noise", minArea: Number.NaN })).toThrowError(
      /params\.minArea/,
    );
  });
});
