/**
 * 生成积木 whittaker-regions 测试（framework/__tests__/map-block-whittaker-regions.test.ts）。
 *
 * 覆盖（地图切片 8，温度×湿度查表分区）：
 * - 查表正确性：构造已知温度/湿度场断言每格区域归属（含阈值边界值归上带、
 *   regions 插入序 = 行主序首次出现序）；
 * - 零覆盖表项不进 regions（无零覆盖软告警源）；
 * - minArea 重平衡：面积不足区域并入相邻区域（接触最多者、平局取插入序
 *   在前者），regions 表重建后每格索引可解析；
 * - 上游衔接：温度/湿度场缺失（槽位无场或长度不符）抛错点名槽位；
 *   两槽位同名抛错；
 * - 参数 fail-fast：table 行/列维数、行等长、区域名非空/重复/保留名、
 *   阈值升序与值域、minArea 非法、未定尺寸草稿；
 * - 管道串接：buildMapGeometry 中 [sizing → noise-channel ×2 → whittaker]
 *   经真实噪声场产出合法区域划分。
 */
import { describe, expect, it } from "vitest";

import { noiseChannel } from "map/generate/blocks/noiseChannel";
import { whittakerRegions } from "map/generate/blocks/whittakerRegions";
import { createGeneratorRegistry } from "map/generate/generatorRegistry";
import { buildMapGeometry } from "map/generate/pipeline";
import { createRng } from "map/generate/rng";
import { createGeometryDraft, defineAuxSlot, setAux, type GenerationContext, type GeometryDraft } from "map/generate/types";

/** 测试地图 key。 */
const KEY = "whittaker-test";

/** 测试用槽位名。 */
const TEMP_SLOT = "test.temperature";
const MOIST_SLOT = "test.moisture";

/** 构造 4×4 已定尺寸草稿（tiles 全 1、walkable 全 1、单区域全覆盖）。 */
function makeSizedDraft(): GeometryDraft {
  const draft = createGeometryDraft(KEY);
  draft.width = 4;
  draft.height = 4;
  draft.tileWidth = 16;
  draft.tileHeight = 16;
  draft.tiles = new Uint8Array(16).fill(1);
  draft.walkable = new Uint8Array(16).fill(1);
  draft.regions.set("region-a", { name: "region-a", meta: {} });
  draft.regionOfTile = new Uint16Array(16);
  return draft;
}

/** 以给定参数对草稿跑一次积木（无随机性，rng 仅占位）。 */
function runBlock(draft: GeometryDraft, params?: unknown): void {
  const ctx: GenerationContext = { key: KEY, rng: createRng(1), geometry: draft, params };
  whittakerRegions(ctx);
}

/** 向草稿写入已知温度/湿度场：温度按列 0/0.25/0.5/0.75，湿度按行 0/0.3/0.6/0.9。 */
function writeKnownFields(draft: GeometryDraft): void {
  const temp = new Float64Array(16);
  const moist = new Float64Array(16);
  for (let y = 0; y < 4; y++) {
    for (let x = 0; x < 4; x++) {
      temp[y * 4 + x] = x * 0.25;
      moist[y * 4 + x] = y * 0.3;
    }
  }
  setAux(draft, defineAuxSlot<Float64Array>(TEMP_SLOT), temp);
  setAux(draft, defineAuxSlot<Float64Array>(MOIST_SLOT), moist);
}

/** 2×3 演示表：行 = 温度带（冷/热），列 = 湿度带（干/中/湿）。 */
const TABLE_2X3 = [
  ["tundra", "taiga", "boreal"],
  ["desert", "savanna", "jungle"],
];

