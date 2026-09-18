/**
 * 生态声明层（B1 编译器模式）——展开器单测 + boot 集成（map-system 设计 §5.5）。
 *
 * 展开器（map/evolution/ecosystems.ts，纯函数）：
 * - 密度式 max = floor(区域可走面积 × density)（面积 = regionOfTile 区域索引
 *   计数且 walkable=1，对已知手造几何断言精确值）；
 * - 显式式条目原样透传（max/every/condition，缺省无 condition 键）；
 * - biome 匹配：一 biome 多图各展开一份（density 按该图面积）、图无该 biome 跳过；
 * - 纯函数：两次调用产物深相等、输入不被改动。
 *
 * boot 集成（boot.ts 挂钩）：
 * - 合并规则到达演化引擎（density 产出实体数 = floor(area × density)）；
 * - 合并规则纳入 U5（展开 kind 未知 → 开机抛错）；
 * - 重复规则身份校验：静态规则与展开产物身份相撞 → 开机抛错点名身份；
 * - 同一 gameDef 多次开机不累积展开产物（活列表由 pristine 静态列表重算）。
 */
import { describe, it, expect, beforeAll } from "vitest";
import { query } from "bitecs";
import { bootstrapFramework, createDefaultGameDefinition, createGameInstance } from "framework/index";
import { expandEcosystemsForMap } from "map/evolution/ecosystems";
import { Kind } from "framework/components/kind";
import { Transform } from "framework/components/transform";
import type { EcosystemEntry, EcosystemsJson } from "framework/config/schema/EcosystemsSchema";
import type { MapGeometry } from "map/geometry/types";
import type { RegionMeta } from "map/geometry/types";
import type { LoadedGameDefinition } from "framework/config/schema/GameDefinitionSchema";
import type { MapConfig } from "framework/config/schema/MapRegistrySchema";
import type { GameWorld } from "framework/world";

beforeAll(() => {
  bootstrapFramework();
});

const KIND_A = "eco-ent-a";
const KIND_GHOST = "eco-ghost";

/**
 * 手造 4×4 双区域几何：alpha = 前 alphaCount 格（regions 插入序索引 0），
 * beta = 其余格（索引 1）。面积已知 → density max 可精确断言。
 */
function makeSplitGeometry(key: string, alphaCount: number): MapGeometry {
  const total = 16;
  const regions = new Map<string, RegionMeta>();
  regions.set("alpha", { name: "alpha", meta: {} });
  regions.set("beta", { name: "beta", meta: {} });
  const regionOfTile = new Uint16Array(total);
  for (let i = 0; i < total; i++) {
    regionOfTile[i] = i < alphaCount ? 0 : 1;
  }
  return {
    key,
    grid: { width: 4, height: 4, tileWidth: 16, tileHeight: 16 },
    tiles: new Uint8Array(total).fill(1),
    walkable: new Uint8Array(total).fill(1),
    regions,
    regionOfTile,
    version: "eco-test-fingerprint",
  };
}

