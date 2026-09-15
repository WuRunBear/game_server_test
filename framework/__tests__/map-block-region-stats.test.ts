/**
 * region-stats 生成积木测试（framework/__tests__/map-block-region-stats.test.ts）。
 *
 * 覆盖地图系统设计文档提案 3 验收：
 * - 缺省参数：为每个有覆盖区域写入 area/centroid/bounds 三项统计；
 * - 统计值正确：手算 4×4 双区域草稿的面积/质心/包围盒精确断言；
 * - metrics 过滤：只声明 "area" 时仅写 area，其余项不出现；
 * - 零覆盖区域：跳过（不写任何统计键）；
 * - 确定性：同草稿两次运行输出一致；重复运行覆盖旧值为同值；
 * - 参数校验：metrics 非数组/空数组/未知项名抛错点名配置项；
 * - 前置约束：未定尺寸草稿抛错点名地图 key。
 */
import { describe, expect, it } from "vitest";

import { regionStats } from "map/generate/blocks/regionStats";
import { createRng } from "map/generate/rng";
import { createGeometryDraft, type GenerationContext, type GeometryDraft } from "map/generate/types";

/** 测试地图 key。 */
const KEY = "stats-map";

/** 构造 4×4 双区域草稿：region-a 占左 3 列（索引 0），region-b 占第 4 列（索引 1）。 */
function makeTwoRegionDraft(): GeometryDraft {
  const draft = createGeometryDraft(KEY);
  draft.width = 4;
  draft.height = 4;
  draft.tileWidth = 16;
  draft.tileHeight = 16;
  draft.tiles = new Uint8Array(16);
  draft.walkable = new Uint8Array(16).fill(1);
  draft.regions.set("region-a", { name: "region-a", meta: {} });
  draft.regions.set("region-b", { name: "region-b", meta: {} });
  draft.regionOfTile = new Uint16Array(16);
  for (let i = 0; i < 16; i++) {
    draft.regionOfTile[i] = i % 4 === 3 ? 1 : 0;
  }
  return draft;
}

/** 以给定参数与随机流对草稿跑一次积木。 */
function runBlock(draft: GeometryDraft, params?: unknown): void {
  const ctx: GenerationContext = { key: KEY, rng: createRng(1), geometry: draft, params };
  regionStats(ctx);
}

describe("regionStats 缺省统计（area / centroid / bounds）", () => {
  it("POSITIVE：缺省参数为每个有覆盖区域写入三项统计且数值正确", () => {
    const draft = makeTwoRegionDraft();
    runBlock(draft);

    // region-a：12 格，x ∈ {0,1,2} 全行 → 质心 (1, 1.5)，包围盒 (0,0)-(2,3)
    const a = draft.regions.get("region-a")?.meta;
    expect(a?.area).toBe(12);
    expect(a?.centroid).toEqual([1, 1.5]);
    expect(a?.bounds).toEqual({ minX: 0, minY: 0, maxX: 2, maxY: 3 });
    // region-b：4 格（x=3 全行）→ 质心 (3, 1.5)，包围盒 (3,0)-(3,3)
    const b = draft.regions.get("region-b")?.meta;
    expect(b?.area).toBe(4);
    expect(b?.centroid).toEqual([3, 1.5]);
    expect(b?.bounds).toEqual({ minX: 3, minY: 0, maxX: 3, maxY: 3 });
  });

  it("POSITIVE：metrics 仅声明 area → 只写 area（centroid/bounds 不出现）", () => {
    const draft = makeTwoRegionDraft();
    runBlock(draft, { metrics: ["area"] });
    const a = draft.regions.get("region-a")?.meta;
    expect(a?.area).toBe(12);
    expect(a).not.toHaveProperty("centroid");
    expect(a).not.toHaveProperty("bounds");
  });

  it("POSITIVE：metrics 声明多项 → 恰好写入声明的统计项", () => {
    const draft = makeTwoRegionDraft();
    runBlock(draft, { metrics: ["bounds", "centroid"] });
    const a = draft.regions.get("region-a")?.meta;
    expect(a).not.toHaveProperty("area");
    expect(a?.centroid).toEqual([1, 1.5]);
    expect(a?.bounds).toEqual({ minX: 0, minY: 0, maxX: 2, maxY: 3 });
  });

  it("POSITIVE：零覆盖区域跳过（meta 不写任何统计键）", () => {
    const draft = makeTwoRegionDraft();
    draft.regions.set("region-c", { name: "region-c", meta: {} });
    runBlock(draft);
    expect(draft.regions.get("region-c")?.meta).toEqual({});
  });

  it("POSITIVE：已有 meta 内容保留，同名统计键被覆盖为最新值", () => {
    const draft = makeTwoRegionDraft();
    draft.regions.get("region-a")!.meta.tag = "kept";
    draft.regions.get("region-a")!.meta.area = 999;
    runBlock(draft);
    const a = draft.regions.get("region-a")?.meta;
    expect(a?.tag).toBe("kept");
    expect(a?.area).toBe(12);
  });

  it("POSITIVE：同草稿两次运行输出一致（确定性）", () => {
    const first = makeTwoRegionDraft();
    const second = makeTwoRegionDraft();
    runBlock(first);
    runBlock(second);
    expect(second.regions.get("region-a")?.meta).toEqual(first.regions.get("region-a")?.meta);
    expect(second.regions.get("region-b")?.meta).toEqual(first.regions.get("region-b")?.meta);
  });
});

describe("regionStats 参数校验与前置约束", () => {
  it("NEGATIVE：metrics 非数组 → 抛错点名 params.metrics", () => {
    const draft = makeTwoRegionDraft();
    expect(() => runBlock(draft, { metrics: "area" })).toThrowError(
      /map "stats-map": region-stats params\.metrics must be a non-empty array/,
    );
  });

  it("NEGATIVE：metrics 空数组 → 抛错点名 params.metrics", () => {
    const draft = makeTwoRegionDraft();
    expect(() => runBlock(draft, { metrics: [] })).toThrowError(
      /map "stats-map": region-stats params\.metrics must be a non-empty array/,
    );
  });

  it("NEGATIVE：metrics 含未知项名 → 抛错点名非法条目", () => {
    const draft = makeTwoRegionDraft();
    expect(() => runBlock(draft, { metrics: ["area", "perimeter"] })).toThrowError(
      /params\.metrics entries must be one of \["area","centroid","bounds"\], got "perimeter"/,
    );
  });

  it("NEGATIVE：params 非对象（数组）→ 抛错", () => {
    const draft = makeTwoRegionDraft();
    expect(() => runBlock(draft, ["area"])).toThrowError(
      /map "stats-map": region-stats params must be an object/,
    );
  });

  it("NEGATIVE：未定尺寸草稿 → 抛错点名地图 key 与前置积木要求", () => {
    const draft = createGeometryDraft(KEY);
    expect(() => runBlock(draft)).toThrowError(
      /map "stats-map": region-stats requires a sized draft/,
    );
  });

  it("NEGATIVE：regionOfTile 索引越界 → 抛错点名索引与区域数", () => {
    const draft = makeTwoRegionDraft();
    draft.regionOfTile[0] = 5;
    expect(() => runBlock(draft)).toThrowError(
      /map "stats-map": region-stats regionOfTile\[0\]=5 out of range \(regions count 2\)/,
    );
  });
});
