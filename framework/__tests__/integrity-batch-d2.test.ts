/**
 * 批次 D2（完整性审计 2026-10-18）：
 * - F-20 new-game 脚手架产物可直接通过 validate（loadGameDefinition）；
 * - F-21 place / progression 规则 schema 注册，非法配置在加载期报错；
 * - F-34 rocky 夜狼规则周期可达（夜间演化能产出且受 max 1 约束）；
 * - F-35 无限资源/燃料显式语义（infinite / fuelInfinite）与入档往返。
 */
import { describe, it, expect, beforeAll } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addComponent, addEntity, query } from "bitecs";
import {
  bootstrapFramework,
  createGameInstance,
  createDefaultGameDefinition,
  loadGameDefinition,
  restoreWorld,
  serializeWorld,
  spawnEntity,
} from "framework/index";
import { getRuleSchema } from "framework/config/schema/ruleSchemas";
import { ProgressionRuleSchema, PlaceRuleSchema } from "framework/config/schema/RuleSchema";
import { parseProgressionRules } from "framework/systems/gameplay/progression";
import { newGame } from "../../tools/new-game";
import { Transform } from "framework/components/transform";
import { NetworkId } from "framework/components/network";
import { Player, Resource } from "framework/components/tags";
import { Health } from "framework/components/combat";
import { Inventory } from "framework/components/inventory";
import { Equipment } from "framework/components/equipment";
import { Kind } from "framework/components/kind";
import { entityMapOf } from "framework/components/entityMap";
import { ResourceNode } from "framework/components/resourceNode";
import { LightSource } from "framework/components/lightSource";
import { harvest } from "framework/systems/gameplay/gatheringSystem";
import { stepFuelBurn, fastForwardFuelBurn } from "framework/systems/gameplay/fuelSystem";
import { isPointInLight } from "framework/utils/light";
import { evolve } from "map/evolution/engine";
import { createMapEvolveDeps } from "map/runtime/evolveDeps";
import { regionOf } from "map/geometry/query";
import type { GameWorld } from "framework/world";
import type { ItemKindSpec } from "framework/config/schema/ItemKindSchema";
import type { MapConfig } from "framework/config/schema/MapRegistrySchema";
import type { MapGeometry } from "map/geometry/types";

beforeAll(() => {
  bootstrapFramework();
});

/* ------------------------------------------------------------------ */
/* F-20 new-game 脚手架                                                 */
/* ------------------------------------------------------------------ */

function scaffold(id: string): { root: string; configPath: string } {
  const root = mkdtempSync(join(tmpdir(), `d2-${id}-`));
  const outDir = join(root, "game");
  newGame(["--id", id, "--out", outDir]);
  return { root, configPath: join(outDir, "game.json") };
}

