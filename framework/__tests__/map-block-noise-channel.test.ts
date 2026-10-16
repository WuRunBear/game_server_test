/**
 * 生成积木 noise-channel 测试（framework/__tests__/map-block-noise-channel.test.ts）。
 *
 * 覆盖（地图切片 8，通用噪声通道）：
 * - 生产者行为：向配置声明的 aux 槽位写入噪声场（长度 = width×height、
 *   值 ∈ [0, 1)）；不动 tiles/walkable/regions（纯 aux 侧生产者）；
 * - 确定性：同 seed 同 params 两次场逐位一致；cell / seedOffset 改变场形态；
 * - 槽位隔离：同草稿两个实例（不同槽位名）互不污染——各自字段与单独
 *   运行结果逐位一致；同名槽位第二实例 fail-fast（占用即抛错）；
 * - 参数 fail-fast：slot 非法、cell 非正数、seedOffset 非负整数要求、
 *   未定尺寸草稿；
 * - 管道串接：buildMapGeometry 中 [sizing → noise-channel ×2] 双场生产，
 *   冻结无 aux 泄漏。
 */
import { describe, expect, it } from "vitest";

import { noiseChannel } from "map/generate/blocks/noiseChannel";
import { createGeneratorRegistry } from "map/generate/generatorRegistry";
import { buildMapGeometry } from "map/generate/pipeline";
import { createRng } from "map/generate/rng";
import { createGeometryDraft, defineAuxSlot, getAux, type GenerationContext, type GeometryDraft } from "map/generate/types";

/** 测试地图 key。 */
const KEY = "noise-channel-map";

/** 温度/湿度演示槽位名（配置声明，命名约定 "<积木名>.<产物>"）。 */
const SLOT_A = "noise-channel.temperature";
const SLOT_B = "noise-channel.moisture";

/** 构造 8×8 已定尺寸草稿（tiles 全 1、walkable 全 1、单区域全覆盖）。 */
function makeSizedDraft(): GeometryDraft {
  const draft = createGeometryDraft(KEY);
  draft.width = 8;
  draft.height = 8;
  draft.tileWidth = 16;
  draft.tileHeight = 16;
  draft.tiles = new Uint8Array(64).fill(1);
  draft.walkable = new Uint8Array(64).fill(1);
  draft.regions.set("region-a", { name: "region-a", meta: {} });
  draft.regionOfTile = new Uint16Array(64);
  return draft;
}

/** 以给定参数与随机流对草稿跑一次积木。 */
function runBlock(draft: GeometryDraft, params?: unknown, seed = 7): void {
  const ctx: GenerationContext = { key: KEY, rng: createRng(seed), geometry: draft, params };
  noiseChannel(ctx);
}

describe("noise-channel：aux 槽位生产者", () => {
  it("POSITIVE：向配置声明的槽位写入噪声场（长度 = total、值 ∈ [0, 1)）", () => {
    const draft = makeSizedDraft();
    runBlock(draft, { slot: SLOT_A });
    const field = getAux(draft, defineAuxSlot<Float64Array>(SLOT_A));
    expect(field).toBeInstanceOf(Float64Array);
    expect(field).toHaveLength(64);
    for (const value of field!) {
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThan(1);
    }
  });

  it("POSITIVE：不动 tiles/walkable/regions（纯 aux 侧生产者）", () => {
    const draft = makeSizedDraft();
    const tiles = Uint8Array.from(draft.tiles);
    const walkable = Uint8Array.from(draft.walkable);
    runBlock(draft, { slot: SLOT_A });
    expect(draft.tiles).toEqual(tiles);
    expect(draft.walkable).toEqual(walkable);
    expect(draft.regions.get("region-a")?.meta).toEqual({});
  });

  it("POSITIVE：同 seed 同 params 两次场逐位一致（确定性）", () => {
    const a = makeSizedDraft();
    const b = makeSizedDraft();
    runBlock(a, { slot: SLOT_A }, 42);
    runBlock(b, { slot: SLOT_A }, 42);
    expect(getAux(b, defineAuxSlot<Float64Array>(SLOT_A))).toEqual(
      getAux(a, defineAuxSlot<Float64Array>(SLOT_A)),
    );
  });

  it("POSITIVE：cell 与 seedOffset 改变场形态（其余参数相同时场不同）", () => {
    const base = makeSizedDraft();
    const byCell = makeSizedDraft();
    const byOffset = makeSizedDraft();
    runBlock(base, { slot: SLOT_A });
    runBlock(byCell, { slot: SLOT_A, cell: 3 });
    runBlock(byOffset, { slot: SLOT_A, seedOffset: 512 });
    const baseField = getAux(base, defineAuxSlot<Float64Array>(SLOT_A))!;
    expect(getAux(byCell, defineAuxSlot<Float64Array>(SLOT_A))!).not.toEqual(baseField);
    expect(getAux(byOffset, defineAuxSlot<Float64Array>(SLOT_A))!).not.toEqual(baseField);
    // seedOffset 自身也是确定性的：同 offset 两次逐位一致
    const byOffsetAgain = makeSizedDraft();
    runBlock(byOffsetAgain, { slot: SLOT_A, seedOffset: 512 });
    expect(getAux(byOffsetAgain, defineAuxSlot<Float64Array>(SLOT_A))!).toEqual(
      getAux(byOffset, defineAuxSlot<Float64Array>(SLOT_A))!,
    );
  });
});

