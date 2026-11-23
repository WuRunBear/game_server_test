import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MapConfig } from "framework/config/schema/MapRegistrySchema";
import { loadGameDefinition } from "framework/bootstrap/loadGameDefinition";
import {
  clearPresentation,
  getLevelSemantics,
  getMapPresentation,
  getTileSemantic,
  listTileSemantics,
  loadPresentation,
  validatePresentation,
} from "framework/content/presentation";

/** 通用语义条目 fixture（框架测试不依赖具体游戏名词）。 */
const WATER = { name: "water", category: "water", walkable: false };
const SAND = { name: "sand", category: "terrain", walkable: true };
const WALL = { name: "wall", category: "wall", walkable: false };

/** 构造一个最小 MapConfig（只填表现校验关心的字段）。 */
function mapConfig(key: string, pipeline: MapConfig["pipeline"] = []): MapConfig {
  return { key, initialAgeTicks: 0, pipeline };
}

/** 最小 noise-terrain 管道步骤（palette 可直接给语义 id/阈值）。 */
function noiseStep(groundPalette: Record<string, number>): MapConfig["pipeline"][number] {
  return {
    generator: "noise-terrain",
    params: {
      width: 4,
      height: 4,
      tileWidth: 16,
      tileHeight: 16,
      bandLevel: Math.min(...Object.values(groundPalette)),
      groundPalette,
      nonWalkableSemantics: [],
    },
  };
}

afterEach(() => {
  clearPresentation();
});

describe("presentation: loadPresentation / 查询层", () => {
  it("解析合法配置并深度冻结；查询按每图覆盖 → 全局默认", () => {
    const config = loadPresentation({
      tileSemantics: { "1": WATER },
      maps: {
        "map-a": {
          displayName: "Map A",
          tileSemantics: { "1": WALL },
        },
      },
    });

    expect(Object.isFrozen(config)).toBe(true);
    expect(Object.isFrozen(config.maps["map-a"])).toBe(true);
    expect(Object.isFrozen(config.maps["map-a"].tileSemantics)).toBe(true);

    expect(getMapPresentation("map-a")?.displayName).toBe("Map A");
    expect(getMapPresentation("map-b")).toBeUndefined();
    expect(getTileSemantic("map-a", 1)?.name).toBe("wall");
    expect(getTileSemantic("map-b", 1)?.name).toBe("water");
    expect(getTileSemantic("map-a", 99)).toBeUndefined();
  });

  it("listTileSemantics 返回合并后的完整表；getLevelSemantics 返回该图声明", () => {
    loadPresentation({
      tileSemantics: { "1": WATER, "2": SAND },
      maps: {
        "map-a": {
          displayName: "Map A",
          levelSemantics: { slope: 7, cliff: 8 },
          tileSemantics: { "2": { name: "gravel", walkable: true } },
        },
      },
    });

    const merged = listTileSemantics("map-a");
    expect(merged["1"].name).toBe("water");
    expect(merged["2"].name).toBe("gravel");
    expect(Object.isFrozen(merged)).toBe(true);
    expect(listTileSemantics("map-b")["2"].name).toBe("sand");
    expect(getLevelSemantics("map-a")).toEqual({ slope: 7, cliff: 8 });
    expect(getLevelSemantics("map-b")).toBeUndefined();
  });

  it("非法 tile id 键（非规范整数 / 越界）即解析报错", () => {
    for (const key of ["1.5", "01", "-1", "256", "x"]) {
      expect(() =>
        loadPresentation({
          tileSemantics: { [key]: WATER },
          maps: {},
        }),
      ).toThrow(/canonical integer id in \[0, 255\]/);
    }
  });

  it("缺 name 等必填字段报错", () => {
    expect(() =>
      loadPresentation({
        tileSemantics: { "1": { category: "water" } },
        maps: {},
      }),
    ).toThrow();
  });
});

