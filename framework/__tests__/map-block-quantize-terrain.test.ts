/**
 * 生成积木 quantize-terrain 测试（framework/__tests__/map-block-quantize-terrain.test.ts）。
 *
 * 覆盖（地图切片 4B）：
 * - 分带正确性：构造已知高度场断言每格 level（含阈值边界 h == t 归上带、
 *   超出阈值数的场值被 maxLevels 容量校验前置拦截而非静默压顶）；
 * - slope/cliff 派生与 walkable 修正：层差 1 的边界带两侧标 slope（可走）、
 *   层差 ≥2 的边界带两侧标 cliff（不可走）、平坦区不改写上游语义/通行位；
 *   cliff 优先于 slope（一格同时邻接两种边界）；
 * - 上游衔接：height 场缺失/长度不符抛错；量化后 aux 场原样保留
 *   （下游 river 类积木仍可消费量化前连续梯度）；
 * - level 缓冲：按需分配（尺寸积木未分配时自建）且等长；
 * - 参数 fail-fast：thresholds 非空/升序/(0,1)、maxLevels 容量覆盖全部分带、
 *   slope/cliff 语义 id 合法且互异、未定尺寸草稿。
 *
 * 测试直接经 setAux(HEIGHT_FIELD) 写入已知高度场（不跑 height-channel），
 * 与 height-mask 测试同款手法——积木只认 aux 槽位契约。
 */
import { beforeEach, describe, expect, it } from "vitest";

import { createRng } from "map/generate/rng";
import { HEIGHT_FIELD } from "map/generate/blocks/heightChannel";
import { quantizeTerrain } from "map/generate/blocks/quantizeTerrain";
import { createGeometryDraft, setAux } from "map/generate/types";
import type { GenerationContext, GeometryDraft } from "map/generate/types";

/** 测试图 key（错误消息定位用）。 */
const KEY = "quantize-test";

/** 构造 4×4 已定尺寸草稿（全可走、语义 2、单区域、未分配 level）。 */
function makeSizedDraft(): GeometryDraft {
  const draft = createGeometryDraft(KEY);
  draft.width = 4;
  draft.height = 4;
  draft.tileWidth = 16;
  draft.tileHeight = 16;
  draft.tiles = new Uint8Array(16).fill(2);
  draft.walkable = new Uint8Array(16).fill(1);
  draft.regionOfTile = new Uint16Array(16);
  return draft;
}

/** 构造执行上下文（rng 仅占位——本积木不用随机流）。 */
function makeCtx(draft: GeometryDraft, params: unknown): GenerationContext {
  return { key: KEY, rng: createRng(1), geometry: draft, params };
}

/** 默认参数：3 阈值 → 4 带（level 0..3），slope=7 / cliff=8。 */
const BASE_PARAMS = {
  thresholds: [0.5, 0.6, 0.7],
  maxLevels: 4,
  slopeSemantics: 7,
  cliffSemantics: 8,
};

beforeEach(() => {
  // aux 池随草稿创建，无跨用例残留；此处仅防未来引入模块级状态
});

describe("quantize-terrain 分带正确性", () => {
  it("POSITIVE：已知高度场逐格量化（h < t0 → 0，h ≥ tk → k，边界值归上带）", () => {
    const draft = makeSizedDraft();
    // 单阈值 0.5：4 格高度分别落在带 0 / 带 0 / 带 1 / 边界值
    const field = new Float64Array(16);
    field[0] = 0.1; // < 0.5 → level 0
    field[1] = 0.49; // < 0.5 → level 0
    field[2] = 0.5; // == 阈值（h ≥ t）→ level 1
    field[3] = 0.9; // ≥ 0.5 → level 1
    setAux(draft, HEIGHT_FIELD, field);

    quantizeTerrain(makeCtx(draft, { thresholds: [0.5], maxLevels: 2, slopeSemantics: 7, cliffSemantics: 8 }));

    expect(Array.from(draft.level)).toEqual([
      0, 0, 1, 1,
      0, 0, 0, 0,
      0, 0, 0, 0,
      0, 0, 0, 0,
    ]);
  });

  it("POSITIVE：多阈值分带（3 阈值 → 4 带，逐带命中）", () => {
    const draft = makeSizedDraft();
    const field = new Float64Array(16);
    field[0] = 0.2; // 带 0
    field[1] = 0.5; // 带 1（≥ 0.5）
    field[2] = 0.65; // 带 2（≥ 0.6）
    field[3] = 0.99; // 带 3（≥ 0.7）
    setAux(draft, HEIGHT_FIELD, field);

    quantizeTerrain(makeCtx(draft, BASE_PARAMS));

    expect(draft.level[0]).toBe(0);
    expect(draft.level[1]).toBe(1);
    expect(draft.level[2]).toBe(2);
    expect(draft.level[3]).toBe(3);
  });

  it("POSITIVE：level 缓冲按需分配且等长（尺寸积木未分配 level 时自建）", () => {
    const draft = makeSizedDraft();
    expect(draft.level.length).toBe(0); // 前置：草稿未分配
    setAux(draft, HEIGHT_FIELD, new Float64Array(16).fill(0.9));

    quantizeTerrain(makeCtx(draft, BASE_PARAMS));

    expect(draft.level).toBeInstanceOf(Int8Array);
    expect(draft.level.length).toBe(16);
  });
});

