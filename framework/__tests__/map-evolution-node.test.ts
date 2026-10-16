/**
 * 演化引擎可插拔种群模式测试（framework/__tests__/map-evolution-node.test.ts）。
 *
 * 覆盖生态切片 3B（种群模型注册表 + node 模式），全部经注入假 deps 驱动、
 * 不触真实 ECS 写路径（与 map-evolution.test.ts 同款约束）：
 * - 种群模型注册表：内置四模型模块加载即注册（不依赖 bootstrap 时序）、
 *   重复注册/未注册查询报错清晰；
 * - node 模式（真实 Population 节点 + 假 deps）：
 *   ① 节点 count 增长 → 引擎按 deficit 补差；
 *   ② 数量到 cap（节点承载力 / rule.max 封顶）停止；
 *   ③ 节点 count 回落 / 节点消失 → 不删活体、零新增（只增不删）；
 *   ④ 确定性：同 seed 同 tick 序列产出与节点终态一致；
 *   ⑤ 离线补差 ≡ 逐 tick 推进（产出与节点终态逐一一致）；
 *   ⑥ 分段推演等价（U2）对 node 模式保持；
 * - schema：node 规则判别校验、非法 mode 报错、ruleIdentity 按 mode 区分。
 */
import { afterEach, describe, expect, it } from "vitest";

import { createArchetypeRegistry } from "framework/entities/archetypeRegistry";
import { createComponentRegistry } from "framework/components/componentRegistry";
import { EntityMap } from "framework/components/entityMap";
import { spawnEntity } from "framework/entities/spawn";
import { createGameWorld, type GameWorld } from "framework/world";
import { registerSpawnCondition } from "framework/systems/gameplay/spawnConditions";
import {
  Population,
  initPopulation,
  type PopulationNodeState,
} from "framework/simulation/population/population";
import {
  fastForwardPopulations,
  populationSystem,
} from "framework/simulation/population/populationSystem";
import { setMapSeeds } from "map/runtime/mapSeeds";
import { walkableAt } from "map/geometry/query";
import type { MapGeometry, RegionMeta } from "map/geometry/types";
import { evolve, type EvolutionDeps } from "map/evolution/engine";
import { EntityRuleSchema, ruleIdentity } from "map/evolution/schema";
import type { EntityRule } from "map/evolution/schema";
import {
  getPopulationModel,
  listPopulationModels,
  registerPopulationModel,
} from "map/evolution/populationModels";

/**
 * 最小 MapGeometry（8×8，16px/tile）：单一区域 "den"（插入序 0）覆盖全图、
 * 全可走。region meta 不带 area —— regionAreaOf 回退逐格计数（64），承载
 * cap = floor(64 × carryingDensity)。每次调用产出全新实例。
 */
function makeGeometry(): MapGeometry {
  const size = 8;
  return {
    key: "nmap",
    grid: { width: size, height: size, tileWidth: 16, tileHeight: 16 },
    tiles: new Uint8Array(size * size).fill(1),
    walkable: new Uint8Array(size * size).fill(1),
    regions: new Map<string, RegionMeta>([["den", { name: "den", meta: {} }]]),
    regionOfTile: new Uint16Array(size * size), // 全 0 = den
    version: "node-test",
  };
}

/** spawn 记录（kind + 图 + tile 坐标）。 */
interface SpawnRecord {
  kind: string;
  mapKey: string;
  x: number;
  y: number;
}

/**
 * 假 deps（单格语义，与 map-evolution.test.ts 的 makeHarness 同款）：
 * spawn 记录 + 占用集 + countByKind（本套件单区域，按 map+kind 计数）。
 */
function makeHarness(seed: number, geometry: MapGeometry) {
  const spawns: SpawnRecord[] = [];
  const occupied = new Set<string>();
  const deps: EvolutionDeps = {
    seed,
    countByKind: (mapKey, _region, kind) => spawns.filter((s) => s.mapKey === mapKey && s.kind === kind).length,
    canPlace: (mapKey, _kind, x, y) => walkableAt(geometry, x, y) && !occupied.has(`${mapKey}:${x},${y}`),
    spawn: (kind, mapKey, x, y) => {
      spawns.push({ kind, mapKey, x, y });
      occupied.add(`${mapKey}:${x},${y}`);
    },
  };
  return { deps, spawns };
}

