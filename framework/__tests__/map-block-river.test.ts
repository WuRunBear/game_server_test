/**
 * 生成积木 river 测试（framework/__tests__/map-block-river.test.ts）。
 *
 * 覆盖（地图切片 8，河湖刻蚀）：
 * - flow accumulation：构造已知高度场（谷地汇流）断言汇流点被标水
 *   （waterSemantics + walkable=0）、非河道格保持上游语义/通行位；
 * - 湖泊：配置水位以下的洼地格标水（与河道无关）；
 * - 上游衔接：HEIGHT_FIELD 缺失/长度不符抛错；标水不消费 aux 场
 *   （量化前连续梯度仍供下游使用）；
 * - 管道顺序（切片 8 验证项）：river → quantize-terrain 顺序下——
 *   ① 终态水语义格恒 walkable=0（水道不产生可走水）；② 层界带处的水格
 *   被 quantize 的 slope 派生收编（证明 quantize 后跑、边界带格归其写）；
 * - 参数 fail-fast：flowThreshold ≥ 2 整数、waterSemantics [0,255]、
 *   lakeLevel ∈ (0,1)、未定尺寸草稿；
 * - 确定性：同场同参数两次输出逐位一致（纯函数，无随机性）。
 *
 * 测试直接经 setAux(HEIGHT_FIELD) 写入已知高度场（不跑 height-channel），
 * 与 quantize-terrain 测试同款手法——积木只认 aux 槽位契约。
 */
import { describe, expect, it } from "vitest";

import { HEIGHT_FIELD } from "map/generate/blocks/heightChannel";
import { quantizeTerrain } from "map/generate/blocks/quantizeTerrain";
import { river } from "map/generate/blocks/river";
import { createGeneratorRegistry } from "map/generate/generatorRegistry";
import { buildMapGeometry } from "map/generate/pipeline";
import { createRng } from "map/generate/rng";
import { createGeometryDraft, getAux, setAux, type GenerationContext, type GeometryDraft } from "map/generate/types";

/** 测试图 key（错误消息定位用）。 */
const KEY = "river-test";

/** 构造 5×4 已定尺寸草稿（语义 2、全可走、单区域、未分配 level）。 */
function makeSizedDraft(): GeometryDraft {
  const draft = createGeometryDraft(KEY);
  draft.width = 5;
  draft.height = 4;
  draft.tileWidth = 16;
  draft.tileHeight = 16;
  draft.tiles = new Uint8Array(20).fill(2);
  draft.walkable = new Uint8Array(20).fill(1);
  draft.regions.set("region-a", { name: "region-a", meta: {} });
  draft.regionOfTile = new Uint16Array(20);
  return draft;
}

/** 构造执行上下文（rng 仅占位——本积木无随机性）。 */
function makeCtx(draft: GeometryDraft, params: unknown): GenerationContext {
  return { key: KEY, rng: createRng(1), geometry: draft, params };
}

describe("river：flow accumulation 汇流标水", () => {
  it("POSITIVE：谷地汇流——最低列各格累积 ≥ 阈值被标水（语义 + walkable=0）", () => {
    const draft = makeSizedDraft();
    // 谷地场：每列高度 |x-2|*0.1（x2 最低），逐行相同 → 纵向无梯度
    const field = new Float64Array(20);
    for (let y = 0; y < 4; y++) {
      for (let x = 0; x < 5; x++) {
        field[y * 5 + x] = Math.abs(x - 2) * 0.1;
      }
    }
    setAux(draft, HEIGHT_FIELD, field);

    river(makeCtx(draft, { flowThreshold: 3, waterSemantics: 1 }));

    // 每列累积：x0=1 x1=2 x2=5 x3=2 x4=1（x1/x3 各吸收 x0/x4 一股）→ 仅 x2 列 ≥ 3
    for (let y = 0; y < 4; y++) {
      for (let x = 0; x < 5; x++) {
        const index = y * 5 + x;
        if (x === 2) {
          expect(draft.tiles[index]).toBe(1);
          expect(draft.walkable[index]).toBe(0);
        } else {
          expect(draft.tiles[index]).toBe(2);
          expect(draft.walkable[index]).toBe(1);
        }
      }
    }
  });

  it("POSITIVE：非河道格的语义与通行位保持上游输出（不改写 regions）", () => {
    const draft = makeSizedDraft();
    const field = new Float64Array(20);
    for (let y = 0; y < 4; y++) {
      for (let x = 0; x < 5; x++) {
        field[y * 5 + x] = Math.abs(x - 2) * 0.1;
      }
    }
    setAux(draft, HEIGHT_FIELD, field);

    river(makeCtx(draft, { flowThreshold: 3, waterSemantics: 1 }));

    expect([...draft.regions.keys()]).toEqual(["region-a"]);
    expect(draft.regions.get("region-a")?.meta).toEqual({});
  });

  it("POSITIVE：标水不消费 aux 场——HEIGHT_FIELD 原样保留（下游 quantize 仍可读）", () => {
    const draft = makeSizedDraft();
    const field = new Float64Array(20);
    for (let i = 0; i < 20; i++) field[i] = (i % 5) * 0.2;
    setAux(draft, HEIGHT_FIELD, field);

    river(makeCtx(draft, { flowThreshold: 2, waterSemantics: 1 }));

    expect(getAux(draft, HEIGHT_FIELD)).toEqual(field);
  });

  it("POSITIVE：确定性——同场同参数两次输出逐位一致（纯函数无随机性）", () => {
    const makeField = (): Float64Array => {
      const field = new Float64Array(20);
      for (let i = 0; i < 20; i++) field[i] = ((i * 7) % 13) / 13;
      return field;
    };
    const a = makeSizedDraft();
    const b = makeSizedDraft();
    setAux(a, HEIGHT_FIELD, makeField());
    setAux(b, HEIGHT_FIELD, makeField());
    river(makeCtx(a, { flowThreshold: 4, waterSemantics: 1, lakeLevel: 0.15 }));
    river(makeCtx(b, { flowThreshold: 4, waterSemantics: 1, lakeLevel: 0.15 }));
    expect([...b.tiles]).toEqual([...a.tiles]);
    expect([...b.walkable]).toEqual([...a.walkable]);
  });
});

