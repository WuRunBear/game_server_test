/**
 * CC-13 装饰点集（Map Decoration）纯函数/配置测试。
 *
 * 覆盖：
 * - 确定性：同配置两次构建逐点相等、独立解析的配置结果一致、固定输入首点锁值；
 * - density 极值：0 → 空，1 + variantCount=1 → 每个可走格一点；
 * - region 过滤（具体区域）、"*" 兜底、onWalkable=false 的不可走格；
 * - jitter 落在 tile 内、variant 范围；
 * - 未知 decorId / region / 未知字段 / 越界数值的加载期报错；
 * - 点集缓存：geometry.version 变化或配置重新加载后重建；
 * - manifest contentVersion 的装饰输入。
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { bootstrapFramework } from "framework/bootstrap";
import { loadGameDefinition } from "framework/bootstrap/loadGameDefinition";
import type { PresentationConfig } from "framework/config/schema/PresentationSchema";
import {
  clearPresentation,
  getDecorMapRules,
  getDecorRulesForRegion,
  getPresentationRevision,
  listDecorIds,
  loadPresentation,
  validatePresentation,
} from "framework/content/presentation";
import { computeContentVersion } from "framework/content/manifest";
import { buildMapDecorView, computeDecorPoints } from "map/clientView";
import { computeGeometryVersion } from "map/geometry/version";
import type { MapGeometry } from "map/geometry/types";
import { makeTestGeometry } from "./helpers/mapGeometry";

const WIDTH = 6;
const HEIGHT = 4;
const TILE = 16;

/** 临时 fixture 目录（afterAll 统一清理）。 */
const dirs: string[] = [];

/** 原始规则输入（loadPresentation 接收 unknown）。 */
interface RawDecorRule {
  decorId: string;
  density: number;
  variantCount?: number;
  onWalkable?: boolean;
  jitter?: number;
}

/** 6×4 测试图：左 3 列 forest、右 3 列 beach；(5,3) 不可走；首行 level=1。 */
function makeDecorGeometry(): MapGeometry {
  return makeTestGeometry({
    key: "decor-map",
    width: WIDTH,
    height: HEIGHT,
    tileWidth: TILE,
    tileHeight: TILE,
    regions: ["forest", "beach"],
    regionOfTile: (tx) => (tx < 3 ? 0 : 1),
    levels: (_tx, ty) => (ty === 0 ? 1 : 0),
    blocked: (tx, ty) => tx === 5 && ty === 3,
  });
}

/** 构造并登记一份装饰配置（decor id 表固定为 bush/pebble/reed）。 */
function presentationWith(regions: Record<string, RawDecorRule[]>): PresentationConfig {
  return loadPresentation({
    decor: { bush: {}, pebble: {}, reed: {} },
    decorMaps: { "decor-map": { regions } },
  });
}

/** 规则命中格的 tile 坐标（jitter=0 时由像素坐标反推）。 */
function tileOf(point: { x: number; y: number }): { tx: number; ty: number } {
  return { tx: Math.round(point.x / TILE - 0.5), ty: Math.round(point.y / TILE - 0.5) };
}

/** 某格上的点（按生成顺序）。 */
function pointsAt<T extends { x: number; y: number }>(
  points: readonly T[],
  tx: number,
  ty: number,
): T[] {
  return points.filter((point) => {
    const tile = tileOf(point);
    return tile.tx === tx && tile.ty === ty;
  });
}

beforeAll(() => {
  bootstrapFramework();
});

afterEach(() => {
  clearPresentation();
});

describe("map-decor: 确定性", () => {
  it("同配置两次构建逐点相等；独立解析的配置也相等", () => {
    const raw = {
      decor: { bush: {}, pebble: {} },
      decorMaps: {
        "decor-map": {
          regions: {
            forest: [{ decorId: "bush", density: 0.5, variantCount: 3 }],
            "*": [{ decorId: "pebble", density: 0.25, variantCount: 2 }],
          },
        },
      },
    };
    const geometry = makeDecorGeometry();
    const first = computeDecorPoints(geometry, loadPresentation(raw));
    const second = computeDecorPoints(geometry, loadPresentation(structuredClone(raw)));

    expect(first.length).toBeGreaterThan(0);
    expect(second).toEqual(first);
    // 固定输入锁首点（跨进程稳定性回归：hash 实现/种子输入变化即失败）
    expect(first[0]).toEqual({
      decorId: "pebble",
      x: 39.764740463439374,
      y: 9.432058411557227,
      level: 1,
      region: "forest",
      variant: 1,
    });
  });

  it("row-major tile 序 + 规则序稳定；同 tile 可命中多条规则", () => {
    const config = presentationWith({
      forest: [
        { decorId: "bush", density: 1, variantCount: 1, jitter: 0 },
        { decorId: "reed", density: 1, variantCount: 1, jitter: 0 },
      ],
      "*": [{ decorId: "pebble", density: 1, variantCount: 1, jitter: 0 }],
    });
    const points = computeDecorPoints(makeDecorGeometry(), config);
    const firstTile = pointsAt(points, 0, 0);
    expect(firstTile.map((point) => point.decorId)).toEqual(["bush", "reed", "pebble"]);

    const keys = points.map((point) => {
      const { tx, ty } = tileOf(point);
      return ty * WIDTH + tx;
    });
    const sorted = [...keys].sort((a, b) => a - b);
    expect(keys).toEqual(sorted);
  });
});