describe("presentation: validatePresentation", () => {
  it("合法配置通过", () => {
    const presentation = loadPresentation({
      tileSemantics: { "1": WATER },
      maps: { "map-a": { displayName: "Map A" } },
    });
    const report = validatePresentation({
      resolvedPresentation: presentation,
      resolvedMapConfigs: [mapConfig("map-a", [noiseStep({ "1": 1 })])],
      resolvedRules: {},
    });
    expect(report).toEqual({ ok: true, errors: [] });
  });

  it("registry 图缺表现条目 / 表现条目引用未知地图均报错", () => {
    const presentation = loadPresentation({
      tileSemantics: { "1": WATER },
      maps: { "map-a": { displayName: "Map A" }, ghost: { displayName: "Ghost" } },
    });
    const report = validatePresentation({
      resolvedPresentation: presentation,
      resolvedMapConfigs: [mapConfig("map-a"), mapConfig("map-b")],
      resolvedRules: {},
    });
    expect(report.ok).toBe(false);
    expect(report.errors).toContain('presentation: map "map-b" has no presentation entry');
    expect(report.errors).toContain('presentation: map "ghost" is not declared in the map registry');
  });

  it("收集生成管道引用的 tile id：noise-terrain / stamp-template / quantize-terrain 等", () => {
    const presentation = loadPresentation({
      tileSemantics: { "1": WATER },
      maps: {
        "map-a": { displayName: "Map A", levelSemantics: { slope: 7, cliff: 8 } },
      },
    });
    const report = validatePresentation({
      resolvedPresentation: presentation,
      resolvedMapConfigs: [
        mapConfig("map-a", [
          noiseStep({ "1": 1 }),
          {
            generator: "stamp-template",
            params: {
              tiled: {
                layers: [
                  { type: "tilelayer", name: "ground", width: 1, height: 1, data: [1, 2] },
                ],
              },
            },
          },
          { generator: "quantize-terrain", params: { slopeSemantics: 7, cliffSemantics: 8 } },
        ]),
      ],
      resolvedRules: {},
    });
    expect(report.ok).toBe(false);
    expect(
      report.errors.some(
        (error) =>
          error.includes('references undefined tile semantic 2') &&
          error.includes('stamp-template ground layer'),
      ),
    ).toBe(true);
    expect(
      report.errors.some(
        (error) =>
          error.includes('references undefined tile semantic 7') &&
          error.includes('quantize-terrain slopeSemantics'),
      ),
    ).toBe(true);
  });

  it("全局规则引用（environment.groundOverrides / disasters.wildfire）缺定义报错", () => {
    const presentation = loadPresentation({
      tileSemantics: { "1": WATER },
      maps: { "map-a": { displayName: "Map A" } },
    });
    const report = validatePresentation({
      resolvedPresentation: presentation,
      resolvedMapConfigs: [mapConfig("map-a")],
      resolvedRules: {
        environment: {
          groundOverrides: [{ phaseId: "cold", fromSemantic: 1, toSemantic: 10 }],
        },
        disasters: {
          wildfire: { scorchGround: 9, flammableGrounds: [1] },
        },
      },
    });
    expect(report.ok).toBe(false);
    expect(
      report.errors.some(
        (error) => error.includes("global tile semantic 10 referenced by environment.groundOverrides.toSemantic"),
      ),
    ).toBe(true);
    expect(
      report.errors.some(
        (error) => error.includes("global tile semantic 9 referenced by disasters.wildfire.scorchGround"),
      ),
    ).toBe(true);
  });

  it("quantize-terrain 的 slope/cliff 与 levelSemantics 不一致报错", () => {
    const presentation = loadPresentation({
      tileSemantics: { "1": WATER, "7": SAND, "8": WALL },
      maps: { "map-a": { displayName: "Map A", levelSemantics: { slope: 8, cliff: 7 } } },
    });
    const report = validatePresentation({
      resolvedPresentation: presentation,
      resolvedMapConfigs: [
        mapConfig("map-a", [{ generator: "quantize-terrain", params: { slopeSemantics: 7, cliffSemantics: 8 } }]),
      ],
      resolvedRules: {},
    });
    expect(report.ok).toBe(false);
    expect(
      report.errors.some((error) => error.includes('map "map-a" levelSemantics (slope 8, cliff 7) do not match quantize-terrain')),
    ).toBe(true);
  });

  it("connections 指向 registry 之外的地图报错", () => {
    const presentation = loadPresentation({
      tileSemantics: { "1": WATER },
      maps: {
        "map-a": {
          displayName: "Map A",
          connections: [{ to: "missing-map", kind: "portal" }],
        },
      },
    });
    const report = validatePresentation({
      resolvedPresentation: presentation,
      resolvedMapConfigs: [mapConfig("map-a")],
      resolvedRules: {},
    });
    expect(report.ok).toBe(false);
    expect(
      report.errors.some((error) => error.includes('connection target "missing-map" is not declared')),
    ).toBe(true);
  });

  it("无 resolvedPresentation 的旧游戏直接通过（不检查规则引用）", () => {
    const report = validatePresentation({
      resolvedMapConfigs: [mapConfig("map-a", [noiseStep({ "1": 1 })])],
      resolvedRules: {
        environment: { groundOverrides: [{ phaseId: "cold", fromSemantic: 1, toSemantic: 10 }] },
      },
    });
    expect(report).toEqual({ ok: true, errors: [] });
  });
});

