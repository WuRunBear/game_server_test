/**
 * 生态切片 E1-a（F-10）：族群节点死亡回写 + Nest/Population 双通路收敛。
 *
 * 覆盖验收矩阵：
 * - 杀 N 只后匹配节点 count 下降 N（下限 0）；
 * - 杀光后下一槽不瞬满：引擎 target = 节点记账，按 growthRate 逐槽回补；
 * - 不同区域/物种/巢位不串账（最近节点、同距 eid 最小，确定性）；
 * - 玩家死亡、携带节点的来源实体（巢穴本源）自身销毁不回写；
 * - 巢穴被拆后不再产出（节点随来源实体消失 + Nest 让位）；
 * - Nest 与 Population 并存时 Nest 只镜像不生产（单一生产来源），
 *   仅带 Nest 的巢保持既有 capacity 语义。
 */
import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { query } from "bitecs";
import {
  bootstrapFramework,
  createDefaultGameDefinition,
  createGameInstance,
  getRegistries,
  spawnEntity,
} from "framework/index";
import { Kind } from "framework/components/kind";
import { Transform } from "framework/components/transform";
import { Health } from "framework/components/combat";
import { EntityMap, entityMapOf } from "framework/components/entityMap";
import { Nest } from "framework/components/nest";
import { Population, initPopulation } from "framework/simulation/population/population";
import { populationSystem } from "framework/simulation/population/populationSystem";
import { deathSystem } from "framework/systems/gameplay/deathSystem";
import { createNestSystem } from "framework/systems/gameplay/nestSystem";
import { walkableAt } from "map/geometry/query";
import { evolve, type EvolutionDeps } from "map/evolution/engine";
import type { EntityRule } from "map/evolution/schema";
import { makeTestGeometry } from "./helpers/mapGeometry";
import type { MapGeometry } from "map/geometry/types";
import type { GameWorld } from "framework/world";

beforeAll(() => {
  bootstrapFramework();
  const { archetypeRegistry } = getRegistries();
  const register = (spec: Parameters<typeof archetypeRegistry.register>[0]): void => {
    if (!archetypeRegistry.has(spec.kind)) archetypeRegistry.register(spec);
  };
  // 族群节点来源原型（Population 初始化钩子按配置写 AoS；具体参数被测试覆盖）
  register({
    kind: "pdw-node",
    components: {
      Population: {
        species: "pdw-spider",
        carryingDensity: 0.1,
        growthRate: 1,
        growthIntervalTicks: 10,
        homeRegion: "den",
        count: 0,
      },
    },
  });
  // 被记账的物种
  register({ kind: "pdw-spider", components: { Health: { current: 10, max: 10 } } });
  register({ kind: "pdw-frog", components: { Health: { current: 10, max: 10 } } });
  register({ kind: "pdw-player", tags: ["Player"], components: { Health: { current: 100, max: 100 } } });
  // Nest + Population 双通路来源
  register({
    kind: "pdw-nest-dual",
    components: {
      Nest: { spawnKind: "pdw-spider", capacity: 4, intervalTicks: 1 },
      Population: {
        species: "pdw-spider",
        carryingDensity: 0.1,
        growthRate: 1,
        growthIntervalTicks: 10,
        homeRegion: "den",
        count: 4,
      },
      Health: { current: 10, max: 10 },
    },
  });
  // 仅 Nest（既有纯巢穴语义）
  register({
    kind: "pdw-nest-only",
    components: { Nest: { spawnKind: "pdw-spider", capacity: 2, intervalTicks: 1 } },
  });
});

const KEY = "pdw-map";

/** 16×16 双区域几何：左半 den（索引 0，128 格）、右半 rest（索引 1）。 */
function makeGeometry(): MapGeometry {
  return makeTestGeometry({
    key: KEY,
    width: 16,
    height: 16,
    regions: ["den", "rest"],
    regionOfTile: (tx) => (tx < 8 ? 0 : 1),
  });
}

function createWorld(): GameWorld {
  const world = createGameInstance(createDefaultGameDefinition()).world;
  world.maps[KEY] = makeGeometry();
  world.activeMaps.add(KEY);
  world.defaultMapId = KEY;
  return world;
}