describe("whittaker-regions：查表正确性", () => {
  it("POSITIVE：已知场逐格命中表项（边界值 0.5 归上带）且插入序 = 首次出现序", () => {
    const draft = makeSizedDraft();
    writeKnownFields(draft);

    runBlock(draft, {
      temperatureSlot: TEMP_SLOT,
      moistureSlot: MOIST_SLOT,
      rowThresholds: [0.5],
      colThresholds: [0.4, 0.8],
      table: TABLE_2X3,
    });

    // 温度带：x0(0)→冷 x1(0.25)→冷 x2(0.5 边界归上)→热 x3(0.75)→热
    // 湿度带：y0(0)/y1(0.3)→干 y2(0.6)→中 y3(0.9)→湿
    // 首次出现序（行主序）：tundra0 desert1 taiga2 savanna3 boreal4 jungle5
    expect(Array.from(draft.regionOfTile)).toEqual([
      0, 0, 1, 1, // y0：tundra tundra desert desert
      0, 0, 1, 1, // y1：tundra tundra desert desert
      2, 2, 3, 3, // y2：taiga taiga savanna savanna
      4, 4, 5, 5, // y3：boreal boreal jungle jungle
    ]);
    expect([...draft.regions.keys()]).toEqual([
      "tundra",
      "desert",
      "taiga",
      "savanna",
      "boreal",
      "jungle",
    ]);
    // 每格索引可解析且 tiles/walkable 未被触碰
    for (const regionIndex of draft.regionOfTile) {
      expect(regionIndex).toBeLessThan(draft.regions.size);
    }
    expect(draft.tiles).toEqual(new Uint8Array(16).fill(1));
    expect(draft.walkable).toEqual(new Uint8Array(16).fill(1));
  });

  it("POSITIVE：零覆盖表项不进 regions（无零覆盖区域）", () => {
    const draft = makeSizedDraft();
    writeKnownFields(draft);

    // rowThresholds [0.9]：全图温度 < 0.9 → 热行两表项零覆盖
    runBlock(draft, {
      temperatureSlot: TEMP_SLOT,
      moistureSlot: MOIST_SLOT,
      rowThresholds: [0.9],
      colThresholds: [0.4, 0.8],
      table: [
        ["tundra", "taiga", "boreal"],
        ["ghost-dry", "ghost-mid", "ghost-wet"],
      ],
    });

    expect([...draft.regions.keys()]).toEqual(["tundra", "taiga", "boreal"]);
    for (const regionIndex of draft.regionOfTile) {
      expect(regionIndex).toBeLessThan(draft.regions.size);
    }
  });

  it("POSITIVE：minArea 重平衡——不足区域并入相邻区域（接触最多者，平局取插入序在前）", () => {
    const draft = makeSizedDraft();
    writeKnownFields(draft);

    // 各区域面积：tundra/desert 4，其余 2；minArea 3 → 四个 2 格区域被并入
    runBlock(draft, {
      temperatureSlot: TEMP_SLOT,
      moistureSlot: MOIST_SLOT,
      rowThresholds: [0.5],
      colThresholds: [0.4, 0.8],
      table: TABLE_2X3,
      minArea: 3,
    });

    // taiga/boreal（冷行）并入 tundra，savanna/jungle（热行）并入 desert
    expect([...draft.regions.keys()]).toEqual(["tundra", "desert"]);
    expect(Array.from(draft.regionOfTile)).toEqual([
      0, 0, 1, 1,
      0, 0, 1, 1,
      0, 0, 1, 1,
      0, 0, 1, 1,
    ]);
  });
});

describe("whittaker-regions：上游衔接", () => {
  it("NEGATIVE：温度场缺失 → 抛错点名槽位与上游积木", () => {
    const draft = makeSizedDraft();
    setAux(draft, defineAuxSlot<Float64Array>(MOIST_SLOT), new Float64Array(16));
    expect(() =>
      runBlock(draft, {
        temperatureSlot: TEMP_SLOT,
        moistureSlot: MOIST_SLOT,
        rowThresholds: [0.5],
        colThresholds: [0.5],
        table: [
          ["a", "b"],
          ["c", "d"],
        ],
      }),
    ).toThrowError(/map "whittaker-test": whittaker-regions requires an upstream noise-channel step filling aux slot "test\.temperature"/);
  });

  it("NEGATIVE：湿度场长度不符 → 抛错点名槽位与期望长度", () => {
    const draft = makeSizedDraft();
    setAux(draft, defineAuxSlot<Float64Array>(TEMP_SLOT), new Float64Array(16));
    setAux(draft, defineAuxSlot<Float64Array>(MOIST_SLOT), new Float64Array(8));
    expect(() =>
      runBlock(draft, {
        temperatureSlot: TEMP_SLOT,
        moistureSlot: MOIST_SLOT,
        rowThresholds: [0.5],
        colThresholds: [0.5],
        table: [
          ["a", "b"],
          ["c", "d"],
        ],
      }),
    ).toThrowError(/aux slot "test\.moisture" \(field\.length=8, expected 16\)/);
  });

  it("NEGATIVE：两槽位同名 → 抛错点名两个参数", () => {
    const draft = makeSizedDraft();
    expect(() =>
      runBlock(draft, {
        temperatureSlot: TEMP_SLOT,
        moistureSlot: TEMP_SLOT,
        rowThresholds: [0.5],
        colThresholds: [0.5],
        table: [
          ["a", "b"],
          ["c", "d"],
        ],
      }),
    ).toThrowError(/params\.temperatureSlot and params\.moistureSlot must be distinct/);
  });
});

