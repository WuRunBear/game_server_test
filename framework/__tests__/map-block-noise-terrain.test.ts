/**
 * 生成积木 noise-terrain 测试（framework/__tests__/map-block-noise-terrain.test.ts）。
 *
 * 覆盖计划 todo 3 验收：
 * - U1 确定性：同 params 同 seed 两次产出 tiles/walkable 深相等；异 seed 不同；
 * - 阈值带：恒值随机流注入下，带边界（含端点）精确产出声明的语义 id；
 * - 通行派生：语义 ∈ nonWalkableSemantics → walkable=0，否则 1；
 * - 尺寸：draft 尺寸与三缓冲长度 = width×height（行主序）；
 * - 参数校验：缺失/非法参数抛出点名具体配置项的错误；
 * - 管道接入：经标准注册表 + buildMapGeometry 端到端产出合法 MapGeometry。
 */
import { describe, expect, it } from "vitest";

import { noiseTerrain } from "map/generate/blocks/noiseTerrain";
import { createGeneratorRegistry } from "map/generate/generatorRegistry";
import { buildMapGeometry } from "map/generate/pipeline";
import { createRng, type Rng } from "map/generate/rng";
import { createGeometryDraft, type GenerationContext } from "map/generate/types";

/** 测试地图 key。 */
const KEY = "noise-map";

/** 基准参数（16×16，三带阈值表，语义 7 不可通行）。 */
const BASE_PARAMS = {
  width: 16,
  height: 16,
  tileWidth: 16,
  tileHeight: 16,
  bandLevel: 0.25,
  groundPalette: { "7": 0.25, "3": 0.5, "5": 1 },
  nonWalkableSemantics: [7],
};

/** 构造指定随机流的生成上下文（独立草稿）。 */
function makeCtx(params: unknown, rng: Rng): GenerationContext {
  return { key: KEY, rng, geometry: createGeometryDraft(KEY), params };
}

/** 恒值随机流：next() 恒返回同一值（恒值晶格 → 恒值 fBm 场）。 */
function constantRng(value: number): Rng {
  return { next: () => value, int: () => 0 };
}

/** 以给定参数与随机流跑一次积木，返回写入后的草稿。 */
function runBlock(params: unknown, rng: Rng) {
  const ctx = makeCtx(params, rng);
  noiseTerrain(ctx);
  return ctx.geometry;
}

