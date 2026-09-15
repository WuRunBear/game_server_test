/**
 * smooth-terrain 生成积木测试（framework/__tests__/map-block-smooth-terrain.test.ts）。
 *
 * 覆盖地图系统设计文档提案 1（精修）+ 提案 4（有界收敛）验收：
 * - 单轮算子：孤立格被 4-邻域吞并；实心块内部与多数平直边界不变；
 * - 定点收敛：足够轮数后输出是 smoothRound 的不动点（再跑一轮零变更）；
 * - maxRounds 有界：棋盘振荡图案在 maxRounds 轮截断，1 轮与 200 轮
 *   输出不同（上限真实生效）、同 maxRounds 确定复现；
 * - maxRounds=0：tiles 原样保留（零轮迭代）；
 * - 语义 → 通行重派生：提供 nonWalkableSemantics 时 walkable 与最终
 *   tiles 逐格一致；不提供时 walkable 原样；
 * - 参数校验：maxRounds 负数/非整数、nonWalkableSemantics 非法抛错；
 * - 前置约束：未定尺寸草稿抛错点名地图 key；
 * - 管道接入：经 buildMapGeometry 在 noise-terrain 后叠用产出合法几何。
 */
import { describe, expect, it } from "vitest";

import { climateRegions } from "map/generate/blocks/climateRegions";
import { noiseTerrain } from "map/generate/blocks/noiseTerrain";
import { smoothRound, smoothTerrain } from "map/generate/blocks/smoothTerrain";
import { createGeneratorRegistry } from "map/generate/generatorRegistry";
import { buildMapGeometry } from "map/generate/pipeline";
import { createRng, type Rng } from "map/generate/rng";
import { createGeometryDraft, type GenerationContext, type GeometryDraft } from "map/generate/types";

/** 测试地图 key。 */
const KEY = "smooth-map";

/** 语义 id：背景（实心）与斑点（被吞并目标）。 */
const BG = 1;
const SPOT = 2;

/** 构造 6×6 草稿（tiles 由用例填写、walkable 全 1）。 */
function makeDraft(tiles: number[]): GeometryDraft {
  const draft = createGeometryDraft(KEY);
  draft.width = 6;
  draft.height = 6;
  draft.tileWidth = 16;
  draft.tileHeight = 16;
  draft.tiles = new Uint8Array(tiles);
  draft.walkable = new Uint8Array(36).fill(1);
  draft.regions.set("region-a", { name: "region-a", meta: {} });
  draft.regionOfTile = new Uint16Array(36);
  return draft;
}

/** 以给定参数对草稿跑一次积木。 */
function runBlock(draft: GeometryDraft, params?: unknown): void {
  const ctx: GenerationContext = { key: KEY, rng: createRng(1), geometry: draft, params };
  smoothTerrain(ctx);
}

