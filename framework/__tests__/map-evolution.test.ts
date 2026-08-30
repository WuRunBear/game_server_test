/**
 * 演化层测试（framework/__tests__/map-evolution.test.ts）。
 *
 * 覆盖计划 todo 7 验收（全部经注入假 deps 驱动，不触真实 ECS 写路径）：
 * - U2 补差等价：0→N 一次推演 ≡ 分段推演（种类/数量/位置一致）；
 * - U3 上限封顶：超长 toTick 每规则实体数 ≤ max；
 * - U4 选点纯函数：同 (seed, mapKey, ruleId, timeSlot) 跨实例同候选序列，
 *   占用只过滤不改序列；
 * - U7 模板成组：全部合法才原子创建，任一非法整组放弃（零半成品）；
 * - condition 门控（false 零产出、每 evolve 调用只求值一次）；
 * - max=0 / every 大于跨度 / 区域无格 → 零产出；
 * - 早退不变式：count ≥ max 后同一次 evolve 内不再 spawn；
 * - 缺省 spawn 通道：经 spawnEntity 生成并写 EntityMap/Transform/Kind。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { createArchetypeRegistry } from "framework/entities/archetypeRegistry";
import { createComponentRegistry } from "framework/components/componentRegistry";
import { EntityMap } from "framework/components/entityMap";
import { Kind } from "framework/components/kind";
import { Transform } from "framework/components/transform";
import { registerSpawnCondition } from "framework/systems/gameplay/spawnConditions";
import { createGameWorld, type GameWorld } from "framework/world";
import { walkableAt } from "map/geometry/query";
import type { MapGeometry, RegionMeta } from "map/geometry/types";
import { evolve, type EvolutionDeps } from "map/evolution/engine";
import {
  derivePlacementSeed,
  pickPoint,
  placementCandidates,
  PLACEMENT_MAX_ATTEMPTS,
} from "map/evolution/placement";
import { EntityRuleSchema, ruleIdentity } from "map/evolution/schema";
import type { EntityRule } from "map/evolution/schema";

// 演化引擎用模块级 logger（scope "map-evolution"）——按 todo 8 先例用 vi.mock
// 拦截 createLogger，把 warn 调用记入数组供断言（mock 同时覆盖 world.ts 导入方）。
const loggerCalls = vi.hoisted(() => [] as Array<{ message: string; extra?: Record<string, unknown> }>);
vi.mock("framework/utils/logger", () => ({
  createLogger: () => ({
    info: () => {},
    warn: (message: string, extra?: Record<string, unknown>) => {
      loggerCalls.push({ message, extra });
    },
    error: () => {},
  }),
}));

// 条件注册表为模块级单例：用本套件专属前缀注册，spy 条件带调用计数。
let conditionSpyCalls = 0;
registerSpawnCondition("evo-test-true", () => true);
registerSpawnCondition("evo-test-false", () => false);
registerSpawnCondition("evo-test-spy", () => {
  conditionSpyCalls += 1;
  return true;
});

/**
 * 构造最小 MapGeometry 字面量（6×6，16px/tile）：
 * - regions 插入序：0="plain"、1="cove"（右下 2×2：(4,4)(5,4)(4,5)(5,5)）；
 * - walkable 全 1，仅 (1,1) 与 (5,4) 不可走；
 * - 每次调用产出全新实例（测试间互不共享可变引用）。
 */