describe("river：湖泊（配置水位）", () => {
  it("POSITIVE：水位以下洼地格标水（无需汇流达标）", () => {
    const draft = makeSizedDraft();
    // 平地 0.5，(1,1) 与 (2,1) 两格凹坑 0.1
    const field = new Float64Array(20).fill(0.5);
    field[6] = 0.1; // (1,1)
    field[7] = 0.1; // (2,1)
    setAux(draft, HEIGHT_FIELD, field);

    river(makeCtx(draft, { flowThreshold: 99, waterSemantics: 1, lakeLevel: 0.2 }));

    expect(draft.tiles[6]).toBe(1);
    expect(draft.walkable[6]).toBe(0);
    expect(draft.tiles[7]).toBe(1);
    expect(draft.walkable[7]).toBe(0);
    // 其余格（0.5 ≥ 水位，汇流 < 99）保持原样
    expect(draft.tiles[0]).toBe(2);
    expect(draft.walkable[0]).toBe(1);
  });

  it("POSITIVE：省略 lakeLevel → 不标湖（仅汇流成水）", () => {
    const draft = makeSizedDraft();
    const field = new Float64Array(20).fill(0.5);
    field[6] = 0.1;
    setAux(draft, HEIGHT_FIELD, field);

    river(makeCtx(draft, { flowThreshold: 99, waterSemantics: 1 }));

    expect(draft.tiles[6]).toBe(2); // 凹坑无汇流达标 → 不标水
    expect([...draft.walkable]).toEqual(new Array(20).fill(1));
  });
});

describe("river：上游衔接", () => {
  it("NEGATIVE：HEIGHT_FIELD 缺失 → 抛错点名上游 height-channel", () => {
    const draft = makeSizedDraft();
    expect(() => river(makeCtx(draft, { flowThreshold: 2, waterSemantics: 1 }))).toThrowError(
      /map "river-test": river requires an upstream "height-channel" step/,
    );
  });

  it("NEGATIVE：HEIGHT_FIELD 长度不符 → 抛错点名期望长度", () => {
    const draft = makeSizedDraft();
    setAux(draft, HEIGHT_FIELD, new Float64Array(8));
    expect(() => river(makeCtx(draft, { flowThreshold: 2, waterSemantics: 1 }))).toThrowError(
      /field\.length=8, expected 20/,
    );
  });

  it("NEGATIVE：未定尺寸草稿 → 抛错点名地图 key 与前置积木要求", () => {
    const draft = createGeometryDraft(KEY);
    expect(() => river(makeCtx(draft, { flowThreshold: 2, waterSemantics: 1 }))).toThrowError(
      /map "river-test": river requires a sized draft/,
    );
  });
});