describe("map-decor: density / variant / region / walkable", () => {
  it("density=0 → 空；density=1 + variantCount=1 → 每个可走格一点", () => {
    const geometry = makeDecorGeometry();
    expect(
      computeDecorPoints(
        geometry,
        presentationWith({ "*": [{ decorId: "pebble", density: 0, variantCount: 1 }] }),
      ),
    ).toEqual([]);

    const points = computeDecorPoints(
      geometry,
      presentationWith({ "*": [{ decorId: "pebble", density: 1, variantCount: 1, jitter: 0 }] }),
    );
    // 6×4 共 24 格，(5,3) 不可走 → 23
    expect(points).toHaveLength(WIDTH * HEIGHT - 1);
    for (const point of points) {
      const { tx, ty } = tileOf(point);
      expect(point.variant).toBe(0);
      expect(point.x).toBe((tx + 0.5) * TILE);
      expect(point.y).toBe((ty + 0.5) * TILE);
    }
  });

  it("具体 region 只命中该区域；\"*\" 兜底全图；onWalkable=false 落在不可走格", () => {
    const config = presentationWith({
      forest: [{ decorId: "bush", density: 1, variantCount: 1, jitter: 0 }],
      "*": [
        { decorId: "pebble", density: 1, variantCount: 1, jitter: 0 },
        { decorId: "reed", density: 1, variantCount: 1, onWalkable: false, jitter: 0 },
      ],
    });
    const points = computeDecorPoints(makeDecorGeometry(), config);

    const forest = pointsAt(points, 0, 1);
    expect(forest.map((point) => point.decorId)).toEqual(["bush", "pebble", "reed"]);
    expect(forest[0]!.region).toBe("forest");
    expect(forest[0]!.level).toBe(0);

    const beach = pointsAt(points, 3, 1);
    expect(beach.map((point) => point.decorId)).toEqual(["pebble", "reed"]);
    expect(beach[0]!.region).toBe("beach");

    // 不可走格：onWalkable 规则跳过，onWalkable=false 规则仍落点
    const blocked = pointsAt(points, 5, 3);
    expect(blocked.map((point) => point.decorId)).toEqual(["reed"]);

    // 首行 level=1 传播到点
    const top = pointsAt(points, 0, 0);
    expect(top[0]!.level).toBe(1);
  });

  it("jitter 把点限制在自己的 tile 内；variant 落在 [0, variantCount)", () => {
    const points = computeDecorPoints(
      makeDecorGeometry(),
      presentationWith({
        "*": [{ decorId: "pebble", density: 1, variantCount: 4, jitter: 1 }],
      }),
    );
    expect(points.length).toBe(WIDTH * HEIGHT - 1);
    for (const point of points) {
      const { tx, ty } = tileOf(point);
      expect(point.x).toBeGreaterThanOrEqual(tx * TILE);
      expect(point.x).toBeLessThan((tx + 1) * TILE);
      expect(point.y).toBeGreaterThanOrEqual(ty * TILE);
      expect(point.y).toBeLessThan((ty + 1) * TILE);
      expect(point.variant).toBeGreaterThanOrEqual(0);
      expect(point.variant).toBeLessThan(4);
    }
  });
});