interface NodeSpec {
  species: string;
  count: number;
  growthRate?: number;
  growthIntervalTicks?: number;
  carryingDensity?: number;
  homeRegion?: string;
  tx?: number;
  ty?: number;
}

function spawnNode(world: GameWorld, spec: NodeSpec): number {
  const eid = spawnEntity(world, world.archetypes.get("pdw-node"), world.components_registry, {
    x: (spec.tx ?? 2) * 16 + 8,
    y: (spec.ty ?? 2) * 16 + 8,
    mapId: KEY,
  });
  Object.assign(Population[eid]!, {
    species: spec.species,
    count: spec.count,
    growthRate: spec.growthRate ?? 1,
    growthIntervalTicks: spec.growthIntervalTicks ?? 10,
    carryingDensity: spec.carryingDensity ?? 0.1,
    homeRegion: spec.homeRegion ?? "den",
  });
  return eid;
}

function spawnSpecies(world: GameWorld, kind: string, tx: number, ty: number): number {
  return spawnEntity(world, world.archetypes.get(kind), world.components_registry, {
    x: tx * 16 + 8,
    y: ty * 16 + 8,
    mapId: KEY,
  });
}

function countKind(world: GameWorld, kind: string): number {
  let n = 0;
  for (const eid of query(world, [Transform])) {
    if (Kind[eid] === kind) n += 1;
  }
  return n;
}

/** 杀一只（置 0 血 → deathSystem；死亡回写发生在 destroyEntity 前）。 */
function kill(world: GameWorld, eids: number[]): void {
  for (const eid of eids) Health.current[eid] = 0;
  deathSystem(world);
}

/** 假演化依赖：记录 spawn，countByKind 反映测试声明的存活数（不触 ECS）。 */
function makeEvolutionHarness(
  geometry: MapGeometry,
  alive: () => number,
): { deps: EvolutionDeps; spawns: Array<{ kind: string; x: number; y: number }> } {
  const spawns: Array<{ kind: string; x: number; y: number }> = [];
  const deps: EvolutionDeps = {
    seed: 7,
    countByKind: () => alive(),
    canPlace: (_mapKey, _kind, x, y) => walkableAt(geometry, x, y),
    spawn: (kind, _mapKey, x, y) => {
      spawns.push({ kind, x, y });
    },
  };
  return { deps, spawns };
}

function nodeRule(max: number): EntityRule {
  return { map: KEY, region: "den", kind: "pdw-spider", max, every: 20, mode: "node" };
}

beforeEach(() => {
  // AoS 数组是模块级普通数组（不随 world 销毁）：清空防止跨用例串账。
  Population.length = 0;
  Nest.length = 0;
  EntityMap.length = 0;
  Kind.length = 0;
});

