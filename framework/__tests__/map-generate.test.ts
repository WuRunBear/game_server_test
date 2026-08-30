/**
 * 生成层骨架测试（framework/__tests__/map-generate.test.ts）。
 *
 * 覆盖计划 todo 2 验收：
 * - 管道：假积木按声明顺序执行；params 原样透传（各步只收到自己的切片）；
 *   每步从总 seed + 步骤序号派生独立且确定的随机流；
 * - rng：同 seed 同序列、异 seed 异序列、派生流确定且相互独立；
 * - validate：区域缺失 / 尺寸不一致 / regionOfTile 索引越界各自抛出
 *   点名具体问题的错误（含地图 key）；零覆盖区域仅告警不阻断；
 * - 端到端：假积木经 buildMapGeometry 产出含内容指纹的合法 MapGeometry，
 *   同配置深相等（确定性）、异 seed 版本不同。
 */
import { describe, expect, it } from "vitest";

import { createGeneratorRegistry, type GeneratorRegistry } from "map/generate/generatorRegistry";
import { buildMapGeometry } from "map/generate/pipeline";
import { createRng, deriveStream, type Rng } from "map/generate/rng";
import { validateMapGeometry } from "map/generate/validate";
import {
  createGeometryDraft,
  type GenerationContext,
  type GeometryDraft,
  type MapGenerationConfig,
  type MapGenerator,
} from "map/generate/types";
import { computeGeometryVersion } from "map/geometry/version";

/** 采集随机流序列的长度（足够区分不同序列）。 */
const SAMPLE = 8;

/** 采集一条随机流的 next() 序列。 */
function sampleNext(rng: Rng): number[] {
  return Array.from({ length: SAMPLE }, () => rng.next());
}

/** fillDraft 的可选填充参数：rng 注入、随机语义 id 写入数、声明区域集。 */
interface FillOptions {
  /** 随机流（注入后向 tiles 写入 consume 个随机语义 id）。 */
  rng?: Rng | null;
  /** 向 tiles 写入的随机语义 id 个数（供确定性断言）。 */
  consume?: number;
  /** 声明的区域名（regionOfTile 全 0 → 首个区域覆盖全图，其余零覆盖）。 */
  regionNames?: string[];
}

/**
 * 假积木共用的草稿填充：设定 4×4/16px 网格、分配缓冲、声明区域。
 */
function fillDraft(draft: GeometryDraft, opts: FillOptions = {}): void {
  const rng = opts.rng ?? null;
  const consume = opts.consume ?? 0;
  draft.width = 4;
  draft.height = 4;
  draft.tileWidth = 16;
  draft.tileHeight = 16;
  draft.tiles = new Uint8Array(16);
  draft.walkable = new Uint8Array(16).fill(1);
  draft.regionOfTile = new Uint16Array(16);
  for (const name of opts.regionNames ?? ["region-a"]) {
    draft.regions.set(name, { name, meta: {} });
  }
  for (let i = 0; i < consume; i++) {
    draft.tiles[i] = rng ? rng.int(4) : 0;
  }
}

/** 构造注册了给定积木的注册表。 */
function makeRegistry(entries: Array<[string, MapGenerator]>): GeneratorRegistry {
  const registry = createGeneratorRegistry();
  for (const [id, gen] of entries) {
    registry.register(id, gen);
  }
  return registry;
}

/** 记录调用序的假积木：调用名入 calls，草稿填充为合法最小图。 */
function recordingBlock(calls: string[], name: string): MapGenerator {
  return (ctx: GenerationContext) => {
    calls.push(name);
    fillDraft(ctx.geometry);
  };
}

/** 构造一个结构合法的最小草稿（2×2，单区域全覆盖）。 */
function makeValidDraft(): GeometryDraft {
  const draft = createGeometryDraft("vmap");
  draft.width = 2;
  draft.height = 2;
  draft.tileWidth = 16;
  draft.tileHeight = 16;
  draft.tiles = new Uint8Array(4);
  draft.walkable = new Uint8Array(4).fill(1);
  draft.regions.set("region-a", { name: "region-a", meta: {} });
  draft.regionOfTile = new Uint16Array(4);
  return draft;
}

describe("rng 可复现随机流", () => {
  it("POSITIVE：同 seed 两次创建产生完全相同的序列", () => {
    expect(sampleNext(createRng(42))).toEqual(sampleNext(createRng(42)));
  });

  it("POSITIVE：异 seed 产生不同序列", () => {
    expect(sampleNext(createRng(42))).not.toEqual(sampleNext(createRng(43)));
  });

  it("POSITIVE：int(maxExclusive) 落在 [0, maxExclusive) 且确定", () => {
    const a = Array.from({ length: 64 }, () => createRng(7).int(4));
    const b = Array.from({ length: 64 }, () => createRng(7).int(4));
    expect(b).toEqual(a);
    for (const v of a) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(4);
    }
  });

  it("POSITIVE：deriveStream 同 (seed, stepIndex) 确定复现", () => {
    expect(sampleNext(deriveStream(1000, 2))).toEqual(sampleNext(deriveStream(1000, 2)));
  });

  it("POSITIVE：不同 stepIndex 派生相互独立的流", () => {
    expect(sampleNext(deriveStream(1000, 0))).not.toEqual(sampleNext(deriveStream(1000, 1)));
  });

  it("POSITIVE：派生键无串接歧义（seed=1,step=23 ≠ seed=12,step=3）", () => {
    expect(sampleNext(deriveStream(1, 23))).not.toEqual(sampleNext(deriveStream(12, 3)));
  });
});