describe("whittaker-regions：参数 fail-fast", () => {
  it("NEGATIVE：未定尺寸草稿 → 抛错点名地图 key", () => {
    const draft = createGeometryDraft(KEY);
    expect(() =>
      runBlock(draft, {
        temperatureSlot: TEMP_SLOT,
        moistureSlot: MOIST_SLOT,
        rowThresholds: [],
        colThresholds: [],
        table: [["solo"]],
      }),
    ).toThrowError(/map "whittaker-test": whittaker-regions draft is not sized/);
  });

  it("NEGATIVE：table 行列维数不符 / 行不等长 → 抛错点名具体行", () => {
    const draft = makeSizedDraft();
    expect(() =>
      runBlock(draft, {
        temperatureSlot: TEMP_SLOT,
        moistureSlot: MOIST_SLOT,
        rowThresholds: [0.5],
        colThresholds: [0.5],
        table: [["a", "b"]], // 缺一行
      }),
    ).toThrowError(/params\.table must have 2 rows/);
    expect(() =>
      runBlock(draft, {
        temperatureSlot: TEMP_SLOT,
        moistureSlot: MOIST_SLOT,
        rowThresholds: [0.5],
        colThresholds: [0.5],
        table: [["a", "b"], ["c"]],
      }),
    ).toThrowError(/params\.table\[1\] must have 2 columns/);
  });

  it("NEGATIVE：区域名重复 / 保留名 wilderness → 抛错点名名字", () => {
    const draft = makeSizedDraft();
    expect(() =>
      runBlock(draft, {
        temperatureSlot: TEMP_SLOT,
        moistureSlot: MOIST_SLOT,
        rowThresholds: [],
        colThresholds: [0.5],
        table: [["same", "same"]],
      }),
    ).toThrowError(/params\.table contains duplicate region name "same"/);
    expect(() =>
      runBlock(draft, {
        temperatureSlot: TEMP_SLOT,
        moistureSlot: MOIST_SLOT,
        rowThresholds: [],
        colThresholds: [],
        table: [["wilderness"]],
      }),
    ).toThrowError(/must not use reserved region name "wilderness"/);
  });

  it("NEGATIVE：阈值非升序 / 越值域 → 抛错点名阈值数组", () => {
    const draft = makeSizedDraft();
    const base = {
      temperatureSlot: TEMP_SLOT,
      moistureSlot: MOIST_SLOT,
      rowThresholds: [] as number[],
      colThresholds: [] as number[],
      table: [["a"]],
    };
    expect(() => runBlock(draft, { ...base, rowThresholds: [0.6, 0.5] })).toThrowError(
      /params\.rowThresholds must be strictly ascending/,
    );
    expect(() => runBlock(draft, { ...base, rowThresholds: [0] })).toThrowError(
      /params\.rowThresholds entries must be numbers in \(0, 1\), got 0/,
    );
    expect(() => runBlock(draft, { ...base, colThresholds: [1.5] })).toThrowError(
      /params\.colThresholds entries must be numbers in \(0, 1\), got 1\.5/,
    );
  });

  it("NEGATIVE：minArea 非法 / 槽位名非法 → 抛错点名参数", () => {
    const draft = makeSizedDraft();
    const base = {
      temperatureSlot: TEMP_SLOT,
      moistureSlot: MOIST_SLOT,
      rowThresholds: [],
      colThresholds: [],
      table: [["a"]],
    };
    expect(() => runBlock(draft, { ...base, minArea: 0 })).toThrowError(
      /params\.minArea must be a finite number >= 1/,
    );
    expect(() => runBlock(draft, { ...base, temperatureSlot: "" })).toThrowError(
      /params\.temperatureSlot must be a non-empty string/,
    );
  });
});

describe("whittaker-regions：管道串接", () => {
  it("POSITIVE：buildMapGeometry [sizing → noise-channel ×2 → whittaker] 产出合法区域划分", () => {
    const sizing = (ctx: GenerationContext): void => {
      const draft = ctx.geometry;
      draft.width = 16;
      draft.height = 16;
      draft.tileWidth = 16;
      draft.tileHeight = 16;
      draft.tiles = new Uint8Array(256).fill(1);
      draft.walkable = new Uint8Array(256).fill(1);
      draft.regions.set("region-a", { name: "region-a", meta: {} });
      draft.regionOfTile = new Uint16Array(256);
    };
    const registry = createGeneratorRegistry();
    registry.register("sizing", sizing);
    registry.register("noise-channel", noiseChannel);
    registry.register("whittaker-regions", whittakerRegions);

    const geometry = buildMapGeometry(
      {
        key: KEY,
        seed: 11,
        pipeline: [
          { generator: "sizing" },
          { generator: "noise-channel", params: { slot: TEMP_SLOT, cell: 6 } },
          { generator: "noise-channel", params: { slot: MOIST_SLOT, cell: 6, seedOffset: 32 } },
          {
            generator: "whittaker-regions",
            params: {
              temperatureSlot: TEMP_SLOT,
              moistureSlot: MOIST_SLOT,
              rowThresholds: [0.4, 0.7],
              colThresholds: [0.4, 0.7],
              table: [
                ["cold-dry", "cold-mid", "cold-wet"],
                ["mid-dry", "mid-mid", "mid-wet"],
                ["hot-dry", "hot-mid", "hot-wet"],
              ],
            },
          },
        ],
      },
      registry,
    );

    // 区域来自真实噪声场的查表结果：有覆盖、全覆盖、索引可解析
    expect(geometry.regions.size).toBeGreaterThanOrEqual(2);
    const covered = new Uint8Array(geometry.regions.size);
    for (const regionIndex of geometry.regionOfTile) {
      expect(regionIndex).toBeLessThan(geometry.regions.size);
      covered[regionIndex] = 1;
    }
    expect([...covered].every((flag) => flag === 1)).toBe(true);
  });
});