describe("死亡回写：击杀从节点记账扣除", () => {
  it("杀 N 只 → 匹配节点 count 下降 N，实体正常销毁", () => {
    const world = createWorld();
    const nodeEid = spawnNode(world, { species: "pdw-spider", count: 5 });
    const spiders = [spawnSpecies(world, "pdw-spider", 2, 2), spawnSpecies(world, "pdw-spider", 3, 3), spawnSpecies(world, "pdw-spider", 4, 4)];

    kill(world, spiders);

    expect(Population[nodeEid]!.count).toBe(2);
    expect(countKind(world, "pdw-spider")).toBe(0);
  });

  it("下限 0：击杀数超过记账数时不为负", () => {
    const world = createWorld();
    const nodeEid = spawnNode(world, { species: "pdw-spider", count: 1 });
    const spiders = [spawnSpecies(world, "pdw-spider", 2, 2), spawnSpecies(world, "pdw-spider", 3, 3), spawnSpecies(world, "pdw-spider", 4, 4)];

    kill(world, spiders);

    expect(Population[nodeEid]!.count).toBe(0);
  });

  it("分区域/分物种不串账；同区同物种取最近节点（确定性）", () => {
    const world = createWorld();
    const spiderDen = spawnNode(world, { species: "pdw-spider", count: 5, tx: 1, ty: 1 });
    const spiderDenFar = spawnNode(world, { species: "pdw-spider", count: 5, tx: 14, ty: 14, homeRegion: "rest" });
    const frogDen = spawnNode(world, { species: "pdw-frog", count: 5, tx: 1, ty: 6 });
    // 同区同物种的第二处巢：击杀落在更近的一处
    const spiderDenNear = spawnNode(world, { species: "pdw-spider", count: 5, tx: 6, ty: 6 });

    kill(world, [spawnSpecies(world, "pdw-spider", 7, 7)]);
    expect(Population[spiderDenNear]!.count).toBe(4);
    expect(Population[spiderDen]!.count).toBe(5);
    expect(Population[spiderDenFar]!.count).toBe(5);
    expect(Population[frogDen]!.count).toBe(5);

    kill(world, [spawnSpecies(world, "pdw-frog", 2, 7)]);
    expect(Population[frogDen]!.count).toBe(4);
    expect(Population[spiderDen]!.count).toBe(5);

    // rest 区的击杀只扣 rest 区节点
    kill(world, [spawnSpecies(world, "pdw-spider", 13, 13)]);
    expect(Population[spiderDenFar]!.count).toBe(4);
    expect(Population[spiderDen]!.count).toBe(5);
  });

  it("玩家死亡不影响节点（即使节点 species 与玩家 kind 相同）", () => {
    const world = createWorld();
    const nodeEid = spawnNode(world, { species: "pdw-player", count: 3 });
    const playerEid = spawnSpecies(world, "pdw-player", 2, 2);

    kill(world, [playerEid]);

    expect(Population[nodeEid]!.count).toBe(3);
    expect([...query(world, [Transform])]).toContain(playerEid); // 玩家原地重生，不销毁
  });

  it("携带节点的来源实体自身死亡不回写（节点随来源消失，不是减员）", () => {
    const world = createWorld();
    const tracked = spawnNode(world, { species: "pdw-spider", count: 3 });
    // 物种实体自身挂 Population 节点（来源实体语义）
    const sourceEid = spawnSpecies(world, "pdw-spider", 5, 5);
    initPopulation(world, sourceEid, {
      species: "pdw-spider",
      carryingDensity: 0.1,
      growthRate: 0,
      growthIntervalTicks: 10,
      homeRegion: "den",
      count: 4,
    });

    kill(world, [sourceEid]);

    expect(Population[sourceEid]).toBeUndefined();
    expect(Population[tracked]!.count).toBe(3);
  });
});

describe("死亡回写 × 演化槽：不会下一槽瞬满", () => {
  it("杀光后下一槽零产出，之后每增长槽只回补增长率（1 只）", () => {
    const world = createWorld();
    const geometry = world.maps[KEY];
    const nodeEid = spawnNode(world, {
      species: "pdw-spider",
      count: 6,
      growthRate: 1,
      growthIntervalTicks: 300,
      carryingDensity: 0.1, // cap = floor(128 × 0.1) = 12
    });
    const spiders = [2, 3, 4, 5, 6, 7].map((tx) => spawnSpecies(world, "pdw-spider", tx, 2));

    kill(world, spiders);
    expect(Population[nodeEid]!.count).toBe(0);
    expect(countKind(world, "pdw-spider")).toBe(0);

    // 下一规则槽（20）：节点尚未到增长槽 → target 0 → 不补种（旧行为会瞬满 6）
    const next = makeEvolutionHarness(geometry, () => 0);
    evolve(world, geometry, [nodeRule(6)], 0, 20, next.deps);
    expect(next.spawns).toEqual([]);

    // 增长槽（300）：节点 +1 → target 1 → 只回补 1 只
    const grown = makeEvolutionHarness(geometry, () => next.spawns.length);
    evolve(world, geometry, [nodeRule(6)], 20, 300, grown.deps);
    expect(grown.spawns).toHaveLength(1);
    expect(Population[nodeEid]!.count).toBe(1);
  });

  it("partial kill：节点与存活同步下降 → deficit 归零；逐槽按增长回补", () => {
    const world = createWorld();
    const nodeEid = spawnNode(world, {
      species: "pdw-spider",
      count: 4,
      growthRate: 1,
      growthIntervalTicks: 10,
    });
    const spiders = [2, 3, 4, 5].map((tx) => spawnSpecies(world, "pdw-spider", tx, 2));
    kill(world, spiders.slice(0, 2));
    expect(Population[nodeEid]!.count).toBe(2);

    world.time.tick = 10;
    populationSystem(world);
    expect(Population[nodeEid]!.count).toBe(3); // 只回补 1（非瞬满 4）
    world.time.tick = 20;
    populationSystem(world);
    expect(Population[nodeEid]!.count).toBe(4);
  });
});