describe("validateMapGeometry 结构校验", () => {
  it("POSITIVE：结构合法的草稿通过校验不抛错", () => {
    expect(() => validateMapGeometry(makeValidDraft())).not.toThrow();
  });

  it("NEGATIVE：tiles 长度与 width*height 不一致 → 抛错点名 tiles 与地图 key", () => {
    const draft = makeValidDraft();
    draft.tiles = new Uint8Array(3);
    expect(() => validateMapGeometry(draft)).toThrowError(/map "vmap": tiles length 3 != width\*height 4/);
  });

  it("NEGATIVE：walkable 长度不一致 → 抛错点名 walkable", () => {
    const draft = makeValidDraft();
    draft.walkable = new Uint8Array(5);
    expect(() => validateMapGeometry(draft)).toThrowError(/walkable length 5 != width\*height 4/);
  });

  it("NEGATIVE：regionOfTile 长度不一致 → 抛错点名 regionOfTile", () => {
    const draft = makeValidDraft();
    draft.regionOfTile = new Uint16Array(2);
    expect(() => validateMapGeometry(draft)).toThrowError(/regionOfTile length 2 != width\*height 4/);
  });

  it("NEGATIVE：regions 为空（区域覆盖缺失）→ 抛错点名 regions", () => {
    const draft = makeValidDraft();
    draft.regions.clear();
    expect(() => validateMapGeometry(draft)).toThrowError(/map "vmap": regions is empty/);
  });

  it("NEGATIVE：regionOfTile 索引越界 → 抛错点名索引与 regions 数量", () => {
    const draft = makeValidDraft();
    draft.regionOfTile[3] = 5;
    expect(() => validateMapGeometry(draft)).toThrowError(
      /regionOfTile\[3\]=5 out of range \(regions count 1\)/,
    );
  });

  it("NEGATIVE：零尺寸网格 → 抛错点名 grid 为空", () => {
    const draft = createGeometryDraft("empty-map");
    expect(() => validateMapGeometry(draft)).toThrowError(/map "empty-map": grid is empty/);
  });

  it("POSITIVE：已声明但零覆盖的区域仅告警，不抛错不阻断", () => {
    const draft = makeValidDraft();
    draft.regions.set("region-b", { name: "region-b", meta: {} });
    expect(() => validateMapGeometry(draft)).not.toThrow();
  });

  it("POSITIVE：冻结后的 MapGeometry 同样可校验", () => {
    const registry = makeRegistry([
      ["fill", (ctx) => fillDraft(ctx.geometry, { rng: ctx.rng })],
    ]);
    const geometry = buildMapGeometry(
      { key: "frozen-map", seed: 1, pipeline: [{ generator: "fill" }] },
      registry,
    );
    expect(() => validateMapGeometry(geometry)).not.toThrow();
  });
});