describe("smoothRound 单轮算子", () => {
  it("POSITIVE：孤立格被 4-邻域吞并", () => {
    const tiles = new Uint8Array(36).fill(BG);
    tiles[14] = SPOT; // 中心孤点：4 邻全 BG
    const [next, changed] = smoothRound(tiles, 6, 6);
    expect(changed).toBe(1);
    expect(next[14]).toBe(BG);
  });

  it("POSITIVE：实心块内部与平直边界格不变", () => {
    // 上半 SPOT 下半 BG 的平直边界：内部格自身即 5 格众数 → 全不变
    const tiles = new Uint8Array(36);
    for (let y = 0; y < 6; y++) {
      for (let x = 0; x < 6; x++) {
        tiles[y * 6 + x] = y < 3 ? SPOT : BG;
      }
    }
    const [next, changed] = smoothRound(tiles, 6, 6);
    expect(changed).toBe(0);
    expect(next).toEqual(tiles);
  });

  it("POSITIVE：并列最高频取语义 id 最小者（确定性平局规则）", () => {
    // 中心 (2,2) self=5；左/上邻=3（2 次）、右/下邻=7（2 次）→ 3 与 7 并列
    // 最高频，平局规则取最小 id 3（若实现取最大 id 会得 7，用例即失败）
    const tiles = new Uint8Array(36).fill(3);
    tiles[14] = 5;
    tiles[15] = 7;
    tiles[20] = 7;
    const [next] = smoothRound(tiles, 6, 6);
    expect(next[14]).toBe(3);
  });

  it("POSITIVE：自身即唯一众数 → 不变", () => {
    const tiles = new Uint8Array(36).fill(3);
    tiles[0] = 5; // (0,0)：右邻 3、下邻 3 → 3 出现 2 次 > 5 出现 1 次 → 变 3
    tiles[3 * 6 + 3] = 5; // 中心 (3,3)：4 邻全 3、self=5 → 3 出现 4 次 → 变 3
    const [next] = smoothRound(tiles, 6, 6);
    expect(next[0]).toBe(3);
    expect(next[3 * 6 + 3]).toBe(3);
  });

  it("POSITIVE：多数压倒自身 → 换成多数语义", () => {
    const tiles = new Uint8Array(36).fill(SPOT);
    tiles[14] = BG; // 中心 1 格 BG：4 邻全 SPOT → 吞并为 SPOT
    const [next, changed] = smoothRound(tiles, 6, 6);
    expect(changed).toBe(1);
    expect(next[14]).toBe(SPOT);
  });
});

describe("smoothTerrain 定点收敛与有界性", () => {
  it("POSITIVE：足够轮数后输出为算子不动点（再跑一轮零变更）", () => {
    // 实心背景 + 随机稀疏斑点：数轮内收敛
    const tiles = new Uint8Array(36).fill(BG);
    tiles[7] = SPOT;
    tiles[21] = SPOT;
    tiles[28] = SPOT;
    const draft = makeDraft([...tiles]);
    runBlock(draft, { maxRounds: 50 });
    const [, changed] = smoothRound(draft.tiles, 6, 6);
    expect(changed).toBe(0);
  });

  it("POSITIVE：maxRounds 上限真实生效——棋盘振荡图案被截断且确定复现", () => {
    // 棋盘格：每轮整图翻转（永不收敛）→ 输出由 maxRounds 截断决定
    const checker = (): number[] =>
      Array.from({ length: 36 }, (_, i) => ((i + Math.floor(i / 6)) % 2 === 0 ? BG : SPOT));
    const draft1 = makeDraft(checker());
    const draft2 = makeDraft(checker());
    const draft3 = makeDraft(checker());
    runBlock(draft1, { maxRounds: 1 });
    runBlock(draft2, { maxRounds: 200 });
    runBlock(draft3, { maxRounds: 200 });
    // 1 轮与 200 轮状态不同（棋盘每轮全翻 → 上限真实生效）
    expect(draft2.tiles).not.toEqual(draft1.tiles);
    // 同 maxRounds 确定复现
    expect(draft3.tiles).toEqual(draft2.tiles);
    // 200 轮（偶数）后回到与初始同相位的棋盘（每轮全翻转）
    expect(draft2.tiles).toEqual(Uint8Array.from(checker()));
  });

  it("POSITIVE：maxRounds=0 → 零轮迭代，tiles/walkable 原样", () => {
    const tiles = new Uint8Array(36).fill(BG);
    tiles[14] = SPOT;
    const draft = makeDraft([...tiles]);
    const walkable = Uint8Array.from(draft.walkable);
    runBlock(draft, { maxRounds: 0 });
    expect(draft.tiles).toEqual(Uint8Array.from(tiles));
    expect(draft.walkable).toEqual(walkable);
  });

  it("POSITIVE：缺省参数（省略 params）等价于 maxRounds=8", () => {
    const tiles = Array.from({ length: 36 }, (_, i) => (i % 5 === 0 ? SPOT : BG));
    const omitted = makeDraft(tiles);
    const explicit = makeDraft(tiles);
    runBlock(omitted);
    runBlock(explicit, { maxRounds: 8 });
    expect(omitted.tiles).toEqual(explicit.tiles);
  });
});

