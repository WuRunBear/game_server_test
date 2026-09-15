/**
 * 连通性软告警测试（framework/__tests__/map-validate-connectivity.test.ts）。
 *
 * 覆盖地图系统设计文档提案 5 验收：
 * - 多连通域 + 最大域占比低于阈值 → 告警出现（不抛错、不阻断）；
 * - 单一连通域 → 无连通性告警；
 * - 多域但最大域占比 ≥ 阈值（大陆 + 小岛形态）→ 不告警；
 * - 阈值可配置：调低阈值后同样多域图不再告警；
 * - 全图不可通行（walkable 全 0）→ 告警；
 * - 软告警不影响硬错误路径：结构硬错误仍抛错；
 * - buildMapGeometry 出口校验接线：构造保证连通的管道无告警，
 *   多域管道软告警后照常产出合法 MapGeometry。
 */
import { describe, expect, it } from "vitest";

import { createGeneratorRegistry, type GeneratorRegistry } from "map/generate/generatorRegistry";
import { buildMapGeometry } from "map/generate/pipeline";
import { createGeometryDraft, type GeometryDraft, type MapGenerationConfig } from "map/generate/types";
import { validateMapGeometry } from "map/generate/validate";

/** 构造 4×4 合法草稿骨架（区域单声明、regionOfTile 全 0）。 */
function makeDraft(key = "conn-map"): GeometryDraft {
  const draft = createGeometryDraft(key);
  draft.width = 4;
  draft.height = 4;
  draft.tileWidth = 16;
  draft.tileHeight = 16;
  draft.tiles = new Uint8Array(16);
  draft.walkable = new Uint8Array(16);
  draft.regions.set("region-a", { name: "region-a", meta: {} });
  draft.regionOfTile = new Uint16Array(16);
  return draft;
}

/** walkable=1 格子的 4-连通域数量（测试侧独立 BFS，校验实现自证）。 */
function countDomains(walkable: Uint8Array, width: number, height: number): number {
  const seen = new Uint8Array(walkable.length);
  const stack: number[] = [];
  let domains = 0;
  for (let start = 0; start < walkable.length; start++) {
    if (walkable[start] !== 1 || seen[start] === 1) continue;
    domains++;
    seen[start] = 1;
    stack.push(start);
    while (stack.length > 0) {
      const index = stack.pop() as number;
      const x = index % width;
      const y = (index - x) / width;
      if (x > 0 && walkable[index - 1] === 1 && seen[index - 1] === 0) {
        seen[index - 1] = 1;
        stack.push(index - 1);
      }
      if (x < width - 1 && walkable[index + 1] === 1 && seen[index + 1] === 0) {
        seen[index + 1] = 1;
        stack.push(index + 1);
      }
      if (y > 0 && walkable[index - width] === 1 && seen[index - width] === 0) {
        seen[index - width] = 1;
        stack.push(index - width);
      }
      if (y < height - 1 && walkable[index + width] === 1 && seen[index + width] === 0) {
        seen[index + width] = 1;
        stack.push(index + width);
      }
    }
  }
  return domains;
}

describe("validateMapGeometry 连通性软告警", () => {
  it("POSITIVE：单一连通域 → 无连通性告警", () => {
    const draft = makeDraft();
    draft.walkable.fill(1);
    const warnings = validateMapGeometry(draft);
    expect(warnings.filter((w) => w.includes("walkable"))).toEqual([]);
  });

  it("POSITIVE：两个分离连通域 → 告警出现且不抛错", () => {
    const draft = makeDraft();
    // 左侧 2 列与右侧 1 列各自连通、中间列全 0 隔断（8 格 + 4 格）
    for (let y = 0; y < 4; y++) {
      draft.walkable[y * 4] = 1;
      draft.walkable[y * 4 + 1] = 1;
      draft.walkable[y * 4 + 3] = 1;
    }
    expect(countDomains(draft.walkable, 4, 4)).toBe(2);
    const warnings = validateMapGeometry(draft);
    expect(warnings.some((w) => w.includes("splits into 2 domains"))).toBe(true);
  });

  it("POSITIVE：多域但最大域占比 ≥ 缺省阈值（大陆 + 小岛）→ 不告警", () => {
    const draft = makeDraft();
    draft.walkable.fill(1);
    // 挖断右下角孤岛的四邻：孤岛 1 格 + 主体 14 格，14/15 ≈ 93.3% ≥ 0.9
    draft.walkable[11] = 0;
    draft.walkable[14] = 0;
    expect(countDomains(draft.walkable, 4, 4)).toBe(2);
    const warnings = validateMapGeometry(draft);
    expect(warnings.filter((w) => w.includes("splits into"))).toEqual([]);
  });

  it("POSITIVE：阈值可配置——调低阈值后同样的多域图不再告警", () => {
    const draft = makeDraft();
    for (let y = 0; y < 4; y++) {
      draft.walkable[y * 4] = 1;
      draft.walkable[y * 4 + 1] = 1;
      draft.walkable[y * 4 + 2] = 1;
      draft.walkable[y * 4 + 3] = 1;
    }
    const warnings = validateMapGeometry(draft, { minMainDomainShare: 0.5 });
    expect(warnings.filter((w) => w.includes("splits into"))).toEqual([]);
  });

  it("POSITIVE：调高阈值后大陆 + 小岛形态也告警", () => {
    const draft = makeDraft();
    draft.walkable.fill(1);
    draft.walkable[11] = 0;
    draft.walkable[14] = 0;
    const warnings = validateMapGeometry(draft, { minMainDomainShare: 1 });
    expect(warnings.some((w) => w.includes("splits into 2 domains"))).toBe(true);
  });

  it("POSITIVE：全图不可通行（walkable 全 0）→ 告警且不抛错", () => {
    const draft = makeDraft();
    const warnings = validateMapGeometry(draft);
    expect(warnings.some((w) => w.includes("no walkable tiles"))).toBe(true);
  });

  it("NEGATIVE：连通性软告警不改变硬错误路径——结构错误仍抛错", () => {
    const draft = makeDraft();
    draft.tiles = new Uint8Array(3);
    expect(() => validateMapGeometry(draft)).toThrowError(/tiles length 3 != width\*height 16/);
  });

  it("POSITIVE：冻结后的 MapGeometry 同样获得连通性告警返回值", () => {
    const registry: GeneratorRegistry = createGeneratorRegistry();
    registry.register("split", (ctx) => {
      const draft = ctx.geometry;
      draft.width = 4;
      draft.height = 4;
      draft.tileWidth = 16;
      draft.tileHeight = 16;
      draft.tiles = new Uint8Array(16);
      draft.walkable = new Uint8Array(16);
      draft.regions.set("region-a", { name: "region-a", meta: {} });
      draft.regionOfTile = new Uint16Array(16);
      for (let y = 0; y < 4; y++) {
        draft.walkable[y * 4] = 1;
        draft.walkable[y * 4 + 1] = 1;
        draft.walkable[y * 4 + 3] = 1;
      }
    });
    const config: MapGenerationConfig = {
      key: "frozen-conn",
      seed: 1,
      pipeline: [{ generator: "split" }],
    };
    // 管道出口校验软告警不阻断：冻结照常成功
    const geometry = buildMapGeometry(config, registry);
    expect(geometry.version).not.toBe("");
    expect(validateMapGeometry(geometry).some((w) => w.includes("splits into 2 domains"))).toBe(true);
  });
});
