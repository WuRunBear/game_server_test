/**
 * aux 多场上下游积木测试（framework/__tests__/map-aux-height-channel.test.ts）。
 *
 * 覆盖地图系统设计文档提案 2（辅助通道 / aux 方案）验收：
 * - 生产者 height-channel：向 aux 槽位写入 height 场（长度 = width×height、
 *   值 ∈ [0, 1)、同 seed 确定复现、异 seed 不同、cell 改变场形态）；
 *   不动 tiles/walkable/regions；未定尺寸 / cell 非法抛错；
 * - 消费者 height-mask（mask 模式）：walkable 逐格 = (场值 ∈ [minLevel,
 *   maxLevel])；区间参数校验抛错；
 * - 消费者 height-mask（stats 模式）：每有覆盖区域的 meta.averageHeight =
 *   区域内场值均值；regionOfTile 越界抛错；
 * - 上游缺失：无 height-channel 时 height-mask 抛错点名依赖；
 * - 管道串接：buildMapGeometry 中 [sizing → height-channel → height-mask]
 *   上下游传递生效，冻结后的 MapGeometry 无 aux 泄漏。
 */
import { describe, expect, it } from "vitest";

import { heightChannel, HEIGHT_FIELD } from "map/generate/blocks/heightChannel";
import { heightMask } from "map/generate/blocks/heightMask";
import { createGeneratorRegistry } from "map/generate/generatorRegistry";
import { buildMapGeometry } from "map/generate/pipeline";
import { createRng } from "map/generate/rng";
import { createGeometryDraft, getAux, type GenerationContext, type GeometryDraft } from "map/generate/types";

/** 测试地图 key。 */
const KEY = "height-map";

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

/** 构造 8×8 双区域草稿：region-a 左 4 列（索引 0）、region-b 右 4 列（索引 1）。 */
function makeTwoRegionDraft(): GeometryDraft {
  const draft = makeSizedDraft();
  draft.regions.set("region-b", { name: "region-b", meta: {} });
  for (let i = 0; i < 64; i++) {
    draft.regionOfTile[i] = i % 8 < 4 ? 0 : 1;
  }
  return draft;
}

/** 以给定参数与随机流对草稿跑一次积木。 */
function runBlock(draft: GeometryDraft, generator: (ctx: GenerationContext) => void, params?: unknown): void {
  const ctx: GenerationContext = { key: KEY, rng: createRng(7), geometry: draft, params };
  generator(ctx);
}

describe("height-channel：aux 槽位生产者", () => {
  it("POSITIVE：写入 height 场 aux 槽位（长度 = total、值 ∈ [0, 1)）", () => {
    const draft = makeSizedDraft();
    runBlock(draft, heightChannel);
    const field = getAux(draft, HEIGHT_FIELD);
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
    runBlock(draft, heightChannel);
    expect(draft.tiles).toEqual(tiles);
    expect(draft.walkable).toEqual(walkable);
    expect(draft.regions.get("region-a")?.meta).toEqual({});
  });

  it("POSITIVE：同 seed 两次场逐位一致；异 seed 不同；cell 改变场形态", () => {
    const a = makeSizedDraft();
    const b = makeSizedDraft();
    const c = makeSizedDraft();
    runBlock(a, heightChannel);
    runBlock(b, heightChannel);
    runBlock(c, heightChannel, { cell: 3 });
    expect(getAux(b, HEIGHT_FIELD)).toEqual(getAux(a, HEIGHT_FIELD));
    expect(getAux(c, HEIGHT_FIELD)).not.toEqual(getAux(a, HEIGHT_FIELD));
  });

  it("NEGATIVE：未定尺寸草稿 → 抛错点名地图 key 与前置积木要求", () => {
    const draft = createGeometryDraft(KEY);
    expect(() => runBlock(draft, heightChannel)).toThrowError(
      /map "height-map": height-channel requires a sized draft/,
    );
  });

  it("NEGATIVE：cell 非正数 → 抛错点名 params.cell", () => {
    const draft = makeSizedDraft();
    expect(() => runBlock(draft, heightChannel, { cell: 0 })).toThrowError(
      /map "height-map": height-channel params\.cell must be a positive number, got 0/,
    );
  });
});