/** 构造 world：几何挂入 world.maps（advancePopulation 重算 cap 依赖）+ seed 弱表 + 原型。 */
function makeWorld(geometry: MapGeometry, seed: number): GameWorld {
  const world = createGameWorld(50);
  world.maps["nmap"] = geometry;
  setMapSeeds(world, { nmap: seed });
  world.archetypes = createArchetypeRegistry();
  world.components_registry = createComponentRegistry();
  world.archetypes.register({ kind: "node-src", components: {} });
  world.archetypes.register({ kind: "kind-s", components: {} });
  return world;
}

/** 生成一个族群节点来源实体（node-src）并手工初始化 Population 节点。 */
function spawnNest(
  world: GameWorld,
  config: { count?: number; growthRate?: number; growthIntervalTicks?: number; carryingDensity?: number; homeRegion?: string },
): number {
  const eid = spawnEntity(world, world.archetypes.get("node-src"), world.components_registry, {
    x: 8,
    y: 8,
    mapId: "nmap",
  });
  initPopulation(world, eid, {
    species: "kind-s",
    carryingDensity: config.carryingDensity ?? 0.1, // cap = floor(64 × 0.1) = 6
    growthRate: config.growthRate ?? 0,
    growthIntervalTicks: config.growthIntervalTicks ?? 10,
    homeRegion: config.homeRegion ?? "den",
    count: config.count ?? 0,
  });
  return eid;
}

/** 节点规则（node 模式；den 区 kind-s，槽 every=10）。 */
function nodeRule(max: number, extra?: Partial<Extract<EntityRule, { mode: "node" }>>): EntityRule {
  return { map: "nmap", region: "den", kind: "kind-s", max, every: 10, mode: "node", ...extra };
}

// 条件注册表为模块级单例（每测试文件独立模块环境，与 map-evolution.test.ts 同款）：
// 本套件专属前缀注册，供 condition 门控用例使用。
registerSpawnCondition("node-test-false", () => false);

/** 拷贝节点状态（测试内恢复/对比用）。 */
function cloneNode(eid: number): PopulationNodeState {
  const node = Population[eid];
  if (!node) throw new Error("fixture: node missing");
  return { ...node };
}

/** 统计记录中某 kind 的生成数。 */
function countKind(spawns: SpawnRecord[], kind: string): number {
  return spawns.filter((s) => s.kind === kind).length;
}

afterEach(() => {
  // 模块级 AoS 清理：Population / EntityMap 按 eid 残留会泄漏进后续用例
  //（populationSystem / node 模型都按 Population 数组迭代）。
  for (let eid = 0; eid < Population.length; eid++) {
    if (Population[eid]) Population[eid] = undefined;
  }
  for (let eid = 0; eid < EntityMap.length; eid++) {
    if (EntityMap[eid] === "nmap") EntityMap[eid] = undefined;
  }
});

describe("种群模型注册表", () => {
  it("内置四模型模块加载即注册（演化引擎不依赖 bootstrap 时序）", () => {
    expect(listPopulationModels()).toEqual(expect.arrayContaining(["density", "exact", "template", "node"]));
    expect(typeof getPopulationModel("node")).toBe("function");
    // 内置三模型为同一静态实现（目标恒 = rule.max，历史行为）
    expect(getPopulationModel("exact")).toBe(getPopulationModel("density"));
    expect(getPopulationModel("template")).toBe(getPopulationModel("density"));
    const geometry = makeGeometry();
    const ctx = {
      world: makeWorld(geometry, 42),
      geometry,
      rule: { map: "nmap", region: "den", kind: "kind-s", max: 5, every: 10, mode: "density" } as EntityRule,
      count: 1,
      slot: 10,
      seed: 42,
    };
    expect(getPopulationModel("density")(ctx)).toBe(5);
  });

  it("NEGATIVE：重复注册抛错；未注册查询抛错（消息含模型名）", () => {
    expect(() => registerPopulationModel("density", (ctx) => ctx.rule.max)).toThrow(/already registered/);
    expect(() => getPopulationModel("missing-model")).toThrow(/missing-model/);
  });
});