describe("presentation: loadGameDefinition 接线", () => {
  const dirs: string[] = [];

  function makeGameDir(options?: {
    presentationPath?: string;
    convention?: boolean;
    presentation?: Record<string, unknown>;
  }): string {
    const dir = mkdtempSync(join(tmpdir(), "presentation-"));
    dirs.push(dir);
    mkdirSync(join(dir, "maps"), { recursive: true });

    const gameJson: Record<string, unknown> = {
      id: "presentation-fixture",
      tickRate: 20,
      map: { registry: "./maps/registry.json" },
    };
    if (options?.presentationPath) {
      gameJson.presentation = options.presentationPath;
    }
    writeFileSync(join(dir, "game.json"), JSON.stringify(gameJson));

    writeFileSync(
      join(dir, "maps", "registry.json"),
      JSON.stringify({
        maps: {
          "map-a": {
            kind: "pipeline",
            seed: 1,
            initialAgeTicks: 0,
            pipeline: [noiseStep({ "1": 1 })],
          },
        },
      }),
    );

    const presentation = options?.presentation ?? {
      tileSemantics: { "1": WATER },
      maps: { "map-a": { displayName: "Fixture Map" } },
    };
    if (options?.convention) {
      mkdirSync(join(dir, "presentation"), { recursive: true });
      writeFileSync(join(dir, "presentation", "maps.json"), JSON.stringify(presentation));
    }
    return dir;
  }

  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it("无 presentation 字段且无约定文件 → 正常加载，resolvedPresentation 为空（回归）", () => {
    const dir = makeGameDir();
    const loaded = loadGameDefinition({ gameJsonPath: join(dir, "game.json") });
    expect(loaded.resolvedPresentation).toBeUndefined();
    expect(getMapPresentation("map-a")).toBeUndefined();
  });

  it("无 presentation 字段但 <gameDir>/presentation/maps.json 存在 → 按约定加载", () => {
    const dir = makeGameDir({ convention: true });
    const loaded = loadGameDefinition({ gameJsonPath: join(dir, "game.json") });
    expect(loaded.resolvedPresentation).toBeDefined();
    expect(loaded.resolvedPresentation!.maps["map-a"].displayName).toBe("Fixture Map");
    expect(getTileSemantic("map-a", 1)?.name).toBe("water");
  });

  it("显式 presentation glob 支持多文件确定性合并", () => {
    const dir = makeGameDir({ presentationPath: "./pres/*.json" });
    mkdirSync(join(dir, "pres"), { recursive: true });
    // 文件名排序 globals.json < maps.json；两份文档各承担全局语义与地图条目
    writeFileSync(
      join(dir, "pres", "globals.json"),
      JSON.stringify({ tileSemantics: { "1": WATER }, maps: {} }),
    );
    writeFileSync(
      join(dir, "pres", "maps.json"),
      JSON.stringify({ maps: { "map-a": { displayName: "Glob Map" } } }),
    );

    const loaded = loadGameDefinition({ gameJsonPath: join(dir, "game.json") });
    expect(loaded.resolvedPresentation!.maps["map-a"].displayName).toBe("Glob Map");
    expect(loaded.resolvedPresentation!.tileSemantics["1"].name).toBe("water");
  });

  it("显式 presentation 路径无匹配文件 → 加载报错", () => {
    const dir = makeGameDir({ presentationPath: "./missing/*.json" });
    expect(() => loadGameDefinition({ gameJsonPath: join(dir, "game.json") })).toThrow(
      /presentation path "\.\/missing\/\*\.json" matched no JSON files/,
    );
  });

  it("表现条目缺 registry 地图 / 缺语义 id → 加载报错（工具链同源校验）", () => {
    const missingMapDir = makeGameDir({
      convention: true,
      presentation: { tileSemantics: { "1": WATER }, maps: {} },
    });
    expect(() => loadGameDefinition({ gameJsonPath: join(missingMapDir, "game.json") })).toThrow(
      /map "map-a" has no presentation entry/,
    );

    const missingTileDir = makeGameDir({
      convention: true,
      presentation: { tileSemantics: {}, maps: { "map-a": { displayName: "Fixture Map" } } },
    });
    expect(() => loadGameDefinition({ gameJsonPath: join(missingTileDir, "game.json") })).toThrow(
      /map "map-a" references undefined tile semantic 1/,
    );
  });
});