describe("noiseTerrain 参数校验（缺失/非法抛错点名配置项）", () => {
  it("NEGATIVE：params 非对象（null）→ 抛错", () => {
    expect(() => runBlock(null, createRng(1))).toThrowError(/noise-terrain params must be an object/);
  });

  it("NEGATIVE：缺 width → 抛错点名 params.width", () => {
    expect(() => runBlock({ ...BASE_PARAMS, width: undefined }, createRng(1))).toThrowError(
      /params width must be a positive integer, got undefined/,
    );
  });

  it("NEGATIVE：width 非整数 → 抛错点名 params.width", () => {
    expect(() => runBlock({ ...BASE_PARAMS, width: 2.5 }, createRng(1))).toThrowError(
      /params width must be a positive integer, got 2\.5/,
    );
  });

  it("NEGATIVE：tileWidth 非正数 → 抛错点名 params.tileWidth", () => {
    expect(() => runBlock({ ...BASE_PARAMS, tileWidth: 0 }, createRng(1))).toThrowError(
      /params tileWidth must be a positive number, got 0/,
    );
  });

  it("NEGATIVE：bandLevel 越界 → 抛错点名 params.bandLevel", () => {
    expect(() => runBlock({ ...BASE_PARAMS, bandLevel: 1.5 }, createRng(1))).toThrowError(
      /params bandLevel must be a number in \[0, 1\], got 1\.5/,
    );
  });

  it("NEGATIVE：groundPalette 非对象 → 抛错", () => {
    expect(() => runBlock({ ...BASE_PARAMS, groundPalette: [] }, createRng(1))).toThrowError(
      /params groundPalette must be an object of semantic id -> band bound/,
    );
  });

  it("NEGATIVE：groundPalette 为空对象 → 抛错", () => {
    expect(() => runBlock({ ...BASE_PARAMS, groundPalette: {} }, createRng(1))).toThrowError(
      /params groundPalette must declare at least one band/,
    );
  });

  it("NEGATIVE：groundPalette 键非规范整数语义 id → 抛错", () => {
    expect(() => runBlock({ ...BASE_PARAMS, groundPalette: { "1.5": 0.5, "3": 1 } }, createRng(1))).toThrowError(
      /params groundPalette key "1\.5" must be an integer semantic id in \[0, 255\]/,
    );
  });

  it("NEGATIVE：阈值上界越界（0）→ 抛错", () => {
    expect(() => runBlock({ ...BASE_PARAMS, groundPalette: { "7": 0, "3": 1 } }, createRng(1))).toThrowError(
      /params groundPalette\["7"\] must be a number in \(0, 1\], got 0/,
    );
  });

  it("NEGATIVE：阈值带重复上界 → 抛错", () => {
    expect(() =>
      runBlock({ ...BASE_PARAMS, groundPalette: { "7": 0.5, "3": 0.5, "5": 1 } }, createRng(1)),
    ).toThrowError(/band bounds must be strictly increasing \(duplicate bound 0\.5\)/);
  });

  it("NEGATIVE：阈值带未覆盖到 1 → 抛错", () => {
    expect(() => runBlock({ ...BASE_PARAMS, groundPalette: { "7": 0.25, "3": 0.8 } }, createRng(1))).toThrowError(
      /bounds must cover \[0, 1\] \(largest bound is 0\.8\)/,
    );
  });

  it("NEGATIVE：bandLevel 与最低带界不一致 → 抛错点名两个值", () => {
    expect(() => runBlock({ ...BASE_PARAMS, bandLevel: 0.2 }, createRng(1))).toThrowError(
      /params bandLevel \(0\.2\) must equal the lowest groundPalette band bound \(0\.25\)/,
    );
  });

  it("NEGATIVE：nonWalkableSemantics 非数组 → 抛错", () => {
    expect(() => runBlock({ ...BASE_PARAMS, nonWalkableSemantics: "7" }, createRng(1))).toThrowError(
      /params nonWalkableSemantics must be an array of semantic ids/,
    );
  });

  it("NEGATIVE：nonWalkableSemantics 含越界 id → 抛错", () => {
    expect(() => runBlock({ ...BASE_PARAMS, nonWalkableSemantics: [300] }, createRng(1))).toThrowError(
      /params nonWalkableSemantics entries must be integers in \[0, 255\], got 300/,
    );
  });

  it("NEGATIVE：草稿已初始化（非首积木）→ 抛错点名管道顺序约束", () => {
    const ctx = makeCtx(BASE_PARAMS, createRng(1));
    noiseTerrain(ctx);
    expect(() => noiseTerrain(ctx)).toThrowError(/noise-terrain must be the first pipeline block/);
  });
});

describe("noiseTerrain 确定性与输出尺寸", () => {
  it("POSITIVE：同 params 同 seed 两次产出 tiles/walkable 深相等（U1）", () => {
    const first = runBlock(BASE_PARAMS, createRng(42));
    const second = runBlock(BASE_PARAMS, createRng(42));
    expect(second.tiles).toEqual(first.tiles);
    expect(second.walkable).toEqual(first.walkable);
  });

  it("U1：异 seed 产出不同 tiles", () => {
    const a = runBlock(BASE_PARAMS, createRng(42));
    const b = runBlock(BASE_PARAMS, createRng(43));
    expect(b.tiles).not.toEqual(a.tiles);
  });

  it("POSITIVE：设定 draft 尺寸并分配 width×height 三缓冲（行主序）", () => {
    const draft = runBlock({ ...BASE_PARAMS, width: 5, height: 3 }, createRng(1));
    expect(draft.width).toBe(5);
    expect(draft.height).toBe(3);
    expect(draft.tileWidth).toBe(16);
    expect(draft.tileHeight).toBe(16);
    expect(draft.tiles).toHaveLength(15);
    expect(draft.walkable).toHaveLength(15);
    expect(draft.regionOfTile).toHaveLength(15);
    // 区域位图只分配不填写（regions/regionOfTile 归 climate-regions 积木）
    expect(draft.regionOfTile).toEqual(new Uint16Array(15));
    expect(draft.regions.size).toBe(0);
  });

  it("POSITIVE：单带阈值表（bandLevel=1）→ 全图同一语义 id", () => {
    const draft = runBlock(
      { ...BASE_PARAMS, width: 4, height: 4, bandLevel: 1, groundPalette: { "9": 1 }, nonWalkableSemantics: [] },
      createRng(1),
    );
    expect([...draft.tiles]).toEqual(Array(16).fill(9));
    expect([...draft.walkable]).toEqual(Array(16).fill(1));
  });
});

