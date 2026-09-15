/**
 * 内置生成积木注册测试（framework/__tests__/map-block-register.test.ts）。
 *
 * 覆盖计划 todo 3 注册接线验收：
 * - registerBuiltinMapGenerators 注册九个内置积木 id（has 全真）；
 * - 注册表恰好含这九条（all 长度 = 9 且 id 集合一致）；
 * - 端到端：注册表 + buildMapGeometry 跑 noise-terrain → climate-regions
 *   管道产出合法 MapGeometry（证明注册的是真实积木而非占位）；
 * - 新积木端到端：slot-rooms 首积木 + region-stats 精修 + smooth-terrain
 *   精修的组合管道同样产出合法 MapGeometry（注册接线可达新能力）。
 */
import { describe, expect, it } from "vitest";

import { registerBuiltinMapGenerators } from "map/generate/registerBuiltin";
import { createGeneratorRegistry } from "map/generate/generatorRegistry";
import { buildMapGeometry } from "map/generate/pipeline";
import type { MapGenerationConfig } from "map/generate/types";

/** 九个内置积木的注册名（与 registerBuiltin.ts 一一对应）。 */
const BLOCK_IDS = [
  "noise-terrain",
  "climate-regions",
  "room-corridor",
  "tiled-source",
  "region-stats",
  "smooth-terrain",
  "height-channel",
  "height-mask",
  "slot-rooms",
] as const;

describe("registerBuiltinMapGenerators", () => {
  it("注册九个内置积木 id（has 全真）", () => {
    const registry = createGeneratorRegistry();
    registerBuiltinMapGenerators(registry);
    for (const id of BLOCK_IDS) {
      expect(registry.has(id)).toBe(true);
    }
  });

  it("注册表恰好含这九条（all 长度 = 9 且 id 集合一致）", () => {
    const registry = createGeneratorRegistry();
    registerBuiltinMapGenerators(registry);
    const entries = registry.all();
    expect(entries).toHaveLength(9);
    expect(entries.map((entry) => entry.id).sort()).toEqual([...BLOCK_IDS].sort());
  });

  it("端到端：noise-terrain → climate-regions 管道经 buildMapGeometry 产出合法 MapGeometry", () => {
    const registry = createGeneratorRegistry();
    registerBuiltinMapGenerators(registry);
    const config: MapGenerationConfig = {
      key: "register-e2e",
      seed: 42,
      pipeline: [
        {
          generator: "noise-terrain",
          params: {
            width: 16,
            height: 16,
            tileWidth: 16,
            tileHeight: 16,
            bandLevel: 0.25,
            groundPalette: { "7": 0.25, "3": 0.5, "5": 1 },
            nonWalkableSemantics: [7],
          },
        },
        { generator: "climate-regions", params: { names: ["alpha", "beta"], style: "noise" } },
      ],
    };

    const geometry = buildMapGeometry(config, registry);

    // 尺寸与缓冲由 noise-terrain（管道首积木）写入
    expect(geometry.key).toBe("register-e2e");
    expect(geometry.grid).toEqual({ width: 16, height: 16, tileWidth: 16, tileHeight: 16 });
    expect(geometry.tiles.length).toBe(256);
    expect(geometry.walkable.length).toBe(256);
    expect(geometry.regionOfTile.length).toBe(256);
    // climate-regions 写入命名区域（alpha/beta 至少各占其种子格）
    expect(geometry.regions.size).toBeGreaterThanOrEqual(2);
    expect([...geometry.regions.keys()]).toContain("alpha");
    expect([...geometry.regions.keys()]).toContain("beta");
    // 每格区域索引可解析（出口校验已过，此处钉住语义）
    for (const regionIndex of geometry.regionOfTile) {
      expect(regionIndex).toBeLessThan(geometry.regions.size);
    }
    // 冻结时已计算内容指纹
    expect(geometry.version).not.toBe("");
  });

  it("端到端：slot-rooms → smooth-terrain → region-stats 组合管道产出合法 MapGeometry（新积木接线可达）", () => {
    const registry = createGeneratorRegistry();
    registerBuiltinMapGenerators(registry);
    const config: MapGenerationConfig = {
      key: "register-e2e-new",
      seed: 42,
      pipeline: [
        { generator: "slot-rooms", params: { floorTile: 2, solidTile: 1, tileWidth: 16, tileHeight: 16 } },
        { generator: "smooth-terrain", params: { maxRounds: 2 } },
        { generator: "region-stats" },
      ],
    };

    const geometry = buildMapGeometry(config, registry);

    expect(geometry.grid).toEqual({ width: 75, height: 48, tileWidth: 16, tileHeight: 16 });
    // region-stats 为每个有覆盖区域写入 area 统计（walls 区域除外为零覆盖时跳过）
    let statsWritten = 0;
    for (const [, region] of geometry.regions) {
      if (region.meta.area !== undefined) statsWritten++;
    }
    expect(statsWritten).toBeGreaterThanOrEqual(5);
    expect(geometry.version).not.toBe("");
  });
});