describe("smoothTerrain 通行重派生与校验", () => {
  it("POSITIVE：提供 nonWalkableSemantics → walkable 与最终 tiles 逐格一致", () => {
    const tiles = new Uint8Array(36).fill(BG);
    tiles[14] = SPOT;
    const draft = makeDraft([...tiles]);
    runBlock(draft, { maxRounds: 4, nonWalkableSemantics: [SPOT] });
    // 平滑后 SPOT 被吞并 → 全图 BG → 全图可通行
    expect(draft.tiles[14]).toBe(BG);
    expect(draft.walkable).toEqual(new Uint8Array(36).fill(1));
  });

  it("POSITIVE：不提供 nonWalkableSemantics → walkable 原样保留", () => {
    const tiles = new Uint8Array(36).fill(BG);
    tiles[14] = SPOT;
    const draft = makeDraft([...tiles]);
    const walkable = Uint8Array.from(draft.walkable);
    runBlock(draft);
    expect(draft.walkable).toEqual(walkable);
  });

  it("NEGATIVE：maxRounds 负数 / 非整数 → 抛错点名 params.maxRounds", () => {
    const draft = makeDraft(new Array(36).fill(BG));
    expect(() => runBlock(draft, { maxRounds: -1 })).toThrowError(
      /map "smooth-map": smooth-terrain params\.maxRounds must be a non-negative integer, got -1/,
    );
    expect(() => runBlock(draft, { maxRounds: 1.5 })).toThrowError(
      /params\.maxRounds must be a non-negative integer, got 1\.5/,
    );
  });

  it("NEGATIVE：nonWalkableSemantics 非数组 / 条目越界 → 抛错点名", () => {
    const draft = makeDraft(new Array(36).fill(BG));
    expect(() => runBlock(draft, { nonWalkableSemantics: "x" })).toThrowError(
      /params\.nonWalkableSemantics must be an array of semantic ids/,
    );
    expect(() => runBlock(draft, { nonWalkableSemantics: [300] })).toThrowError(
      /params\.nonWalkableSemantics entries must be integers in \[0, 255\], got 300/,
    );
  });

  it("NEGATIVE：未定尺寸草稿 → 抛错点名地图 key 与前置积木要求", () => {
    const draft = createGeometryDraft(KEY);
    expect(() => runBlock(draft)).toThrowError(
      /map "smooth-map": smooth-terrain requires a sized draft/,
    );
  });

  it("POSITIVE：管道接入——noise-terrain → climate-regions → smooth-terrain 产出合法 MapGeometry", () => {
    const registry = createGeneratorRegistry();
    registry.register("noise-terrain", noiseTerrain);
    registry.register("climate-regions", climateRegions);
    registry.register("smooth-terrain", smoothTerrain);
    const geometry = buildMapGeometry(
      {
        key: KEY,
        seed: 42,
        pipeline: [
          {
            generator: "noise-terrain",
            params: {
              width: 24,
              height: 24,
              tileWidth: 16,
              tileHeight: 16,
              bandLevel: 0.3,
              groundPalette: { "7": 0.3, "3": 0.6, "5": 1 },
              nonWalkableSemantics: [7],
            },
          },
          { generator: "climate-regions", params: { names: ["zone-a", "zone-b"], style: "noise" } },
          { generator: "smooth-terrain", params: { maxRounds: 6, nonWalkableSemantics: [7] } },
        ],
      },
      registry,
    );
    expect(geometry.tiles).toHaveLength(24 * 24);
    expect(geometry.regions.size).toBeGreaterThanOrEqual(2);
    // 重派生后语义 → 通行逐格一致
    for (let i = 0; i < geometry.tiles.length; i++) {
      expect(geometry.walkable[i]).toBe(geometry.tiles[i] === 7 ? 0 : 1);
    }
    expect(geometry.version).not.toBe("");
  });
});