describe("map-decor: 配置校验与查询", () => {
  it("未知 decorId / 未知字段 / 资源路径字段 / 越界数值即加载报错", () => {
    expect(() =>
      loadPresentation({
        decor: { bush: {} },
        decorMaps: {
          "decor-map": { regions: { "*": [{ decorId: "ghost", density: 1 }] } },
        },
      }),
    ).toThrow(/unknown decor "ghost"/);

    expect(() =>
      loadPresentation({
        decor: { bush: {} },
        decorMaps: {
          "decor-map": {
            regions: { "*": [{ decorId: "bush", density: 1, texture: "res://bush.png" }] },
          },
        },
      }),
    ).toThrow();

    expect(() => loadPresentation({ decor: { bush: { texture: "res://bush.png" } } })).toThrow();

    for (const bad of [
      { density: -0.1 },
      { density: 1.1 },
      { density: 1, variantCount: 0 },
      { density: 1, variantCount: 1.5 },
      { density: 1, jitter: -0.1 },
      { density: 1, jitter: 1.1 },
    ]) {
      expect(() =>
        loadPresentation({
          decor: { bush: {} },
          decorMaps: { "decor-map": { regions: { "*": [{ decorId: "bush", ...bad }] } } },
        }),
      ).toThrow();
    }
  });

  it("未知 mapId / region 由 validatePresentation 报错（\"*\" 恒合法）", () => {
    const config = loadPresentation({
      decor: { bush: {} },
      decorMaps: {
        "decor-map": {
          regions: {
            forest: [{ decorId: "bush", density: 1 }],
            meadow: [{ decorId: "bush", density: 1 }],
            "*": [{ decorId: "bush", density: 0.1, variantCount: 1, onWalkable: true, jitter: 0.35 }],
          },
        },
        ghost: { regions: { "*": [{ decorId: "bush", density: 1 }] } },
      },
    });
    const report = validatePresentation({
      resolvedPresentation: config,
      resolvedMapConfigs: [{ key: "decor-map", initialAgeTicks: 0, pipeline: [] }],
      resolvedMapRegionNames: new Map([["decor-map", new Set(["forest", "beach"])]]),
      resolvedRules: {},
    });

    expect(report.ok).toBe(false);
    expect(report.errors).toContain(
      'presentation: decor map "decor-map" references unknown region "meadow"',
    );
    expect(report.errors).toContain(
      'presentation: decor map "ghost" is not declared in the map registry',
    );
  });

  it("loadGameDefinition 拒绝装饰规则引用生成管道未声明的 region", () => {
    const dir = mkdtempSync(join(tmpdir(), "decor-fixture-"));
    dirs.push(dir);
    mkdirSync(join(dir, "maps"), { recursive: true });
    mkdirSync(join(dir, "presentation"), { recursive: true });
    writeFileSync(
      join(dir, "game.json"),
      JSON.stringify({
        id: "decor-fixture",
        tickRate: 20,
        world: { tile: { width: 16, height: 16 } },
        map: { registry: "./maps/registry.json" },
      }),
    );
    writeFileSync(
      join(dir, "maps", "registry.json"),
      JSON.stringify({
        maps: {
          fixture: {
            kind: "pipeline",
            seed: 1,
            initialAgeTicks: 0,
            pipeline: [{ generator: "noise-terrain", params: {} }],
          },
        },
      }),
    );
    writeFileSync(
      join(dir, "presentation", "decor.json"),
      JSON.stringify({
        decor: { bush: {} },
        decorMaps: {
          fixture: { regions: { forest: [{ decorId: "bush", density: 1 }] } },
        },
      }),
    );

    expect(() => loadGameDefinition({ gameJsonPath: join(dir, "game.json") })).toThrow(
      /decor map "fixture" references unknown region "forest"/,
    );
  });

  it("纯 decor.json（无 maps.json）可独立加载", () => {
    const dir = mkdtempSync(join(tmpdir(), "decor-only-fixture-"));
    dirs.push(dir);
    mkdirSync(join(dir, "maps"), { recursive: true });
    mkdirSync(join(dir, "presentation"), { recursive: true });
    writeFileSync(
      join(dir, "game.json"),
      JSON.stringify({
        id: "decor-only-fixture",
        tickRate: 20,
        world: { tile: { width: 16, height: 16 } },
        map: { registry: "./maps/registry.json" },
      }),
    );
    writeFileSync(
      join(dir, "maps", "registry.json"),
      JSON.stringify({
        maps: {
          fixture: {
            kind: "pipeline",
            seed: 1,
            initialAgeTicks: 0,
            pipeline: [{ generator: "noise-terrain", params: {} }],
          },
        },
      }),
    );
    writeFileSync(
      join(dir, "presentation", "decor.json"),
      JSON.stringify({
        decor: { bush: {} },
        decorMaps: {
          fixture: { regions: { "*": [{ decorId: "bush", density: 0.5 }] } },
        },
      }),
    );

    const loaded = loadGameDefinition({ gameJsonPath: join(dir, "game.json") });
    expect(loaded.resolvedPresentation?.decor?.bush).toEqual({});
    expect(loaded.resolvedPresentation?.decorMaps?.fixture.regions["*"]?.[0]?.decorId).toBe(
      "bush",
    );
    // schema 缺省值已补全（variantCount=1 / onWalkable=true / jitter=0.35）
    expect(loaded.resolvedPresentation?.decorMaps?.fixture.regions["*"]?.[0]).toMatchObject({
      density: 0.5,
      variantCount: 1,
      onWalkable: true,
      jitter: 0.35,
    });
  });

  it("无配置：decorMaps 查询 undefined、id 表空、点集空", () => {
    clearPresentation();
    expect(getDecorMapRules("decor-map")).toBeUndefined();
    expect(listDecorIds()).toEqual([]);
    expect(computeDecorPoints(makeDecorGeometry(), undefined)).toEqual([]);

    loadPresentation({});
    expect(getDecorRulesForRegion("decor-map", "forest")).toEqual([]);
    expect(computeDecorPoints(makeDecorGeometry(), undefined)).toEqual([]);
  });

  it("查询层：listDecorIds 排序稳定；getDecorRulesForRegion 具体在前、\"*\" 在后", () => {
    presentationWith({
      forest: [{ decorId: "bush", density: 1 }],
      "*": [{ decorId: "pebble", density: 0.1 }],
    });
    expect(listDecorIds()).toEqual(["bush", "pebble", "reed"]);
    expect(getDecorRulesForRegion("decor-map", "forest").map((rule) => rule.decorId)).toEqual([
      "bush",
      "pebble",
    ]);
    expect(getDecorRulesForRegion("decor-map", "beach").map((rule) => rule.decorId)).toEqual([
      "pebble",
    ]);
    expect(getDecorRulesForRegion("decor-map", "*").map((rule) => rule.decorId)).toEqual([
      "pebble",
    ]);
    expect(getDecorRulesForRegion("no-such-map", "forest")).toEqual([]);
  });
});