describe("quantize-terrain slope/cliff 派生与 walkable 修正", () => {
  it("POSITIVE：层差 1 的边界带两侧标 slope（可走），平坦区保持上游语义与通行位", () => {
    const draft = makeSizedDraft();
    // 左列 4 格高度 0.9（level 1），其余 0.1（level 0）→ x=0/x=1 两列是
    // Δ=1 边界带（slope），x≥2 列平坦（保持语义 2 / 可走）
    const field = new Float64Array(16);
    for (let y = 0; y < 4; y++) {
      field[y * 4] = 0.9;
    }
    setAux(draft, HEIGHT_FIELD, field);

    quantizeTerrain(makeCtx(draft, { thresholds: [0.5], maxLevels: 2, slopeSemantics: 7, cliffSemantics: 8 }));

    for (let y = 0; y < 4; y++) {
      // 边界带两列：slope 语义 7、可走
      expect(draft.tiles[y * 4]).toBe(7);
      expect(draft.walkable[y * 4]).toBe(1);
      expect(draft.tiles[y * 4 + 1]).toBe(7);
      expect(draft.walkable[y * 4 + 1]).toBe(1);
      // 平坦区：不改写
      expect(draft.tiles[y * 4 + 2]).toBe(2);
      expect(draft.walkable[y * 4 + 2]).toBe(1);
      expect(draft.tiles[y * 4 + 3]).toBe(2);
      expect(draft.walkable[y * 4 + 3]).toBe(1);
    }
  });

  it("POSITIVE：层差 ≥2 的边界带两侧标 cliff（不可走）", () => {
    const draft = makeSizedDraft();
    // 左半 0.9（带 3），右半 0.1（带 0）→ x=1/x=2 两列 Δ=3（cliff）
    const field = new Float64Array(16);
    for (let y = 0; y < 4; y++) {
      field[y * 4] = 0.9;
      field[y * 4 + 1] = 0.9;
    }
    setAux(draft, HEIGHT_FIELD, field);

    quantizeTerrain(makeCtx(draft, BASE_PARAMS));

    for (let y = 0; y < 4; y++) {
      // 左半台地内部（x=0）：远离边界，保持台地
      expect(draft.level[y * 4]).toBe(3);
      // cliff 带（x=1、x=2）：cliff 语义 8、不可走
      expect(draft.tiles[y * 4 + 1]).toBe(8);
      expect(draft.walkable[y * 4 + 1]).toBe(0);
      expect(draft.tiles[y * 4 + 2]).toBe(8);
      expect(draft.walkable[y * 4 + 2]).toBe(0);
      // 右半台地内部（x=3）：保持台地可走
      expect(draft.level[y * 4 + 3]).toBe(0);
      expect(draft.tiles[y * 4 + 3]).toBe(2);
      expect(draft.walkable[y * 4 + 3]).toBe(1);
    }
  });

  it("POSITIVE：cliff 优先于 slope（一格同时邻接 1 层差与 ≥2 层差邻居）", () => {
    const draft = makeSizedDraft();
    // 高度按列：x=0 → 0.9（带 3）、x=1 → 0.65（带 2）、x=2..3 → 0.1（带 0）
    // x=1 列对 x=0 差 1（slope 信号）、对 x=2 差 2（cliff 信号）→ cliff 胜
    const field = new Float64Array(16);
    for (let y = 0; y < 4; y++) {
      field[y * 4] = 0.9;
      field[y * 4 + 1] = 0.65;
      field[y * 4 + 2] = 0.1;
      field[y * 4 + 3] = 0.1;
    }
    setAux(draft, HEIGHT_FIELD, field);

    quantizeTerrain(makeCtx(draft, BASE_PARAMS));

    for (let y = 0; y < 4; y++) {
      expect(draft.level[y * 4 + 1]).toBe(2);
      expect(draft.tiles[y * 4 + 1]).toBe(8); // cliff 胜出
      expect(draft.walkable[y * 4 + 1]).toBe(0);
      // x=0 列对 x=1 差 1、无 ≥2 邻居 → slope
      expect(draft.tiles[y * 4]).toBe(7);
      expect(draft.walkable[y * 4]).toBe(1);
    }
  });

  it("POSITIVE：量化后 aux 高度场原样保留（下游可继续消费量化前连续梯度）", () => {
    const draft = makeSizedDraft();
    const field = new Float64Array(16).fill(0.6);
    setAux(draft, HEIGHT_FIELD, field);

    quantizeTerrain(makeCtx(draft, BASE_PARAMS));

    expect(draft.aux.get(HEIGHT_FIELD.name)).toBe(field);
  });
});