describe("F-20 new-game 脚手架产物合法", () => {
  it("生成的 pipeline 地图 + 出生规则通过 validate（loadGameDefinition）", () => {
    const { root, configPath } = scaffold("smoke-game");
    try {
      const def = loadGameDefinition({ gameJsonPath: configPath });
      expect(def.resolvedMapConfigs).toHaveLength(1);
      const mapConfig = def.resolvedMapConfigs[0]!;
      expect(mapConfig.key).toBe("smoke-game-map");
      expect(mapConfig.pipeline.map((step) => step.generator)).toEqual([
        "noise-terrain",
        "climate-regions",
        "region-stats",
      ]);
      // 出生规则随脚手架生成，真实可启动
      expect(def.resolvedRules["player"]).toMatchObject({ spawn: { mode: "random" } });
      expect(def.map?.default).toBe("smoke-game-map");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("脚手架地图可开机构建（生成管道无非法参数）", () => {
    const { root, configPath } = scaffold("boot-game");
    try {
      const def = loadGameDefinition({ gameJsonPath: configPath });
      const instance = createGameInstance(def);
      expect(instance.world.maps["boot-game-map"]).toBeDefined();
      expect(instance.world.activeMaps.has("boot-game-map")).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

/* ------------------------------------------------------------------ */
/* F-21 place / progression 规则 schema                                 */
/* ------------------------------------------------------------------ */

describe("F-21 规则 schema 注册与非法配置拒绝", () => {
  it("place / progression 已注册；缺省值与此前运行时兜底一致", () => {
    expect(getRuleSchema("place")).toBe(PlaceRuleSchema);
    expect(getRuleSchema("progression")).toBe(ProgressionRuleSchema);

    expect(PlaceRuleSchema.parse({})).toEqual({
      placeRange: 64,
      containerRange: 64,
      gridSnap: false,
    });
    const progression = ProgressionRuleSchema.parse({});
    expect(progression).toEqual({});
    // 运行时解析仍补全曲线缺省（100 / 1.5 / 20 来自真实配置；空配置走默认 100/2/99）
    expect(parseProgressionRules({}).curve).toEqual({ baseXp: 100, growth: 2, maxLevel: 99 });
  });

  it("非法 place 配置在 validate 阶段（loadGameDefinition）被拒绝", () => {
    const { root, configPath } = scaffold("bad-place");
    try {
      writeFileSync(
        join(root, "game", "rules", "place.json"),
        JSON.stringify({ placeRange: "far", gridSnap: "yes" }),
        "utf8",
      );
      expect(() => loadGameDefinition({ gameJsonPath: configPath })).toThrow(/placeRange/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("非法 progression 配置在 validate 阶段被拒绝，且运行时 fail-fast 同源", () => {
    const { root, configPath } = scaffold("bad-progression");
    try {
      writeFileSync(
        join(root, "game", "rules", "progression.json"),
        JSON.stringify({ curve: { baseXp: 0 }, skills: { combat: { stat: "", perLevel: 1 } } }),
        "utf8",
      );
      expect(() => loadGameDefinition({ gameJsonPath: configPath })).toThrow(/baseXp/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }

    expect(() => parseProgressionRules({ curve: { baseXp: 0 } })).toThrow(/baseXp/);
    expect(() => parseProgressionRules({ curve: { growth: 0.5 } })).toThrow(/growth/);
    expect(() =>
      parseProgressionRules({ skills: { combat: { stat: "attack", perLevel: 1, mode: "bad" } } }),
    ).toThrow(/mode/);
  });

  it("真实游戏配置零回归：place/progression 解析出完整字段", () => {
    const def = loadGameDefinition({ gameJsonPath: "game/game.json" });
    expect(def.resolvedRules["place"]).toMatchObject({
      placeRange: 64,
      containerRange: 64,
      gridSnap: true,
    });
    expect(def.resolvedRules["progression"]).toMatchObject({
      curve: { baseXp: 100, growth: 1.5, maxLevel: 20 },
    });
  });
});

/* ------------------------------------------------------------------ */
/* F-34 rocky 夜狼                                                      */
/* ------------------------------------------------------------------ */

const ROCKY_MAP = "rocky-night-map";

function rockyMapConfig(): MapConfig {
  return {
    key: ROCKY_MAP,
    seed: 42,
    initialAgeTicks: 0,
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
      { generator: "climate-regions", params: { names: ["rocky"], style: "noise" } },
    ],
  };
}

function countKind(world: GameWorld, kind: string): number {
  let count = 0;
  for (const eid of query(world, [NetworkId])) {
    if (Kind[eid] === kind) count += 1;
  }
  return count;
}

/** 构造 rocky 区域 + 夜狼规则（max 1, every 900, isNight）的合成世界。 */
function createRockyWorld(): { world: GameWorld; def: ReturnType<typeof createDefaultGameDefinition> } {
  const def = createDefaultGameDefinition();
  def.resolvedEntities = [{ kind: "eco-wolf", components: {} }];
  def.resolvedMapConfigs = [rockyMapConfig()];
  def.resolvedEntityRules = [];
  def.resolvedStaticEntityRules = [];
  def.resolvedEcosystems = {
    ecosystems: [
      {
        biome: "rocky",
        spawnTable: [{ kind: "eco-wolf", max: 1, every: 900, condition: "isNight" }],
      },
    ],
  };
  def.resolvedRules = {
    daynight: { cycleLengthSec: 600, nightStartHour: 19, nightEndHour: 5 },
  };
  const instance = createGameInstance(def);
  return { world: instance.world, def };
}

describe("F-34 rocky 夜狼规则可达", () => {
  it("真实配置：rocky wolf = max 1 / isNight / 周期 ≤ 1200 tick", () => {
    const def = loadGameDefinition({ gameJsonPath: "game/game.json" });
    const rocky = def.resolvedEcosystems?.ecosystems.find((eco) => eco.biome === "rocky");
    expect(rocky).toBeDefined();
    const wolf = rocky!.spawnTable.find((entry) => entry.kind === "wolf");
    expect(wolf).toMatchObject({ kind: "wolf", max: 1, condition: "isNight" });
    expect("every" in wolf!).toBe(true);
    expect((wolf as { every: number }).every).toBeLessThanOrEqual(1200);
  });

  it("真实 game 配置：夜间 evolve 在 island rocky 区产出 1 只狼且不超 max", () => {
    const def = loadGameDefinition({ gameJsonPath: "game/game.json" });
    // 所有图初始年龄归零：跳过开机大跨度演化，只验证本次夜间 evolve
    def.resolvedMapConfigs = def.resolvedMapConfigs.map((config) => ({
      ...config,
      initialAgeTicks: 0,
    }));
    const instance = createGameInstance(def);
    const world = instance.world;
    const geometry = world.maps["island"]!;
    expect(geometry).toBeDefined();

    // 真实 daynight：600s × 20tps = 12000 tick/天；tick 5500 = 19 时入夜
    world.time.tick = 5500;
    const deps = createMapEvolveDeps(world, geometry, 1337);
    evolve(world, geometry, def.resolvedEntityRules, 0, 1200, deps);

    const rockyWolves = (): number[] =>
      [...query(world, [NetworkId])].filter((eid) => {
        if (Kind[eid] !== "wolf" || entityMapOf(world, eid) !== "island") return false;
        const tx = Math.floor(Transform.x[eid] / geometry.grid.tileWidth);
        const ty = Math.floor(Transform.y[eid] / geometry.grid.tileHeight);
        return regionOf(geometry, tx, ty) === "rocky";
      });

    // rocky 规则 max 1（forest/wilderness 另有狼规则，按区域过滤后只看 rocky）
    expect(rockyWolves()).toHaveLength(1);

    // 再次推进 3 个夜间周期：已到 max 1，不再补足
    evolve(world, geometry, def.resolvedEntityRules, 1200, 4200, deps);
    expect(rockyWolves()).toHaveLength(1);
  });

  it("夜间演化产出 1 只狼；跨槽重复演化不超过 max", () => {
    const { world, def } = createRockyWorld();
    const geometry = world.maps[ROCKY_MAP] as MapGeometry;
    expect(geometry).toBeDefined();

    // 开机初始演化（tick 0 = 白天）不产狼
    expect(countKind(world, "eco-wolf")).toBe(0);

    // 把时钟推到入夜（tick 0 = 8 时；600s 周期 × 20tps = 12000 tick/天；19 时 = 5500）
    world.time.tick = 5500;
    const deps = createMapEvolveDeps(world, geometry, 42);
    evolve(world, geometry, def.resolvedEntityRules, 0, 1000, deps);
    expect(countKind(world, "eco-wolf")).toBe(1);

    // 后续夜间槽：已到 max，不再补足
    evolve(world, geometry, def.resolvedEntityRules, 1000, 3000, deps);
    expect(countKind(world, "eco-wolf")).toBe(1);
  });
});

/* ------------------------------------------------------------------ */
/* F-35 无限资源 / 无限燃料                                             */
/* ------------------------------------------------------------------ */

function createBareWorld(): GameWorld {
  return createGameInstance(createDefaultGameDefinition()).world;
}

function setItemKind(world: GameWorld, spec: ItemKindSpec): void {
  world.gameDef.itemsByKind!.set(spec.kind, spec);
}

function spawnTestPlayer(world: GameWorld): number {
  const eid = addEntity(world);
  addComponent(world, eid, Transform);
  addComponent(world, eid, NetworkId);
  addComponent(world, eid, Player);
  addComponent(world, eid, Health);
  Health.current[eid] = 100;
  Health.max[eid] = 100;
  Inventory[eid] = { capacity: 4, slots: [null, null, null, null] };
  addComponent(world, eid, Equipment);
  Equipment.weaponSlot[eid] = -1;
  Equipment.toolSlot[eid] = -1;
  Equipment.armorSlot[eid] = -1;
  NetworkId.value[eid] = world.nextNetworkId++;
  return eid;
}

interface NodeOpts {
  remaining?: number;
  max?: number;
  infinite?: boolean;
  yieldsKind?: string;
  directConsume?: boolean;
}

function spawnTestResource(world: GameWorld, opts: NodeOpts = {}): number {
  const eid = addEntity(world);
  addComponent(world, eid, Transform);
  addComponent(world, eid, NetworkId);
  addComponent(world, eid, Resource);
  const max = opts.max ?? opts.remaining ?? 5;
  ResourceNode[eid] = {
    remaining: opts.remaining ?? max,
    max,
    infinite: opts.infinite === true,
    amountPerHit: 1,
    regenMs: 0,
    yieldsKind: opts.yieldsKind ?? "wood",
    directConsume: opts.directConsume === true,
    depletedSinceMs: null,
  };
  NetworkId.value[eid] = world.nextNetworkId++;
  return eid;
}

describe("F-35 无限资源节点（ResourceNode.infinite）", () => {
  it("infinite=true：多次采集仍成功且 remaining 不消耗", () => {
    const world = createBareWorld();
    setItemKind(world, { kind: "water", maxStack: 10 });
    const player = spawnTestPlayer(world);
    const node = spawnTestResource(world, {
      remaining: 1,
      max: 1,
      infinite: true,
      yieldsKind: "water",
      directConsume: true,
    });

    for (let i = 0; i < 5; i++) {
      expect(harvest(world, player, node)).toBe(true);
    }
    expect(ResourceNode[node]!.remaining).toBe(1);
    expect(ResourceNode[node]!.depletedSinceMs).toBeNull();
  });

  it("infinite 缺省 false：有限次数语义零回归", () => {
    const world = createBareWorld();
    setItemKind(world, { kind: "wood", maxStack: 10 });
    const player = spawnTestPlayer(world);
    const node = spawnTestResource(world, { remaining: 2, max: 2 });

    expect(harvest(world, player, node)).toBe(true);
    expect(harvest(world, player, node)).toBe(true);
    expect(ResourceNode[node]!.remaining).toBe(0);
    expect(harvest(world, player, node)).toBe(false);
  });

  it("真实配置：water_pool 用 infinite 替代 9999 魔法值", () => {
    const def = loadGameDefinition({ gameJsonPath: "game/game.json" });
    const pool = def.resolvedEntities.find((entity) => entity.kind === "water_pool")!;
    const node = pool.components.ResourceNode as {
      infinite?: boolean;
      remaining?: number;
      max?: number;
    };
    expect(node.infinite).toBe(true);
    expect(node.remaining).toBe(1);
    expect(node.max).toBe(1);
  });
});

describe("F-35 无限燃料（LightSource.fuelInfinite）", () => {
  it("fuelInfinite=1：在线/离线燃烧均不消耗，且燃料为 0 仍点亮", () => {
    const world = createBareWorld();
    world.gameDef.resolvedRules["crafting"] = {
      fuel: { burnMsPerTick: 100, items: { wood: 1000 } },
    };
    const eid = addEntity(world);
    addComponent(world, eid, Transform);
    addComponent(world, eid, LightSource);
    LightSource.fuelRemainingMs[eid] = 500;
    LightSource.fuelInfinite[eid] = 1;
    LightSource.radius[eid] = 64;

    stepFuelBurn(world);
    fastForwardFuelBurn(world, 100);
    expect(LightSource.fuelRemainingMs[eid]).toBe(500);
    expect(isPointInLight(world, 0, 0)).toBe(true);

    // 燃料归零也仍视为点亮（无限语义）
    LightSource.fuelRemainingMs[eid] = 0;
    expect(isPointInLight(world, 0, 0)).toBe(true);

    // 关闭无限标记 → 历史有限燃烧语义
    LightSource.fuelInfinite[eid] = 0;
    expect(isPointInLight(world, 0, 0)).toBe(false);
    LightSource.fuelRemainingMs[eid] = 500;
    stepFuelBurn(world);
    expect(LightSource.fuelRemainingMs[eid]).toBe(400);
    fastForwardFuelBurn(world, 2);
    expect(LightSource.fuelRemainingMs[eid]).toBe(200);
  });

  it("真实配置：campfire 用 fuelInfinite 替代 1e9 魔法值，初始燃料仍为正", () => {
    const def = loadGameDefinition({ gameJsonPath: "game/game.json" });
    const campfire = def.resolvedEntities.find((entity) => entity.kind === "campfire")!;
    const light = campfire.components.LightSource as {
      fuelInfinite?: boolean;
      fuelRemainingMs?: number;
    };
    expect(light.fuelInfinite).toBe(true);
    expect(light.fuelRemainingMs).toBeGreaterThan(0);
    expect(light.fuelRemainingMs).toBeLessThan(1_000_000_000);
  });

  it("入档往返：infinite / fuelInfinite 布尔字段随组件保存与恢复", () => {
    const world = createBareWorld();
    const spec = {
      kind: "inf-node",
      components: {
        ResourceNode: { infinite: true, remaining: 1, max: 1, yieldsKind: "water" },
        LightSource: { fuelInfinite: true, fuelRemainingMs: 500, radius: 64 },
      },
    };
    if (!world.archetypes.has(spec.kind)) world.archetypes.register(spec);
    spawnEntity(world, world.archetypes.get(spec.kind), world.components_registry);

    const record = serializeWorld(world, "inf-save");
    const restored = createBareWorld();
    if (!restored.archetypes.has(spec.kind)) restored.archetypes.register(spec);
    restoreWorld(restored, record);

    const eid = query(restored, [NetworkId]).find((id) => Kind[id] === spec.kind)!;
    expect(eid).toBeTypeOf("number");
    expect(ResourceNode[eid]!.infinite).toBe(true);
    expect(LightSource.fuelInfinite[eid]).toBe(1);
  });
});