describe("river：参数 fail-fast", () => {
  it("NEGATIVE：flowThreshold 非整数 / < 2 → 抛错点名 params.flowThreshold", () => {
    const draft = makeSizedDraft();
    expect(() => river(makeCtx(draft, { flowThreshold: 1, waterSemantics: 1 }))).toThrowError(
      /params\.flowThreshold must be an integer >= 2, got 1/,
    );
    expect(() => river(makeCtx(draft, { flowThreshold: 2.5, waterSemantics: 1 }))).toThrowError(
      /params\.flowThreshold must be an integer >= 2, got 2\.5/,
    );
  });

  it("NEGATIVE：waterSemantics 越界 → 抛错点名 params.waterSemantics", () => {
    const draft = makeSizedDraft();
    expect(() => river(makeCtx(draft, { flowThreshold: 2, waterSemantics: 256 }))).toThrowError(
      /params\.waterSemantics must be an integer in \[0, 255\], got 256/,
    );
    expect(() => river(makeCtx(draft, { flowThreshold: 2, waterSemantics: -1 }))).toThrowError(
      /params\.waterSemantics must be an integer in \[0, 255\], got -1/,
    );
  });

  it("NEGATIVE：lakeLevel 越出 (0, 1) → 抛错点名 params.lakeLevel", () => {
    const draft = makeSizedDraft();
    expect(() => river(makeCtx(draft, { flowThreshold: 2, waterSemantics: 1, lakeLevel: 0 }))).toThrowError(
      /params\.lakeLevel must be a number in \(0, 1\), got 0/,
    );
    expect(() => river(makeCtx(draft, { flowThreshold: 2, waterSemantics: 1, lakeLevel: 1 }))).toThrowError(
      /params\.lakeLevel must be a number in \(0, 1\), got 1/,
    );
  });
});

describe("river：管道顺序验证（river → quantize-terrain）", () => {
  it("POSITIVE：完整管道 [sizing+场写入 → river → quantize]——层界带水格被 slope 收编，幸存水格恒不可走", () => {
    // 尺寸 + 已知场写入积木（模拟 height-channel 产物，无随机性）：
    // 高度 [0.9 0.9 | 0.5 0.5 0.5]，量化阈值 0.7 → x0/x1 层 1，x2-x4 层 0
    const sizingField = (ctx: GenerationContext): void => {
      const draft = ctx.geometry;
      draft.width = 5;
      draft.height = 2;
      const { width, height } = draft;
      draft.tileWidth = 16;
      draft.tileHeight = 16;
      draft.tiles = new Uint8Array(10).fill(2);
      draft.walkable = new Uint8Array(10).fill(1);
      draft.regions.set("region-a", { name: "region-a", meta: {} });
      draft.regionOfTile = new Uint16Array(10);
      const field = new Float64Array(width * height);
      for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
          field[y * width + x] = x <= 1 ? 0.9 : 0.5;
        }
      }
      setAux(draft, HEIGHT_FIELD, field);
    };
    const registry = createGeneratorRegistry();
    registry.register("sizing-field", sizingField);
    registry.register("river", river);
    registry.register("quantize-terrain", quantizeTerrain);

    const geometry = buildMapGeometry(
      {
        key: KEY,
        seed: 1,
        pipeline: [
          { generator: "sizing-field" },
          // river：湖泊水位 0.55 标 x2-x4（x0/x1 等高不成流，x2 汇流仅 2 股
          // 未达阈值 3——本用例水格全部来自湖泊）
          { generator: "river", params: { flowThreshold: 3, waterSemantics: 1, lakeLevel: 0.55 } },
          { generator: "quantize-terrain", params: { thresholds: [0.7], maxLevels: 2, slopeSemantics: 7, cliffSemantics: 8 } },
        ],
      },
      registry,
    );

    // 顺序结论 ①：x2 处于层界（Δ=1）→ river 标的水格被 quantize 的 slope
    // 派生收编（证明 quantize 后跑、边界带格归其写）
    expect(geometry.level[2]).toBe(0);
    expect(geometry.level[1]).toBe(1);
    expect(geometry.tiles[2]).toBe(7);
    expect(geometry.tiles[7]).toBe(7); // 第二行同列
    // 顺序结论 ②：远离层界的幸存水格（x3/x4，湖泊）保持水语义且恒不可走
    expect(geometry.tiles[3]).toBe(1);
    expect(geometry.tiles[4]).toBe(1);
    expect(geometry.walkable[3]).toBe(0);
    expect(geometry.walkable[4]).toBe(0);
    // 不变量（任意管道成立）：水语义格 ⟹ walkable=0——水语义只在 river
    // 写入且恒伴随 walkable=0，quantize 派生只会改写为 slope/cliff，
    // 不产生可走水
    for (let i = 0; i < 10; i++) {
      if (geometry.tiles[i] === 1) {
        expect(geometry.walkable[i]).toBe(0);
      }
    }
    // 平坦区 x0 未被触碰（量化不改无层差格）
    expect(geometry.tiles[0]).toBe(2);
    expect(geometry.walkable[0]).toBe(1);
  });
});