describe("演化规则 schema：node 模式", () => {
  const base = { map: "m", region: "r", kind: "k", max: 3, every: 10 };

  it("POSITIVE：node 规则通过判别校验（condition 可选）", () => {
    expect(EntityRuleSchema.safeParse({ ...base, mode: "node" }).success).toBe(true);
    expect(EntityRuleSchema.safeParse({ ...base, mode: "node", condition: "any-condition" }).success).toBe(true);
  });

  it("NEGATIVE：非法 node 配置报错清晰", () => {
    expect(EntityRuleSchema.safeParse({ ...base, mode: "node", max: -1 }).success).toBe(false); // max ≥ 0
    expect(EntityRuleSchema.safeParse({ ...base, mode: "node", every: 0 }).success).toBe(false); // every ≥ 1
    expect(EntityRuleSchema.safeParse({ ...base, mode: "growth" }).success).toBe(false); // 未知 mode
    const parsed = EntityRuleSchema.safeParse({ ...base, mode: "growth" });
    if (parsed.success) throw new Error("expected failure");
    // 报错点名合法 mode 全集（配置错误可读）
    expect(JSON.stringify(parsed.error.issues)).toContain("Expected 'density' | 'exact' | 'template' | 'node'");
  });

  it("ruleIdentity 按 mode 区分（node 与 density 不同选点流）", () => {
    const density: EntityRule = { ...base, mode: "density" };
    const node: EntityRule = { ...base, mode: "node" };
    expect(ruleIdentity(node)).not.toBe(ruleIdentity(density));
    expect(ruleIdentity(node)).toBe(ruleIdentity({ ...base, mode: "node" }));
  });
});

describe("node 模式：deficit 补差", () => {
  it("节点 count 增长 → 引擎按 deficit 补差（每槽目标 = min(节点和, max)）", () => {
    const geometry = makeGeometry();
    const world = makeWorld(geometry, 42);
    spawnNest(world, { count: 2, growthRate: 1, growthIntervalTicks: 10 });
    const rule = nodeRule(6);
    const { deps, spawns } = makeHarness(42, geometry);

    // 槽 10：节点推进到 10（count 2→3）→ 目标 3 → 补 3；
    // 槽 20/30/40：count 4/5/6 → 各补 1。合计 6。
    evolve(world, geometry, [rule], 0, 40, deps);
    expect(countKind(spawns, "kind-s")).toBe(6);

    // 节点已达承载 cap=6、实体亦 6：继续推进不再产出（cap 停止）
    evolve(world, geometry, [rule], 40, 200, deps);
    expect(countKind(spawns, "kind-s")).toBe(6);
  });

  it("rule.max 硬封顶：节点记账高于 max 时实体数停在 max", () => {
    const geometry = makeGeometry();
    const world = makeWorld(geometry, 42);
    spawnNest(world, { count: 3, growthRate: 1, growthIntervalTicks: 10 });
    const rule = nodeRule(4);
    const { deps, spawns } = makeHarness(42, geometry);

    // 槽 10：节点 3→4 → 目标 min(4, 4) = 4 → 补 4；槽 20 起 count ≥ max 早退
    evolve(world, geometry, [rule], 0, 200, deps);
    expect(countKind(spawns, "kind-s")).toBe(4);
  });

  it("无匹配节点（图/区域/物种不符）→ 目标 0、零产出不抛错", () => {
    const geometry = makeGeometry();
    const world = makeWorld(geometry, 42);
    // 区域不符（homeRegion=other）与完全无节点两种情况
    spawnNest(world, { count: 5, homeRegion: "other" });
    const { deps, spawns } = makeHarness(42, geometry);

    evolve(world, geometry, [nodeRule(6)], 0, 40, deps);
    expect(spawns).toEqual([]);
  });

  it("condition=false：整条 node 规则零产出", () => {
    const geometry = makeGeometry();
    const world = makeWorld(geometry, 42);
    spawnNest(world, { count: 4 });
    const { deps, spawns } = makeHarness(42, geometry);

    evolve(world, geometry, [nodeRule(6, { condition: "node-test-false" })], 0, 40, deps);
    expect(spawns).toEqual([]);
  });
});