describe("生态展开器（expandEcosystemsForMap 纯函数）", () => {
  const GEO = makeSplitGeometry("geo-a", 8); // alpha 面积 8、beta 面积 8

  it("密度式：max = floor(区域面积 × density)，every 缺省 20", () => {
    const rules = expandEcosystemsForMap("geo-a", GEO, [
      { biome: "alpha", spawnTable: [{ kind: KIND_A, density: 0.25 }] },
    ]);
    expect(rules).toEqual([
      { mode: "density", map: "geo-a", region: "alpha", kind: KIND_A, max: 2, every: 20 },
    ]);
  });

  it("密度式：floor 取整 + every 显式覆盖（0.3 × 8 = 2.4 → 2）", () => {
    const rules = expandEcosystemsForMap("geo-a", GEO, [
      { biome: "alpha", spawnTable: [{ kind: KIND_A, density: 0.3, every: 40 }] },
    ]);
    expect(rules).toEqual([
      { mode: "density", map: "geo-a", region: "alpha", kind: KIND_A, max: 2, every: 40 },
    ]);
  });

  it("显式式：max/every 原样透传，condition 可选透传", () => {
    const rules = expandEcosystemsForMap("geo-a", GEO, [
      { biome: "alpha", spawnTable: [{ kind: KIND_A, max: 6, every: 30 }] },
      { biome: "alpha", spawnTable: [{ kind: KIND_A, max: 4, every: 300, condition: "isNight" }] },
    ]);
    expect(rules).toEqual([
      { mode: "density", map: "geo-a", region: "alpha", kind: KIND_A, max: 6, every: 30 },
      { mode: "density", map: "geo-a", region: "alpha", kind: KIND_A, max: 4, every: 300, condition: "isNight" },
    ]);
  });

  it("biome 匹配：一 biome 多图各展开一份（max 按该图区域面积），图无该 biome 跳过", () => {
    const small = makeSplitGeometry("geo-small", 4); // alpha 面积 4
    const noAlpha = makeSplitGeometry("geo-noalpha", 0); // alpha 面积 0（索引仍在但无格）
    const ecosystems: EcosystemEntry[] = [
      { biome: "alpha", spawnTable: [{ kind: KIND_A, density: 0.25 }] },
    ];

    const big = expandEcosystemsForMap("geo-big", GEO, ecosystems);
    expect(big).toEqual([
      { mode: "density", map: "geo-big", region: "alpha", kind: KIND_A, max: 2, every: 20 },
    ]);
    expect(expandEcosystemsForMap("geo-small", small, ecosystems)).toEqual([
      { mode: "density", map: "geo-small", region: "alpha", kind: KIND_A, max: 1, every: 20 },
    ]);
    // biome 未注册于该图 → 整条跳过
    expect(expandEcosystemsForMap("geo-x", makeSplitGeometry("geo-x", 8), [
      { biome: "nowhere", spawnTable: [{ kind: KIND_A, density: 0.5 }] },
    ])).toEqual([]);
    expect(expandEcosystemsForMap("geo-noalpha", noAlpha, ecosystems)).toEqual([
      { mode: "density", map: "geo-noalpha", region: "alpha", kind: KIND_A, max: 0, every: 20 },
    ]);
  });

  it("面积语义：区域内不可走格不计入（density 按可走面积推导）", () => {
    // 4×4，alpha 占前 8 格，其中 3 格不可走 → 有效面积 5
    const geo = makeSplitGeometry("geo-walk", 8);
    for (const i of [1, 2, 3]) geo.walkable[i] = 0;
    const rules = expandEcosystemsForMap("geo-walk", geo, [
      { biome: "alpha", spawnTable: [{ kind: KIND_A, density: 0.4 }] },
    ]);
    expect(rules).toEqual([
      { mode: "density", map: "geo-walk", region: "alpha", kind: KIND_A, max: 2, every: 20 }, // floor(5 × 0.4)
    ]);
  });

  it("纯函数：两次调用产物深相等，输入数组不被改动", () => {
    const ecosystems: EcosystemEntry[] = [
      {
        biome: "alpha",
        spawnTable: [
          { kind: KIND_A, density: 0.25 },
          { kind: KIND_A, max: 3, every: 50, condition: "isNight" },
        ],
      },
    ];
    const snapshot = structuredClone(ecosystems);
    const run1 = expandEcosystemsForMap("geo-a", GEO, ecosystems);
    const run2 = expandEcosystemsForMap("geo-a", GEO, ecosystems);
    expect(run1).toEqual(run2);
    expect(ecosystems).toEqual(snapshot);
  });
});

// ---------------------------------------------------------------------------
// boot 集成：几何就绪 → 展开 → 合并 → 去重校验 → 初始演化
// ---------------------------------------------------------------------------

const MAP = "eco-map";

/** 8×8 全可走单区域图配置（同 map-boot-branch 的合成图）。 */
function mapConfig(key: string, seed: number): MapConfig {
  return {
    key,
    seed,
    initialAgeTicks: 1000,
    pipeline: [
      {
        generator: "noise-terrain",
        params: {
          width: 8,
          height: 8,
          tileWidth: 16,
          tileHeight: 16,
          bandLevel: 1,
          groundPalette: { "1": 1 },
          nonWalkableSemantics: [],
        },
      },
      { generator: "climate-regions", params: { names: ["alpha"], style: "noise" } },
    ],
  };
}