describe("noiseTerrain 阈值带与通行派生", () => {
  // 恒值晶格 → fBm 场恒等于该常量（逐层插值不动点）；常数取二进精确值，
  // 使 fBm(常量 c) === c 逐位精确，带边界（含端点）可做零容差断言。
  const bandCases: Array<[number, number]> = [
    [0.125, 7], // < 最低带界 → 最低带
    [0.25, 7], // == 最低带界（端点含在低带）
    [0.3125, 3], // 恰高于最低带界 → 中带
    [0.375, 3], // 中带内部
    [0.5, 3], // == 中带上界（端点含在该带）
    [0.75, 5], // > 中带上界 → 最高带
  ];

  it("POSITIVE：阈值带边界精确产出声明的语义 id", () => {
    for (const [level, expectedId] of bandCases) {
      const draft = runBlock(BASE_PARAMS, constantRng(level));
      expect(new Set(draft.tiles)).toEqual(new Set([expectedId]));
    }
  });

  it("U6：语义 ∈ nonWalkableSemantics → walkable=0；否则 walkable=1", () => {
    // 恒值场全图语义 3：集合含 3 → 全图不可通行；集合仅含 5 → 全图可通行
    const blocked = runBlock({ ...BASE_PARAMS, nonWalkableSemantics: [7, 3] }, constantRng(0.375));
    expect(blocked.walkable).toEqual(new Uint8Array(256));
    const open = runBlock({ ...BASE_PARAMS, nonWalkableSemantics: [5] }, constantRng(0.375));
    expect(open.walkable).toEqual(new Uint8Array(256).fill(1));
  });

  it("U6：真实随机场下 walkable 与语义集合逐格一致", () => {
    const draft = runBlock(BASE_PARAMS, createRng(7));
    const nonWalkable = new Set(BASE_PARAMS.nonWalkableSemantics);
    for (let i = 0; i < draft.tiles.length; i++) {
      expect(draft.walkable[i]).toBe(nonWalkable.has(draft.tiles[i]) ? 0 : 1);
    }
  });

  it("U6：nonWalkableSemantics 为空数组 → 全图可通行", () => {
    const draft = runBlock({ ...BASE_PARAMS, nonWalkableSemantics: [] }, createRng(7));
    expect(draft.walkable).toEqual(new Uint8Array(256).fill(1));
  });
});

describe("noiseTerrain 管道接入", () => {
  it("POSITIVE：经标准注册表接入 buildMapGeometry（后随补区域假积木）产出合法 MapGeometry", () => {
    const registry = createGeneratorRegistry();
    registry.register("noise-terrain", noiseTerrain);
    registry.register("fake-regions", (ctx) => {
      ctx.geometry.regions.set("region-a", { name: "region-a", meta: {} });
    });

    const geometry = buildMapGeometry(
      {
        key: KEY,
        seed: 42,
        pipeline: [
          { generator: "noise-terrain", params: { ...BASE_PARAMS } },
          { generator: "fake-regions" },
        ],
      },
      registry,
    );

    expect(geometry.grid).toEqual({ width: 16, height: 16, tileWidth: 16, tileHeight: 16 });
    expect(geometry.tiles).toHaveLength(256);
    expect(geometry.walkable).toHaveLength(256);
    expect(geometry.version).not.toBe("");
  });
});