describe("quantize-terrain 上游依赖 fail-fast", () => {
  it("NEGATIVE：height 场缺失（height-channel 未运行）→ 抛错", () => {
    const draft = makeSizedDraft();

    expect(() => quantizeTerrain(makeCtx(draft, BASE_PARAMS))).toThrowError(
      /quantize-terrain requires an upstream "height-channel" step/,
    );
  });

  it("NEGATIVE：height 场长度与网格不符 → 抛错", () => {
    const draft = makeSizedDraft();
    setAux(draft, HEIGHT_FIELD, new Float64Array(8));

    expect(() => quantizeTerrain(makeCtx(draft, BASE_PARAMS))).toThrowError(/field.length=8, expected 16/);
  });

  it("NEGATIVE：草稿未定尺寸 → 抛错（须先跑尺寸积木）", () => {
    const draft = createGeometryDraft(KEY);

    expect(() => quantizeTerrain(makeCtx(draft, BASE_PARAMS))).toThrowError(
      /quantize-terrain requires a sized draft/,
    );
  });
});

describe("quantize-terrain 参数 fail-fast", () => {
  function expectParamsFail(params: Record<string, unknown>, message: RegExp): void {
    const draft = makeSizedDraft();
    setAux(draft, HEIGHT_FIELD, new Float64Array(16));
    expect(() => quantizeTerrain(makeCtx(draft, params))).toThrowError(message);
  }

  it("NEGATIVE：params 非对象", () => {
    const draft = makeSizedDraft();
    expect(() => quantizeTerrain(makeCtx(draft, null))).toThrowError(/params must be an object/);
  });

  it("NEGATIVE：thresholds 缺失 / 空数组", () => {
    expectParamsFail({ ...BASE_PARAMS, thresholds: undefined }, /thresholds must be a non-empty array/);
    expectParamsFail({ ...BASE_PARAMS, thresholds: [] }, /thresholds must be a non-empty array/);
  });

  it("NEGATIVE：thresholds 元素越界（0 与 1 均非法）或非数字", () => {
    expectParamsFail({ ...BASE_PARAMS, thresholds: [0, 0.5] }, /must be numbers in \(0, 1\), got 0/);
    expectParamsFail({ ...BASE_PARAMS, thresholds: [1] }, /must be numbers in \(0, 1\), got 1/);
    expectParamsFail({ ...BASE_PARAMS, thresholds: ["0.5"] }, /must be numbers in \(0, 1\)/);
  });

  it("NEGATIVE：thresholds 非严格升序", () => {
    expectParamsFail({ ...BASE_PARAMS, thresholds: [0.6, 0.5, 0.7] }, /must be strictly ascending/);
    expectParamsFail({ ...BASE_PARAMS, thresholds: [0.5, 0.5] }, /must be strictly ascending/);
  });

  it("NEGATIVE：maxLevels 非法（越界 / 非整数 / 容量小于分带数）", () => {
    expectParamsFail({ ...BASE_PARAMS, maxLevels: 0 }, /maxLevels must be an integer in \[1, 128\]/);
    expectParamsFail({ ...BASE_PARAMS, maxLevels: 129 }, /maxLevels must be an integer in \[1, 128\]/);
    expectParamsFail({ ...BASE_PARAMS, maxLevels: 2.5 }, /maxLevels must be an integer in \[1, 128\]/);
    // 3 阈值 = 4 带 > 2 层容量：禁止静默把顶层带压平
    expectParamsFail({ ...BASE_PARAMS, maxLevels: 2 }, /must cover all bands: thresholds.length \+ 1 = 4/);
  });

  it("NEGATIVE：slope/cliff 语义 id 非法或相同", () => {
    expectParamsFail({ ...BASE_PARAMS, slopeSemantics: -1 }, /slopeSemantics must be an integer semantic id in \[0, 255\]/);
    expectParamsFail({ ...BASE_PARAMS, slopeSemantics: 256 }, /slopeSemantics must be an integer semantic id in \[0, 255\]/);
    expectParamsFail({ ...BASE_PARAMS, cliffSemantics: 1.5 }, /cliffSemantics must be an integer semantic id in \[0, 255\]/);
    expectParamsFail({ ...BASE_PARAMS, cliffSemantics: 7 }, /must be distinct/);
  });
});