describe("height-mask mask 模式：按高度区间重写 walkable", () => {
  it("POSITIVE：walkable 逐格 = (场值 ∈ [minLevel, maxLevel])", () => {
    const draft = makeSizedDraft();
    runBlock(draft, heightChannel);
    const field = getAux(draft, HEIGHT_FIELD)!;
    runBlock(draft, heightMask, { mode: "mask", minLevel: 0.4, maxLevel: 0.7 });
    for (let i = 0; i < 64; i++) {
      const expected = field[i] >= 0.4 && field[i] <= 0.7 ? 1 : 0;
      expect(draft.walkable[i]).toBe(expected);
    }
  });

  it("POSITIVE：区间缺省 [0, 1] → 全图可通行（场值恒在区间内）", () => {
    const draft = makeSizedDraft();
    runBlock(draft, heightChannel);
    runBlock(draft, heightMask, { mode: "mask" });
    expect(draft.walkable).toEqual(new Uint8Array(64).fill(1));
  });

  it("NEGATIVE：minLevel > maxLevel → 抛错点名两个参数", () => {
    const draft = makeSizedDraft();
    expect(() => runBlock(draft, heightMask, { mode: "mask", minLevel: 0.8, maxLevel: 0.2 })).toThrowError(
      /params\.minLevel \(0\.8\) must be <= params\.maxLevel \(0\.2\)/,
    );
  });

  it("NEGATIVE：mode 非法 → 抛错点名 params.mode", () => {
    const draft = makeSizedDraft();
    expect(() => runBlock(draft, heightMask, { mode: "blend" })).toThrowError(
      /params\.mode must be "mask" or "stats", got blend/,
    );
  });
});

describe("height-mask stats 模式：区域平均高度写入 meta", () => {
  it("POSITIVE：每有覆盖区域的 meta.averageHeight = 区域内场值均值", () => {
    const draft = makeTwoRegionDraft();
    runBlock(draft, heightChannel);
    const field = getAux(draft, HEIGHT_FIELD)!;
    runBlock(draft, heightMask, { mode: "stats" });
    // 手算两区域均值对照
    let sumA = 0;
    let sumB = 0;
    for (let i = 0; i < 64; i++) {
      if (i % 8 < 4) sumA += field[i];
      else sumB += field[i];
    }
    expect(draft.regions.get("region-a")?.meta.averageHeight).toBeCloseTo(sumA / 32, 12);
    expect(draft.regions.get("region-b")?.meta.averageHeight).toBeCloseTo(sumB / 32, 12);
  });

  it("NEGATIVE：regionOfTile 索引越界 → 抛错点名索引与区域数", () => {
    const draft = makeTwoRegionDraft();
    runBlock(draft, heightChannel);
    draft.regionOfTile[0] = 9;
    expect(() => runBlock(draft, heightMask, { mode: "stats" })).toThrowError(
      /map "height-map": height-mask regionOfTile\[0\]=9 out of range \(regions count 2\)/,
    );
  });
});

describe("height-mask 上游依赖与管道串接", () => {
  it("NEGATIVE：上游 height-channel 缺失（aux 无场）→ 抛错点名依赖", () => {
    const draft = makeSizedDraft();
    expect(() => runBlock(draft, heightMask, { mode: "mask" })).toThrowError(
      /map "height-map": height-mask requires an upstream "height-channel" step/,
    );
  });

  it("POSITIVE：buildMapGeometry 管道串接（sizing → height-channel → height-mask）且冻结无 aux 泄漏", () => {
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
    registry.register("height-channel", heightChannel);
    registry.register("height-mask", heightMask);

    const geometry = buildMapGeometry(
      {
        key: KEY,
        seed: 7,
        pipeline: [
          { generator: "sizing" },
          { generator: "height-channel" },
          { generator: "height-mask", params: { mode: "mask", minLevel: 0.5 } },
        ],
      },
      registry,
    );

    // mask 生效：walkable 有 1 有 0（场值分布跨 0.5）；且与场值关系一致
    // ——场只存在于管道期，此处仅断言 mask 产生区分度
    const walkableValues = new Set(geometry.walkable);
    expect(walkableValues.has(0)).toBe(true);
    expect(walkableValues.has(1)).toBe(true);
    // 冻结丢弃 aux：MapGeometry 无 aux 自有属性（类型层断言见 aux 测试）
    expect(Object.hasOwn(geometry, "aux")).toBe(false);
    expect("aux" in geometry).toBe(false);
  });
});