/** 独立统计几何上 alpha 区域的 tile 数（与展开器同一约定，作期望值基准）。 */
function regionArea(world: GameWorld, mapKey: string, region: string): number {
  const geometry = world.maps[mapKey]!;
  const index = [...geometry.regions.keys()].indexOf(region);
  let area = 0;
  for (const v of geometry.regionOfTile) {
    if (v === index) area += 1;
  }
  return area;
}

function countKind(world: GameWorld, kind: string): number {
  let n = 0;
  for (const eid of query(world, [Transform])) {
    if (Kind[eid] === kind) n += 1;
  }
  return n;
}

/** 组装带生态声明的 def（静态规则缺省为空；手造 EcosystemsJson 已是合法形态）。 */
function buildEcoDef(ecosystems: EcosystemsJson, staticRules: LoadedGameDefinition["resolvedStaticEntityRules"] = []): LoadedGameDefinition {
  const def = createDefaultGameDefinition();
  def.resolvedEntities = [{ kind: KIND_A, components: {} }];
  def.resolvedMapConfigs = [mapConfig(MAP, 42)];
  def.resolvedStaticEntityRules = staticRules;
  def.resolvedEntityRules = [...(staticRules ?? [])];
  def.resolvedEcosystems = ecosystems;
  return def;
}

describe("生态声明层 boot 集成（boot.ts 挂钩）", () => {
  it("合并规则到达演化引擎：初始演化产出 = floor(区域面积 × density)，静态列表保持 pristine", () => {
    const def = buildEcoDef({
      ecosystems: [{ biome: "alpha", spawnTable: [{ kind: KIND_A, density: 0.25 }] }],
    });
    const instance = createGameInstance(def);
    const world = instance.world;

    const expectedMax = Math.floor(regionArea(world, MAP, "alpha") * 0.25);
    expect(expectedMax).toBeGreaterThan(0);
    expect(countKind(world, KIND_A)).toBe(expectedMax);

    // 活列表 = 静态（空）+ 展开产物；静态列表未被改动
    expect(def.resolvedStaticEntityRules).toEqual([]);
    expect(def.resolvedEntityRules).toEqual([
      { mode: "density", map: MAP, region: "alpha", kind: KIND_A, max: expectedMax, every: 20 },
    ]);
  });

  it("合并规则纳入 U5：展开产物 kind 未知 → 开机抛错点名 kind", () => {
    const def = buildEcoDef({
      ecosystems: [{ biome: "alpha", spawnTable: [{ kind: KIND_GHOST, max: 1, every: 10 }] }],
    });
    expect(() => createGameInstance(def)).toThrow(new RegExp(KIND_GHOST));
  });

  it("重复规则身份校验：静态规则与生态展开产物身份相撞 → 开机抛错点名完整身份", () => {
    const def = buildEcoDef(
      {
        ecosystems: [{ biome: "alpha", spawnTable: [{ kind: KIND_A, max: 2, every: 10 }] }],
      },
      [{ mode: "density", map: MAP, region: "alpha", kind: KIND_A, max: 2, every: 10 }],
    );
    // 身份 = map|region|kind|mode（两处规则的展开形态同为 density 模式）
    expect(() => createGameInstance(def)).toThrow(
      new RegExp(`重复规则身份 \`${MAP}\\|alpha\\|${KIND_A}\\|density\``),
    );
  });

  it("同一 gameDef 多次开机：活列表由 pristine 静态列表重算，不累积展开产物", () => {
    const def = buildEcoDef({
      ecosystems: [{ biome: "alpha", spawnTable: [{ kind: KIND_A, density: 0.25 }] }],
    });
    createGameInstance(def);
    const afterFirst = def.resolvedEntityRules.length;
    createGameInstance(def);
    expect(def.resolvedEntityRules.length).toBe(afterFirst);
  });
});