describe("巢穴拆除与 Nest/Population 双通路", () => {
  it("巢穴被拆 → 节点消失 → 演化不再产出、Nest 不再补足", () => {
    const world = createWorld();
    const geometry = world.maps[KEY];
    const nestEid = spawnEntity(world, world.archetypes.get("pdw-nest-dual"), world.components_registry, {
      x: 4 * 16 + 8,
      y: 4 * 16 + 8,
      mapId: KEY,
    });
    expect(Population[nestEid]!.count).toBe(4);

    Health.current[nestEid] = 0;
    deathSystem(world);
    expect(Population[nestEid]).toBeUndefined();

    const harness = makeEvolutionHarness(geometry, () => 0);
    evolve(world, geometry, [nodeRule(6)], 0, 20, harness.deps);
    expect(harness.spawns).toEqual([]);

    world.time.tick = 1;
    createNestSystem({ radiusTiles: 1 })(world);
    expect(countKind(world, "pdw-spider")).toBe(0);
  });

  it("Nest + Population 并存：Nest 只镜像 current，不自行补足（单一生产来源）", () => {
    const world = createWorld();
    spawnEntity(world, world.archetypes.get("pdw-nest-dual"), world.components_registry, {
      x: 4 * 16 + 8,
      y: 4 * 16 + 8,
      mapId: KEY,
    });
    spawnSpecies(world, "pdw-spider", 5, 4); // 半径 1 内 1 只存活

    world.time.tick = 1;
    createNestSystem({ radiusTiles: 1 })(world);

    expect(countKind(world, "pdw-spider")).toBe(1); // 未补到 capacity=4
    const nestEid = query(world, [Transform]).find((eid) => Kind[eid] === "pdw-nest-dual")!;
    expect(Nest[nestEid]!.current).toBe(1); // 镜像仍更新
  });

  it("仅带 Nest 的巢保持既有 capacity 语义（无 Population 时不受影响）", () => {
    const world = createWorld();
    spawnEntity(world, world.archetypes.get("pdw-nest-only"), world.components_registry, {
      x: 4 * 16 + 8,
      y: 4 * 16 + 8,
      mapId: KEY,
    });

    world.time.tick = 1;
    createNestSystem({ radiusTiles: 1 })(world);

    expect(countKind(world, "pdw-spider")).toBe(2); // capacity = 2
  });

  it("死亡回写按实体归属图匹配：异图同名物种不串账", () => {
    const world = createWorld();
    const other = makeTestGeometry({ key: "pdw-other", width: 8, height: 8, regions: ["den"] });
    world.maps["pdw-other"] = other;
    world.activeMaps.add("pdw-other");

    const nodeEid = spawnNode(world, { species: "pdw-spider", count: 3 });
    const otherNode = spawnEntity(world, world.archetypes.get("pdw-node"), world.components_registry, {
      x: 32,
      y: 32,
      mapId: "pdw-other",
    });
    Object.assign(Population[otherNode]!, {
      species: "pdw-spider",
      count: 3,
      carryingDensity: 0.1,
      growthRate: 1,
      growthIntervalTicks: 10,
      homeRegion: "den",
    });

    // 在另一张图上的击杀 → 只扣该图节点；同图节点不变
    const otherSpider = spawnEntity(world, world.archetypes.get("pdw-spider"), world.components_registry, {
      x: 32,
      y: 32,
      mapId: "pdw-other",
    });
    kill(world, [otherSpider]);

    expect(Population[otherNode]!.count).toBe(2);
    expect(Population[nodeEid]!.count).toBe(3);
    expect(entityMapOf(world, nodeEid)).toBe(KEY);
  });
});