describe("node 模式：只增不删", () => {
  it("节点 count 回落（被打掉）→ 不删活体、零新增", () => {
    const geometry = makeGeometry();
    const world = makeWorld(geometry, 42);
    const eid = spawnNest(world, { count: 2, growthRate: 0 });
    const rule = nodeRule(6);
    const { deps, spawns } = makeHarness(42, geometry);

    evolve(world, geometry, [rule], 0, 10, deps);
    expect(countKind(spawns, "kind-s")).toBe(2);

    // 节点记账下降（模拟种群被清/窝被捣毁的记账回落）：目标回落 ≤ 存活数
    Population[eid]!.count = 0;
    evolve(world, geometry, [rule], 10, 40, deps);
    expect(countKind(spawns, "kind-s")).toBe(2); // 无删除、无新增（deficit ≤ 0 空转）

    // 节点整体消失（来源实体销毁 → AoS 条目清理）：同样零变化
    Population[eid] = undefined;
    evolve(world, geometry, [rule], 40, 80, deps);
    expect(countKind(spawns, "kind-s")).toBe(2);
  });
});

describe("node 模式：确定性与离线等价", () => {
  it("确定性：同 seed 同 tick 序列产出与节点终态一致（跨引擎调用）", () => {
    const geometry = makeGeometry();
    const world = makeWorld(geometry, 42);
    const eid = spawnNest(world, { count: 1, growthRate: 1, growthIntervalTicks: 10 });
    const rule = nodeRule(6);

    const snapshot = cloneNode(eid);
    const a = makeHarness(42, geometry);
    evolve(world, geometry, [rule], 0, 60, a.deps);
    const nodeAfterA = cloneNode(eid);

    // 恢复节点初始状态后重放（引擎会推进节点——推进本身也须可复现）
    Population[eid] = { ...snapshot };
    const b = makeHarness(42, geometry);
    evolve(world, geometry, [rule], 0, 60, b.deps);

    expect(b.spawns).toEqual(a.spawns);
    expect(a.spawns.length).toBeGreaterThan(0);
    expect(cloneNode(eid)).toEqual(nodeAfterA);
  });

  it("分段推演 ≡ 一次推演（U2 对 node 模式保持，节点状态跨段延续）", () => {
    const geometry = makeGeometry();
    const world = makeWorld(geometry, 42);
    const eid = spawnNest(world, { count: 1, growthRate: 1, growthIntervalTicks: 10 });
    const rule = nodeRule(6);

    const snapshot = cloneNode(eid);
    const one = makeHarness(42, geometry);
    evolve(world, geometry, [rule], 0, 60, one.deps);
    const nodeOne = cloneNode(eid);

    Population[eid] = { ...snapshot };
    const segmented = makeHarness(42, geometry);
    evolve(world, geometry, [rule], 0, 25, segmented.deps);
    evolve(world, geometry, [rule], 25, 50, segmented.deps);
    evolve(world, geometry, [rule], 50, 60, segmented.deps);

    expect(segmented.spawns).toEqual(one.spawns);
    expect(cloneNode(eid)).toEqual(nodeOne);
  });

  it("离线补差 ≡ 逐 tick 推进（产出与节点终态逐一一致）", () => {
    const geometry = makeGeometry();
    const world = makeWorld(geometry, 42);
    const eid = spawnNest(world, { count: 1, growthRate: 1, growthIntervalTicks: 10 });
    const rule = nodeRule(6);

    // 路径 A：逐 tick（每 tick 引擎 (t-1,t] + populationSystem 推进节点到 t）
    const snapshot = cloneNode(eid);
    const perTick = makeHarness(42, geometry);
    for (let t = 1; t <= 60; t++) {
      world.time.tick = t;
      evolve(world, geometry, [rule], t - 1, t, perTick.deps);
      populationSystem(world);
    }
    const nodePerTick = cloneNode(eid);
    expect(perTick.spawns.length).toBeGreaterThan(0);

    // 路径 B：离线补差（单次 evolve + fastForwardPopulations 收尾）
    Population[eid] = { ...snapshot };
    const offline = makeHarness(42, geometry);
    evolve(world, geometry, [rule], 0, 60, offline.deps);
    fastForwardPopulations(world, 60);

    expect(offline.spawns).toEqual(perTick.spawns);
    expect(cloneNode(eid)).toEqual(nodePerTick);
  });
});