describe("noiseTerrain 采样参数化（falloff / redistribution / octaves / baseCellTiles）", () => {
  /** 与四个新参数缺省值等价的显式参数切片（供「缺省 = 显式缺省值」对照）。 */
  const EXPLICIT_DEFAULTS = { falloff: 0, redistribution: 1, octaves: 4, baseCellTiles: 8 };

  it("POSITIVE：省略新参数与显式传缺省值输出逐位一致（缺省 = 现状）", () => {
    const rng = createRng(123);
    const omitted = runBlock(BASE_PARAMS, createRng(123));
    const explicit = runBlock({ ...BASE_PARAMS, ...EXPLICIT_DEFAULTS }, rng);
    expect(explicit.tiles).toEqual(omitted.tiles);
    expect(explicit.walkable).toEqual(omitted.walkable);
  });

  it("POSITIVE：falloff 开启后边缘衰减为最低带、中心保持原带（恒值场精确断言）", () => {
    // 恒值场 level=0.5：无 falloff 时全图带 3（0.25 < 0.5 ≤ 0.5）
    const base = runBlock(BASE_PARAMS, constantRng(0.5));
    expect(new Set(base.tiles)).toEqual(new Set([3]));
    // falloff=0.9：角/边缘中点衰减到 0 → 最低带 7；中心附近几乎不衰减 → 带 3
    const masked = runBlock({ ...BASE_PARAMS, falloff: 0.9 }, constantRng(0.5));
    expect(masked.tiles[0]).toBe(7); // 角 (0,0)：edgeDist=0 → 衰减因子 0
    expect(masked.tiles[8]).toBe(7); // 边缘中点 (8,0)：edgeDist=0
    expect(masked.tiles[8 * 16 + 8]).toBe(3); // 中心 (8,8)：衰减因子 ≈ 0.98
  });

  it("U6：falloff 开启后边缘环的最低带占比高于中心区域（真实随机场统计）", () => {
    const size = { width: 64, height: 64 };
    const plain = runBlock({ ...BASE_PARAMS, ...size }, createRng(9));
    const masked = runBlock({ ...BASE_PARAMS, ...size, falloff: 0.9 }, createRng(9));
    const lowest = BASE_PARAMS.groundPalette["7"] !== undefined ? 7 : 0;
    const lowestShare = (tiles: Uint8Array, test: (x: number, y: number) => boolean): number => {
      let hit = 0;
      let total = 0;
      for (let y = 0; y < size.height; y++) {
        for (let x = 0; x < size.width; x++) {
          if (!test(x, y)) continue;
          total++;
          if (tiles[y * size.width + x] === lowest) hit++;
        }
      }
      return hit / total;
    };
    const edgeShare = (tiles: Uint8Array): number =>
      lowestShare(tiles, (x, y) => x < 2 || y < 2 || x >= size.width - 2 || y >= size.height - 2);
    const centerShare = (tiles: Uint8Array): number =>
      lowestShare(tiles, (x, y) => x >= 28 && x < 36 && y >= 28 && y < 36);
    // 无 falloff：边缘与中心的最低带占比统计上接近
    expect(Math.abs(edgeShare(plain.tiles) - centerShare(plain.tiles))).toBeLessThan(0.35);
    // 开 falloff：边缘显著低于中心 → 最低带（水/最低带语义）更多
    expect(edgeShare(masked.tiles)).toBeGreaterThan(centerShare(masked.tiles) + 0.3);
  });

  it("POSITIVE：falloff 开启时同 seed 两次产出逐位一致（确定性）", () => {
    const params = { ...BASE_PARAMS, falloff: 0.9, redistribution: 0.7, octaves: 3, baseCellTiles: 12 };
    const first = runBlock(params, createRng(55));
    const second = runBlock(params, createRng(55));
    expect(second.tiles).toEqual(first.tiles);
    expect(second.walkable).toEqual(first.walkable);
  });

  it("POSITIVE：redistribution 指数重映射改变分带（恒值场精确断言）", () => {
    // 恒值 0.5：0.5^0.5 ≈ 0.707 > 0.5 → 最高带 5；0.5^1.5 ≈ 0.354 → 中带 3
    const lifted = runBlock({ ...BASE_PARAMS, redistribution: 0.5 }, constantRng(0.5));
    expect(new Set(lifted.tiles)).toEqual(new Set([5]));
    const sunk = runBlock({ ...BASE_PARAMS, redistribution: 1.5 }, constantRng(0.5));
    expect(new Set(sunk.tiles)).toEqual(new Set([3]));
  });

  it("U6：redistribution 1.5 的最低带覆盖率显著高于 0.5（真实随机场统计）", () => {
    // x^exponent ∈ [0,1] 单调：指数 0.5 抬高采样值（最低带减少）、
    // 指数 1.5 压低采样值（最低带增加）
    const size = { width: 64, height: 64 };
    const lifted = runBlock({ ...BASE_PARAMS, ...size, redistribution: 0.5 }, createRng(21));
    const sunk = runBlock({ ...BASE_PARAMS, ...size, redistribution: 1.5 }, createRng(21));
    const lowestCount = (tiles: Uint8Array): number => {
      let hit = 0;
      for (const id of tiles) {
        if (id === 7) hit++;
      }
      return hit;
    };
    expect(lowestCount(sunk.tiles)).toBeGreaterThan(lowestCount(lifted.tiles) + 256);
  });

  it("POSITIVE：octaves=1 单层输出确定且与缺省 4 层不同", () => {
    const single = runBlock({ ...BASE_PARAMS, octaves: 1 }, createRng(31));
    const singleAgain = runBlock({ ...BASE_PARAMS, octaves: 1 }, createRng(31));
    expect(single.tiles).toEqual(singleAgain.tiles);
    const four = runBlock(BASE_PARAMS, createRng(31));
    expect(single.tiles).not.toEqual(four.tiles);
  });

  it("POSITIVE：baseCellTiles 变化改变噪声粒度（与缺省输出不同且确定）", () => {
    const fine = runBlock({ ...BASE_PARAMS, baseCellTiles: 4 }, createRng(77));
    const fineAgain = runBlock({ ...BASE_PARAMS, baseCellTiles: 4 }, createRng(77));
    expect(fine.tiles).toEqual(fineAgain.tiles);
    const coarse = runBlock(BASE_PARAMS, createRng(77));
    expect(fine.tiles).not.toEqual(coarse.tiles);
  });

  it("NEGATIVE：falloff 越界（<0 / >0.9）→ 抛错点名 params.falloff", () => {
    expect(() => runBlock({ ...BASE_PARAMS, falloff: -0.1 }, createRng(1))).toThrowError(
      /params falloff must be a number in \[0, 0\.9\], got -0\.1/,
    );
    expect(() => runBlock({ ...BASE_PARAMS, falloff: 0.95 }, createRng(1))).toThrowError(
      /params falloff must be a number in \[0, 0\.9\], got 0\.95/,
    );
  });

  it("NEGATIVE：redistribution 越界（<0.5 / >1.5）→ 抛错点名 params.redistribution", () => {
    expect(() => runBlock({ ...BASE_PARAMS, redistribution: 0.4 }, createRng(1))).toThrowError(
      /params redistribution must be a number in \[0\.5, 1\.5\], got 0\.4/,
    );
    expect(() => runBlock({ ...BASE_PARAMS, redistribution: 1.6 }, createRng(1))).toThrowError(
      /params redistribution must be a number in \[0\.5, 1\.5\], got 1\.6/,
    );
  });

  it("NEGATIVE：octaves 越界（0 / 9 / 非整数）→ 抛错点名 params.octaves", () => {
    expect(() => runBlock({ ...BASE_PARAMS, octaves: 0 }, createRng(1))).toThrowError(
      /params octaves must be an integer in \[1, 8\], got 0/,
    );
    expect(() => runBlock({ ...BASE_PARAMS, octaves: 9 }, createRng(1))).toThrowError(
      /params octaves must be an integer in \[1, 8\], got 9/,
    );
    expect(() => runBlock({ ...BASE_PARAMS, octaves: 2.5 }, createRng(1))).toThrowError(
      /params octaves must be an integer in \[1, 8\], got 2\.5/,
    );
  });

  it("NEGATIVE：baseCellTiles 越界（1 / 65）→ 抛错点名 params.baseCellTiles", () => {
    expect(() => runBlock({ ...BASE_PARAMS, baseCellTiles: 1 }, createRng(1))).toThrowError(
      /params baseCellTiles must be an integer in \[2, 64\], got 1/,
    );
    expect(() => runBlock({ ...BASE_PARAMS, baseCellTiles: 65 }, createRng(1))).toThrowError(
      /params baseCellTiles must be an integer in \[2, 64\], got 65/,
    );
  });
});
