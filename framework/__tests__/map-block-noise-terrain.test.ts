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

  it("POSITIVE：异 seed 产出不同 tiles", () => {
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

  it("POSITIVE：语义 ∈ nonWalkableSemantics → walkable=0；否则 walkable=1", () => {
    // 恒值场全图语义 3：集合含 3 → 全图不可通行；集合仅含 5 → 全图可通行
    const blocked = runBlock({ ...BASE_PARAMS, nonWalkableSemantics: [7, 3] }, constantRng(0.375));
    expect(blocked.walkable).toEqual(new Uint8Array(256));
    const open = runBlock({ ...BASE_PARAMS, nonWalkableSemantics: [5] }, constantRng(0.375));
    expect(open.walkable).toEqual(new Uint8Array(256).fill(1));
  });

  it("POSITIVE：真实随机场下 walkable 与语义集合逐格一致", () => {
    const draft = runBlock(BASE_PARAMS, createRng(7));
    const nonWalkable = new Set(BASE_PARAMS.nonWalkableSemantics);
    for (let i = 0; i < draft.tiles.length; i++) {
      expect(draft.walkable[i]).toBe(nonWalkable.has(draft.tiles[i]) ? 0 : 1);
    }
  });

  it("POSITIVE：nonWalkableSemantics 为空数组 → 全图可通行", () => {
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