describe("noise-channel：槽位隔离", () => {
  it("POSITIVE：同草稿两个实例（不同槽位）互不污染——各自与单独运行逐位一致", () => {
    // 单独运行的两个参照场
    const soloA = makeSizedDraft();
    const soloB = makeSizedDraft();
    runBlock(soloA, { slot: SLOT_A, cell: 5 });
    runBlock(soloB, { slot: SLOT_B, cell: 5, seedOffset: 9 });
    // 同草稿串跑两个实例
    const combined = makeSizedDraft();
    runBlock(combined, { slot: SLOT_A, cell: 5 });
    runBlock(combined, { slot: SLOT_B, cell: 5, seedOffset: 9 });
    const slotA = defineAuxSlot<Float64Array>(SLOT_A);
    const slotB = defineAuxSlot<Float64Array>(SLOT_B);
    expect(getAux(combined, slotA)).toEqual(getAux(soloA, slotA));
    expect(getAux(combined, slotB)).toEqual(getAux(soloB, slotB));
  });

  it("NEGATIVE：两实例声明同名槽位 → 第二实例抛错点名占用（fail-fast 不静默覆盖）", () => {
    const draft = makeSizedDraft();
    runBlock(draft, { slot: SLOT_A });
    expect(() => runBlock(draft, { slot: SLOT_A, cell: 3 })).toThrowError(
      /map "noise-channel-map": noise-channel aux slot "noise-channel\.temperature" is already occupied/,
    );
  });
});

describe("noise-channel：参数 fail-fast", () => {
  it("NEGATIVE：未定尺寸草稿 → 抛错点名地图 key 与前置积木要求", () => {
    const draft = createGeometryDraft(KEY);
    expect(() => runBlock(draft, { slot: SLOT_A })).toThrowError(
      /map "noise-channel-map": noise-channel requires a sized draft/,
    );
  });

  it("NEGATIVE：slot 缺失 / 空串 / 非字符串 → 抛错点名 params.slot", () => {
    const draft = makeSizedDraft();
    expect(() => runBlock(draft, {})).toThrowError(
      /params\.slot must be a non-empty string, got undefined/,
    );
    expect(() => runBlock(draft, { slot: "" })).toThrowError(
      /params\.slot must be a non-empty string, got /,
    );
    expect(() => runBlock(draft, { slot: 7 })).toThrowError(
      /params\.slot must be a non-empty string, got 7/,
    );
  });

  it("NEGATIVE：cell 非正数 → 抛错点名 params.cell", () => {
    const draft = makeSizedDraft();
    expect(() => runBlock(draft, { slot: SLOT_A, cell: 0 })).toThrowError(
      /params\.cell must be a positive number, got 0/,
    );
    expect(() => runBlock(draft, { slot: SLOT_A, cell: -2 })).toThrowError(
      /params\.cell must be a positive number, got -2/,
    );
  });

  it("NEGATIVE：seedOffset 负数 / 非整数 → 抛错点名 params.seedOffset", () => {
    const draft = makeSizedDraft();
    expect(() => runBlock(draft, { slot: SLOT_A, seedOffset: -1 })).toThrowError(
      /params\.seedOffset must be a non-negative integer, got -1/,
    );
    expect(() => runBlock(draft, { slot: SLOT_A, seedOffset: 1.5 })).toThrowError(
      /params\.seedOffset must be a non-negative integer, got 1\.5/,
    );
  });
});

describe("noise-channel：管道串接", () => {
  it("POSITIVE：buildMapGeometry 双实例双场生产且冻结无 aux 泄漏", () => {
    // 假 sizing：8×8 实心草稿
    const sizing = (ctx: GenerationContext): void => {
      const draft = ctx.geometry;
      draft.width = 8;
      draft.height = 8;
      draft.tileWidth = 16;
      draft.tileHeight = 16;
      draft.tiles = new Uint8Array(64).fill(1);
      draft.walkable = new Uint8Array(64).fill(1);
      draft.regions.set("region-a", { name: "region-a", meta: {} });
      draft.regionOfTile = new Uint16Array(64);
    };
    const registry = createGeneratorRegistry();
    registry.register("sizing", sizing);
    registry.register("noise-channel", noiseChannel);

    const geometry = buildMapGeometry(
      {
        key: KEY,
        seed: 7,
        pipeline: [
          { generator: "sizing" },
          { generator: "noise-channel", params: { slot: SLOT_A, cell: 4 } },
          { generator: "noise-channel", params: { slot: SLOT_B, cell: 4, seedOffset: 3 } },
        ],
      },
      registry,
    );

    // 双场生产的地理副作用为零（纯 aux 侧），冻结丢弃 aux
    expect(geometry.tiles).toEqual(new Uint8Array(64).fill(1));
    expect(Object.hasOwn(geometry, "aux")).toBe(false);
    expect("aux" in geometry).toBe(false);
  });
});