function makeGeometry(): MapGeometry {
  const walkable = new Uint8Array(36).fill(1);
  walkable[7] = 0; // (1,1)
  walkable[29] = 0; // (5,4)
  const regionOfTile = new Uint16Array(36);
  for (const index of [28, 29, 34, 35]) regionOfTile[index] = 1; // cove

  return {
    key: "evo-map",
    grid: { width: 6, height: 6, tileWidth: 16, tileHeight: 16 },
    tiles: new Uint8Array(36).fill(1),
    walkable,
    regions: new Map<string, RegionMeta>([
      ["plain", { name: "plain", meta: {} }],
      ["cove", { name: "cove", meta: {} }],
    ]),
    regionOfTile,
    version: "evotest",
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
 * 假 deps：spawn 记录器 + 占用集（spawn 即占位，模拟真实实现读活 ECS——
 * 同槽多次补足与跨规则占用互斥都依赖它）+ countByKind 调用计数。
 * countByKind 按 map+kind 计数（本套件每 kind 只用于一条规则，无需分区域）。
 */
function makeHarness(seed: number) {
  const spawns: SpawnRecord[] = [];
  const occupied = new Set<string>();
  const state = { countByKindCalls: 0 };
  const deps: EvolutionDeps = {
    seed,
    countByKind: (mapKey, _region, kind) => {
      state.countByKindCalls += 1;
      return spawns.filter((s) => s.mapKey === mapKey && s.kind === kind).length;
    },
    isOccupied: (mapKey, x, y) => occupied.has(`${mapKey}:${x},${y}`),
    spawn: (kind, mapKey, x, y) => {
      spawns.push({ kind, mapKey, x, y });
      occupied.add(`${mapKey}:${x},${y}`);
    },
  };
  return { deps, spawns, occupied, state };
}

/** 每次调用新建真实 GameWorld（仅作条件求值/日志载体，不触 ECS 写路径）。 */
function makeWorld(): GameWorld {
  return createGameWorld(50);
}

/** 统计记录中某 kind 的生成数。 */
function countKind(spawns: SpawnRecord[], kind: string): number {
  return spawns.filter((s) => s.kind === kind).length;
}

describe("演化规则 schema", () => {
  it("POSITIVE：EntityRuleSchema 按 mode 判别校验", () => {
    const base = { map: "m", region: "r", kind: "k", max: 1, every: 10 };
    expect(EntityRuleSchema.safeParse({ ...base, mode: "density" }).success).toBe(true);
    expect(EntityRuleSchema.safeParse({ ...base, mode: "exact", at: { x: 1, y: 2 } }).success).toBe(true);
    expect(EntityRuleSchema.safeParse({ ...base, mode: "template", template: [{ kind: "k", dx: 0, dy: 0 }] }).success).toBe(true);

    expect(EntityRuleSchema.safeParse({ ...base, mode: "exact" }).success).toBe(false); // 缺 at
    expect(EntityRuleSchema.safeParse({ ...base, mode: "template", template: [] }).success).toBe(false); // 空模板
    expect(EntityRuleSchema.safeParse({ ...base, mode: "other" }).success).toBe(false); // 未知 mode
    expect(EntityRuleSchema.safeParse({ ...base, mode: "density", every: 0 }).success).toBe(false); // every ≥ 1
    expect(EntityRuleSchema.safeParse({ ...base, mode: "density", max: -1 }).success).toBe(false); // max ≥ 0
  });

  it("POSITIVE：ruleIdentity 同规则恒同键，内容变化即变", () => {
    const rule: EntityRule = { map: "m", region: "r", kind: "k", max: 1, every: 1, mode: "density" };
    expect(ruleIdentity({ ...rule })).toBe(ruleIdentity(rule));
    expect(ruleIdentity({ ...rule, kind: "k2" })).not.toBe(ruleIdentity(rule));
    expect(ruleIdentity({ ...rule, mode: "exact", at: { x: 0, y: 0 } })).not.toBe(ruleIdentity(rule));
  });
});

describe("确定性选点 placement", () => {
  it("U4：同 (seed,mapKey,ruleId,timeSlot) 跨实例候选序列一致；占用只过滤不改序列", () => {
    const g1 = makeGeometry();
    const g2 = makeGeometry();
    expect(derivePlacementSeed(42, "evo-map", "rule-1", 40)).toBe(derivePlacementSeed(42, "evo-map", "rule-1", 40));

    const seq = placementCandidates(g1, "plain", "rule-1", 40, 42);
    expect(placementCandidates(g2, "plain", "rule-1", 40, 42)).toEqual(seq);
    expect(seq).toHaveLength(PLACEMENT_MAX_ATTEMPTS);

    // 异 timeSlot / 异 seed / 异 ruleId → 异序列
    expect(placementCandidates(g1, "plain", "rule-1", 60, 42)).not.toEqual(seq);
    expect(placementCandidates(g1, "plain", "rule-1", 40, 43)).not.toEqual(seq);
    expect(placementCandidates(g1, "plain", "rule-2", 40, 42)).not.toEqual(seq);

    // pickPoint = 候选序列中第一个合法点（可走且未占用）
    const firstLegal = seq.find((p) => walkableAt(g1, p.x, p.y));
    if (!firstLegal) throw new Error("fixture: plain 区应存在可走候选");
    expect(pickPoint(g1, "plain", "rule-1", 40, 42, () => false)).toEqual(firstLegal);

    // 占用第一个可走候选 → 落点后移到下一合法候选；候选序列本身不变
    const blocked = new Set([`${firstLegal.x},${firstLegal.y}`]);
    const nextLegal = seq.find((p) => walkableAt(g1, p.x, p.y) && !blocked.has(`${p.x},${p.y}`));
    if (!nextLegal) throw new Error("fixture: 应存在第二个可走候选");
    expect(pickPoint(g1, "plain", "rule-1", 40, 42, (x, y) => blocked.has(`${x},${y}`))).toEqual(nextLegal);
  });

  it("U4：同 seed 两次 evolve 产出完全一致（跨引擎实例）", () => {
    const geometry = makeGeometry();
    const rules: EntityRule[] = [
      { map: "evo-map", region: "plain", kind: "kind-a", max: 3, every: 20, mode: "density" },
    ];

    const h1 = makeHarness(42);
    evolve(makeWorld(), geometry, rules, 0, 100, h1.deps);
    const h2 = makeHarness(42);
    evolve(makeWorld(), geometry, rules, 0, 100, h2.deps);

    expect(h1.spawns.length).toBeGreaterThan(0);
    expect(h2.spawns).toEqual(h1.spawns);
  });

  it("NEGATIVE：区域无格（未注册区域）→ 空候选序列、pickPoint 放弃", () => {
    const geometry = makeGeometry();
    expect(placementCandidates(geometry, "missing", "rule-1", 40, 42)).toEqual([]);
    expect(pickPoint(geometry, "missing", "rule-1", 40, 42, () => false)).toBeUndefined();
  });
});

describe("补差引擎 evolve", () => {
  beforeEach(() => {
    loggerCalls.length = 0;
    conditionSpyCalls = 0;
  });

  it("U2：0→N 一次推演 ≡ 分段推演（种类/数量/位置一致）", () => {
    const geometry = makeGeometry();
    // 混合 every（5/20/30）+ 三种 mode + condition：槽在分段边界两侧交错
    const rules: EntityRule[] = [
      { map: "evo-map", region: "plain", kind: "kind-c", max: 1, every: 5, mode: "exact", at: { x: 2, y: 1 } },
      { map: "evo-map", region: "plain", kind: "kind-a", max: 3, every: 20, mode: "density" },
      { map: "evo-map", region: "plain", kind: "kind-b", max: 2, every: 30, mode: "density", condition: "evo-test-true" },
      {
        map: "evo-map",
        region: "plain",
        kind: "kind-d",
        max: 2,
        every: 20,
        mode: "template",
        template: [
          { kind: "kind-d", dx: 0, dy: 0 },
          { kind: "kind-e", dx: 1, dy: 0 },
          { kind: "kind-f", dx: 0, dy: 1 },
        ],
      },
    ];

    const one = makeHarness(42);
    evolve(makeWorld(), geometry, rules, 0, 100, one.deps);

    const segmented = makeHarness(42);
    evolve(makeWorld(), geometry, rules, 0, 25, segmented.deps);
    evolve(makeWorld(), geometry, rules, 25, 50, segmented.deps);
    evolve(makeWorld(), geometry, rules, 50, 75, segmented.deps);
    evolve(makeWorld(), geometry, rules, 75, 100, segmented.deps);

    // 产出非空且各 kind 数量符合规则上限（防"双方皆空"的空洞等价）
    expect(one.spawns.length).toBe(12);
    expect(countKind(one.spawns, "kind-c")).toBe(1);
    expect(countKind(one.spawns, "kind-a")).toBe(3);
    expect(countKind(one.spawns, "kind-b")).toBe(2);
    expect(countKind(one.spawns, "kind-d")).toBe(2);
    expect(countKind(one.spawns, "kind-e")).toBe(2);
    expect(countKind(one.spawns, "kind-f")).toBe(2);

    expect(segmented.spawns).toEqual(one.spawns);
  });

  it("U3：超长 toTick 每规则实体数不超过 max", () => {
    const geometry = makeGeometry();
    const rules: EntityRule[] = [
      { map: "evo-map", region: "plain", kind: "kind-a", max: 3, every: 10, mode: "density" },
      {
        map: "evo-map",
        region: "plain",
        kind: "kind-d",
        max: 2,
        every: 10,
        mode: "template",
        template: [
          { kind: "kind-d", dx: 0, dy: 0 },
          { kind: "kind-e", dx: 1, dy: 0 },
          { kind: "kind-f", dx: 0, dy: 1 },
        ],
      },
    ];

    const { deps, spawns } = makeHarness(42);
    evolve(makeWorld(), geometry, rules, 0, 20000, deps);

    expect(countKind(spawns, "kind-a")).toBe(3);
    expect(countKind(spawns, "kind-d")).toBe(2);
    expect(countKind(spawns, "kind-e")).toBe(2);
    expect(countKind(spawns, "kind-f")).toBe(2);
  });

  it("U7：模板组全部合法 → 成组原子创建", () => {
    const geometry = makeGeometry();
    const { deps, spawns } = makeHarness(7);
    const rule: EntityRule = {
      map: "evo-map",
      region: "plain",
      kind: "kind-d",
      max: 1,
      every: 10,
      mode: "template",
      template: [
        { kind: "kind-d", dx: 0, dy: 0 },
        { kind: "kind-e", dx: 1, dy: 0 },
        { kind: "kind-f", dx: 0, dy: 1 },
      ],
    };

    evolve(makeWorld(), geometry, [rule], 0, 10, deps);

    expect(spawns).toHaveLength(3);
    const anchor = spawns.find((s) => s.kind === "kind-d");
    if (!anchor) throw new Error("expected anchor spawn");
    expect(spawns).toContainEqual({ kind: "kind-e", mapKey: "evo-map", x: anchor.x + 1, y: anchor.y });
    expect(spawns).toContainEqual({ kind: "kind-f", mapKey: "evo-map", x: anchor.x, y: anchor.y + 1 });
  });

  it("U7：组内任一落点非法 → 整组放弃（零半成品）", () => {
    // cove 4 格中 (5,4) 不可走：2×2 模板从 cove 任意原点出发必含非法/越界落点
    const geometry = makeGeometry();
    const { deps, spawns } = makeHarness(7);
    const rule: EntityRule = {
      map: "evo-map",
      region: "cove",
      kind: "kind-d",
      max: 1,
      every: 10,
      mode: "template",
      template: [
        { kind: "kind-d", dx: 0, dy: 0 },
        { kind: "kind-e", dx: 1, dy: 0 },
        { kind: "kind-f", dx: 0, dy: 1 },
        { kind: "kind-g", dx: 1, dy: 1 },
      ],
    };

    evolve(makeWorld(), geometry, [rule], 0, 10, deps);

    expect(spawns).toEqual([]);
  });

  it("condition=false：整条规则零产出", () => {
    const geometry = makeGeometry();
    const { deps, spawns } = makeHarness(42);
    const rule: EntityRule = {
      map: "evo-map",
      region: "plain",
      kind: "kind-a",
      max: 3,
      every: 10,
      mode: "density",
      condition: "evo-test-false",
    };

    evolve(makeWorld(), geometry, [rule], 0, 100, deps);

    expect(spawns).toEqual([]);
  });

  it("condition 每 evolve 调用只求值一次（多 timeSlot 亦然）", () => {
    const geometry = makeGeometry();
    const { deps, spawns } = makeHarness(42);
    const rule: EntityRule = {
      map: "evo-map",
      region: "plain",
      kind: "kind-a",
      max: 1,
      every: 10,
      mode: "density",
      condition: "evo-test-spy",
    };

    evolve(makeWorld(), geometry, [rule], 0, 100, deps);

    expect(conditionSpyCalls).toBe(1);
    expect(spawns).toHaveLength(1);
  });

  it("max=0：零产出", () => {
    const geometry = makeGeometry();
    const { deps, spawns } = makeHarness(42);
    const rule: EntityRule = { map: "evo-map", region: "plain", kind: "kind-a", max: 0, every: 10, mode: "density" };

    evolve(makeWorld(), geometry, [rule], 0, 100, deps);

    expect(spawns).toEqual([]);
  });

  it("every 大于跨度：零产出", () => {
    const geometry = makeGeometry();
    const { deps, spawns } = makeHarness(42);
    const rule: EntityRule = { map: "evo-map", region: "plain", kind: "kind-a", max: 3, every: 100, mode: "density" };

    evolve(makeWorld(), geometry, [rule], 0, 50, deps);

    expect(spawns).toEqual([]);
  });

  it("region 无格（未注册区域）：零产出不抛错", () => {
    const geometry = makeGeometry();
    const { deps, spawns } = makeHarness(42);
    const rule: EntityRule = { map: "evo-map", region: "missing", kind: "kind-a", max: 3, every: 10, mode: "density" };

    evolve(makeWorld(), geometry, [rule], 0, 100, deps);

    expect(spawns).toEqual([]);
  });

  it("早退：count≥max 后同一次 evolve 内不再 spawn（长跨度成本有界）", () => {
    const geometry = makeGeometry();
    const { deps, spawns, state } = makeHarness(42);
    const rule: EntityRule = { map: "evo-map", region: "plain", kind: "kind-a", max: 2, every: 10, mode: "density" };

    evolve(makeWorld(), geometry, [rule], 0, 10000, deps);

    expect(spawns).toHaveLength(2);
    // 本地跟踪 + 早退：每规则只在首个槽查询一次计数，剩余槽全部跳过
    expect(state.countByKindCalls).toBe(1);
  });

  it("rule.map 不匹配当前图：忽略（不查询不生成）", () => {
    const geometry = makeGeometry();
    const { deps, spawns, state } = makeHarness(42);
    const rule: EntityRule = { map: "other-map", region: "plain", kind: "kind-a", max: 3, every: 10, mode: "density" };

    evolve(makeWorld(), geometry, [rule], 0, 100, deps);

    expect(spawns).toEqual([]);
    expect(state.countByKindCalls).toBe(0);
  });

  it("exact 落点不可走：跳过并 warn，零产出", () => {
    const geometry = makeGeometry();
    const { deps, spawns } = makeHarness(42);
    const rule: EntityRule = {
      map: "evo-map",
      region: "plain",
      kind: "kind-c",
      max: 1,
      every: 10,
      mode: "exact",
      at: { x: 1, y: 1 }, // fixture 中 (1,1) 不可走
    };

    evolve(makeWorld(), geometry, [rule], 0, 20, deps);

    expect(spawns).toEqual([]);
    expect(loggerCalls.some((c) => c.message.includes("exact landing illegal"))).toBe(true);
  });

  it("exact 落点被占用：跳过并 warn，零产出", () => {
    const geometry = makeGeometry();
    const { deps, spawns, occupied } = makeHarness(42);
    occupied.add("evo-map:0,0");
    const rule: EntityRule = {
      map: "evo-map",
      region: "plain",
      kind: "kind-c",
      max: 1,
      every: 10,
      mode: "exact",
      at: { x: 0, y: 0 },
    };

    evolve(makeWorld(), geometry, [rule], 0, 10, deps);

    expect(spawns).toEqual([]);
    expect(loggerCalls.some((c) => c.message.includes("exact landing illegal"))).toBe(true);
  });

  it("toTick ≤ fromTick：空转（离线折算为 0 的读档场景）", () => {
    const geometry = makeGeometry();
    const { deps, spawns } = makeHarness(42);
    const rule: EntityRule = { map: "evo-map", region: "plain", kind: "kind-a", max: 3, every: 10, mode: "density" };

    evolve(makeWorld(), geometry, [rule], 50, 50, deps);
    evolve(makeWorld(), geometry, [rule], 60, 50, deps);

    expect(spawns).toEqual([]);
  });
});

describe("缺省 spawn 通道", () => {
  beforeEach(() => {
    loggerCalls.length = 0;
  });

  it("deps.spawn 缺省时经 spawnEntity 生成，并写 EntityMap/Transform/Kind", () => {
    const world = createGameWorld(50);
    world.archetypes = createArchetypeRegistry();
    world.components_registry = createComponentRegistry();
    world.archetypes.register({ kind: "kind-a", components: {} });

    const geometry = makeGeometry();
    const rule: EntityRule = { map: "evo-map", region: "plain", kind: "kind-a", max: 2, every: 10, mode: "density" };
    // 不注入 spawn → 走缺省通道（spawnEntity 链，EntityMap[eid]=mapKey 由其内部写入）
    evolve(world, geometry, [rule], 0, 10, {
      seed: 7,
      countByKind: () => 0,
      isOccupied: () => false,
    });

    const eids: number[] = [];
    EntityMap.forEach((mapId, eid) => {
      if (mapId === "evo-map") eids.push(eid);
    });
    expect(eids).toHaveLength(2);
    for (const eid of eids) {
      expect(EntityMap[eid]).toBe("evo-map");
      expect(Kind[eid]).toBe("kind-a");
      expect(walkableAt(geometry, Transform.x[eid], Transform.y[eid])).toBe(true);
    }
  });
});