describe("presentation: 当前游戏内容", () => {
  it("全部 registry 地图都有表现条目，且语义完整性校验通过", () => {
    const loaded = loadGameDefinition({ gameJsonPath: "game/game.json" });
    const presentation = loaded.resolvedPresentation;
    expect(presentation).toBeDefined();

    const mapKeys = loaded.resolvedMapConfigs.map((config) => config.key).sort();
    expect(Object.keys(presentation!.maps).sort()).toEqual(mapKeys);
    expect(validatePresentation(loaded)).toEqual({ ok: true, errors: [] });

    for (const key of mapKeys) {
      expect(getMapPresentation(key)?.displayName.length).toBeGreaterThan(0);
    }
  });

  it("跨图冲突的 tile id 由每图覆盖生效，且合并表含焦土/季节语义 9..12", () => {
    const loaded = loadGameDefinition({ gameJsonPath: "game/game.json" });
    // 找一张用 room-corridor 的图（其 1 号是墙而非全局深水）验证覆盖优先
    const corridorMap = loaded.resolvedMapConfigs.find((config) =>
      config.pipeline.some((step) => step.generator === "room-corridor"),
    );
    expect(corridorMap).toBeDefined();
    const override = getTileSemantic(corridorMap!.key, 1);
    const globalOnly = getTileSemantic("__no_such_map__", 1);
    expect(override).toBeDefined();
    expect(globalOnly).toBeDefined();
    expect(override!.name).not.toBe(globalOnly!.name);

    const firstMap = loaded.resolvedMapConfigs[0].key;
    const merged = listTileSemantics(firstMap);
    // tiled-source 默认 0 + 基础地面 1..6 + slope/cliff 7/8 + 焦土 9 + 季节 10..12
    for (let id = 0; id <= 12; id++) {
      expect(merged[String(id)]).toBeDefined();
    }
    const quantizedMap = loaded.resolvedMapConfigs.find((config) =>
      config.pipeline.some((step) => step.generator === "quantize-terrain"),
    );
    expect(quantizedMap).toBeDefined();
    const step = quantizedMap!.pipeline.find((entry) => entry.generator === "quantize-terrain")!;
    expect(getLevelSemantics(quantizedMap!.key)).toEqual({
      slope: step.params!.slopeSemantics,
      cliff: step.params!.cliffSemantics,
    });
  });
});