describe("map-decor: 缓存与版本", () => {
  it("同 geometry 同版本复用；写回重算 version 后重建", () => {
    loadPresentation({
      decor: { bush: {} },
      decorMaps: {
        "decor-map": {
          regions: { "*": [{ decorId: "bush", density: 1, variantCount: 1, jitter: 0 }] },
        },
      },
    });
    const geometry = makeDecorGeometry();
    const first = buildMapDecorView(geometry);
    expect(buildMapDecorView(geometry)).toBe(first);
    expect(first.points).toHaveLength(WIDTH * HEIGHT - 1);

    // 模拟 terrainWriteback：原地改 walkable + 重算 version
    geometry.walkable[0] = 0;
    const nextVersion = computeGeometryVersion(geometry);
    expect(nextVersion).not.toBe(geometry.version);
    geometry.version = nextVersion;

    const second = buildMapDecorView(geometry);
    expect(second).not.toBe(first);
    expect(second.version).toBe(nextVersion);
    expect(second.points).toHaveLength(WIDTH * HEIGHT - 2);
  });

  it("配置重新加载（revision 变化）后重建；无配置时点集为空", () => {
    loadPresentation({
      decor: { bush: {} },
      decorMaps: {
        "decor-map": { regions: { "*": [{ decorId: "bush", density: 1, variantCount: 1 }] } },
      },
    });
    const geometry = makeDecorGeometry();
    const first = buildMapDecorView(geometry);
    const revision = getPresentationRevision();

    loadPresentation({
      decor: { bush: {} },
      decorMaps: {
        "decor-map": { regions: { "*": [{ decorId: "bush", density: 0 }] } },
      },
    });
    expect(getPresentationRevision()).toBeGreaterThan(revision);
    const second = buildMapDecorView(geometry);
    expect(second).not.toBe(first);
    expect(second.points).toEqual([]);

    clearPresentation();
    const third = buildMapDecorView(geometry);
    expect(third).not.toBe(second);
    expect(third.points).toEqual([]);
  });
});

describe("map-decor: contentVersion", () => {
  it("decor ids / decorMaps 规则变化即推进版本", () => {
    const base = computeContentVersion({ tickRate: 20 });
    const withDecor = computeContentVersion({
      tickRate: 20,
      presentation: {
        decor: { bush: {} },
        decorMaps: {
          "decor-map": { regions: { "*": [{ decorId: "bush", density: 0.1, variantCount: 1, onWalkable: true, jitter: 0.35 }] } },
        },
      },
    });
    expect(withDecor).not.toBe(base);
    expect(
      computeContentVersion({
        tickRate: 20,
        presentation: {
          decor: { bush: {}, pebble: {} },
          decorMaps: {
            "decor-map": { regions: { "*": [{ decorId: "bush", density: 0.1, variantCount: 1, onWalkable: true, jitter: 0.35 }] } },
          },
        },
      }),
    ).not.toBe(withDecor);
    expect(
      computeContentVersion({
        tickRate: 20,
        presentation: {
          decor: { bush: {} },
          decorMaps: {
            "decor-map": { regions: { "*": [{ decorId: "bush", density: 0.2, variantCount: 1, onWalkable: true, jitter: 0.35 }] } },
          },
        },
      }),
    ).not.toBe(withDecor);
  });
});

afterAll(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