describe("buildMapGeometry 管道执行", () => {
  it("POSITIVE：假积木按管道声明顺序执行", () => {
    const calls: string[] = [];
    const registry = makeRegistry([
      ["block-a", recordingBlock(calls, "block-a")],
      ["block-b", recordingBlock(calls, "block-b")],
      ["block-c", recordingBlock(calls, "block-c")],
    ]);

    buildMapGeometry(
      {
        key: "order-map",
        seed: 1,
        pipeline: [{ generator: "block-c" }, { generator: "block-a" }, { generator: "block-b" }],
      },
      registry,
    );

    expect(calls).toEqual(["block-c", "block-a", "block-b"]);
  });

  it("POSITIVE：params 原样透传——每步只收到自己的切片，缺省为空对象", () => {
    const seen: unknown[] = [];
    const registry = makeRegistry([
      ["probe-0", (ctx) => {
        seen[0] = ctx.params;
        fillDraft(ctx.geometry);
      }],
      ["probe-1", (ctx) => {
        seen[1] = ctx.params;
      }],
      ["probe-2", (ctx) => {
        seen[2] = ctx.params;
        fillDraft(ctx.geometry);
      }],
    ]);
    const params0 = { level: 3 };
    const params1 = { count: 9 };

    buildMapGeometry(
      {
        key: "params-map",
        seed: 1,
        pipeline: [
          { generator: "probe-0", params: params0 },
          { generator: "probe-1", params: params1 },
          { generator: "probe-2" },
        ],
      },
      registry,
    );

    expect(seen[0]).toBe(params0);
    expect(seen[1]).toBe(params1);
    expect(seen[2]).toEqual({});
  });

  it("POSITIVE：各步骤获得独立且确定的派生随机流", () => {
    const seqs: number[][] = [];
    const registry = makeRegistry([
      ["draw", (ctx) => {
        seqs.push([ctx.rng.next(), ctx.rng.next(), ctx.rng.next()]);
      }],
      ["fill", (ctx) => fillDraft(ctx.geometry)],
    ]);
    const config: MapGenerationConfig = {
      key: "stream-map",
      seed: 99,
      pipeline: [{ generator: "draw" }, { generator: "draw" }, { generator: "fill" }],
    };

    buildMapGeometry(config, registry);
    expect(seqs).toHaveLength(2);
    expect(seqs[0]).not.toEqual(seqs[1]);

    // 同配置重跑：两条步骤流各自确定复现
    const firstRun = seqs.map((s) => [...s]);
    seqs.length = 0;
    buildMapGeometry(config, registry);
    expect(seqs[0]).toEqual(firstRun[0]);
    expect(seqs[1]).toEqual(firstRun[1]);
  });

  it("U5：管道引用未注册积木 → 抛错含地图 key、步骤序号与积木名", () => {
    const registry = makeRegistry([]);
    expect(() =>
      buildMapGeometry({ key: "ghost-map", seed: 1, pipeline: [{ generator: "ghost" }] }, registry),
    ).toThrowError(/map "ghost-map" pipeline step 0: generator "ghost" is not registered/);
  });

  it("NEGATIVE：空管道 → 出口校验抛错含地图 key 与原因", () => {
    const registry = makeRegistry([]);
    expect(() => buildMapGeometry({ key: "bare-map", seed: 1, pipeline: [] }, registry)).toThrowError(
      /map "bare-map": grid is empty/,
    );
  });

  it("NEGATIVE：积木产出结构非法草稿 → buildMapGeometry 抛错含地图 key 与原因", () => {
    const registry = makeRegistry([
      ["broken", (ctx) => {
        const draft = ctx.geometry;
        draft.width = 4;
        draft.height = 4;
        draft.tileWidth = 16;
        draft.tileHeight = 16;
        draft.tiles = new Uint8Array(15);
        draft.walkable = new Uint8Array(16).fill(1);
        draft.regions.set("region-a", { name: "region-a", meta: {} });
        draft.regionOfTile = new Uint16Array(16);
      }],
    ]);

    expect(() =>
      buildMapGeometry({ key: "bad-map", seed: 1, pipeline: [{ generator: "broken" }] }, registry),
    ).toThrowError(/map "bad-map": tiles length 15 != width\*height 16/);
  });
});

describe("buildMapGeometry 端到端冻结", () => {
  const makeConfig = (seed: number): MapGenerationConfig => ({
    key: "e2e-map",
    seed,
    pipeline: [{ generator: "fill", params: { consume: 16 } }],
  });
  const registry = makeRegistry([
    ["fill", (ctx) => {
      const params = ctx.params as { consume?: number };
      fillDraft(ctx.geometry, { rng: ctx.rng, consume: params.consume });
    }],
  ]);

  it("POSITIVE：产出合法 MapGeometry，version 为内容指纹", () => {
    const geometry = buildMapGeometry(makeConfig(7), registry);

    expect(geometry.key).toBe("e2e-map");
    expect(geometry.grid).toEqual({ width: 4, height: 4, tileWidth: 16, tileHeight: 16 });
    expect(geometry.tiles).toBeInstanceOf(Uint8Array);
    expect(geometry.walkable).toBeInstanceOf(Uint8Array);
    expect(geometry.regionOfTile).toBeInstanceOf(Uint16Array);
    expect(geometry.regions.get("region-a")).toEqual({ name: "region-a", meta: {} });
    expect(geometry.version).toBe(computeGeometryVersion(geometry));
  });

  it("U1：同配置两次生成深相等（确定性）", () => {
    expect(buildMapGeometry(makeConfig(7), registry)).toEqual(buildMapGeometry(makeConfig(7), registry));
  });

  it("U1：异 seed 生成结果不同（版本指纹不同）", () => {
    const a = buildMapGeometry(makeConfig(7), registry);
    const b = buildMapGeometry(makeConfig(8), registry);
    expect(b.version).not.toBe(a.version);
    expect(b.tiles).not.toEqual(a.tiles);
  });

  it("POSITIVE：零覆盖区域仅告警，冻结照常成功", () => {
    const warnRegistry = makeRegistry([
      ["fill", (ctx) => fillDraft(ctx.geometry, { regionNames: ["region-a", "region-b"] })],
    ]);

    const geometry = buildMapGeometry(makeConfig(7), warnRegistry);

    expect(geometry.regions.has("region-b")).toBe(true);
    expect(geometry.version).toBe(computeGeometryVersion(geometry));
  });
});
