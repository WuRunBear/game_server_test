/**
 * 运行时边界收尾测试：离线燃料快进 / 延时制作任务入档 / 成长与成就同步。
 *
 * 覆盖（对应任务 A-D）：
 * A. 燃料闭式快进：离线跨越耗尽 → 归零且站点失效；未耗尽精确扣减；
 *    无 fuel 配置零影响；与在线逐 tick 消耗同语义。
 * B. craftingJobs 存档：发起 40 tick 制作 → 存档 → 恢复后继续（材料已在任务里，
 *    重启不丢料）→ 到点产出；离线跨越完成点直接在补差阶段产出；取消退料可用。
 * C. Progression AoS 同步：快照含 totalXp/level/skills 展平键；未注册适配器的
 *    组件行为不变（静默跳过）；序列化往返保真。
 * D. Achievements AoS 同步：解锁键进快照；初始化钩子从 world.progress 播种。
 *
 * 确定性：离线补差用 fake Date 拨墙钟（生产代码只在装配处读一次）。AoS 数组是
 * 模块级跨 world 共享的 eid 槽——每个用例前清空，防跨用例串扰。
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { query } from "bitecs";
import {
  bootstrapFramework,
  createGameSimulation,
  createDefaultGameDefinition,
  spawnEntity,
  serializeWorld,
  getRegistries,
} from "framework/index";
import { NetworkId } from "framework/components/network";
import { Kind } from "framework/components/kind";
import { Inventory } from "framework/components/inventory";
import { Progression, type ProgressionState } from "framework/components/progression";
import {
  Achievements,
  initAchievements,
  markAchievementUnlocked,
} from "framework/components/achievements";
import { EntityMap } from "framework/components/entityMap";
import { LightSource } from "framework/components/lightSource";
import { Player } from "framework/components/tags";
import { craftRecipe, craftingProgressOf } from "framework/systems/gameplay/craftingSystem";
import { getAosSyncAdapter } from "framework/simulation/aosSyncAdapters";
import type { LoadedGameDefinition } from "framework/config/schema/GameDefinitionSchema";
import type { WorldRecord } from "framework/repository";
import type { GameWorld } from "framework/world";
import type { SimulationPort } from "simulation";
import { memoryRepository } from "./helpers/persistence";

beforeAll(() => {
  bootstrapFramework();
});

const DT_MS = 50; // tickRate=20

function simWorld(sim: SimulationPort): GameWorld {
  return (sim as unknown as { world: GameWorld }).world;
}

/** 清空涉及的 AoS 模块级单例（跨 world 共享 eid 槽）。 */
function resetAos(): void {
  for (let i = 0; i < Inventory.length; i++) Inventory[i] = undefined;
  for (let i = 0; i < Progression.length; i++) Progression[i] = undefined;
  for (let i = 0; i < Achievements.length; i++) Achievements[i] = undefined;
  for (let i = 0; i < EntityMap.length; i++) EntityMap[i] = undefined;
}

beforeEach(resetAos);
afterEach(() => vi.useRealTimers());

/** 玩家 eid（单玩家场景取第一个 Player）。 */
function playerEidOf(world: GameWorld): number {
  const [eid] = query(world, [Player]);
  return eid!;
}

function inventoryCount(world: GameWorld, eid: number, kind: string): number {
  const inv = Inventory[eid];
  if (!inv) return 0;
  return inv.slots.reduce((n, s) => (s && s.kind === kind ? n + s.count : n), 0);
}

/** 以存档时刻为基准拨墙钟，注入离线跨度读档（墙钟只在装配处读一次）。 */
async function loadWithOfflineTicks(
  def: LoadedGameDefinition,
  record: WorldRecord,
  offlineTicks: number,
): Promise<SimulationPort> {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(record.savedAt + offlineTicks * DT_MS);
  const sim = await createGameSimulation(def, {
    repository: memoryRepository(record),
    saveId: "runtime-boundaries",
  });
  vi.useRealTimers();
  return sim;
}

/** 制作/燃料共用物品表。 */
const ITEMS = [
  { kind: "m", maxStack: 50 },
  { kind: "out", maxStack: 50 },
  { kind: "raw", maxStack: 20 },
  { kind: "cooked", maxStack: 20 },
  { kind: "wood", maxStack: 20 },
];

/** 带燃料段的合成定义（站点点火/熄火用例）。 */
function fuelDef(): LoadedGameDefinition {
  const def = createDefaultGameDefinition();
  def.resolvedItems = ITEMS;
  def.resolvedRules["crafting"] = {
    stationRange: 64,
    fuel: { burnMsPerTick: 100, items: { wood: 1000 } },
    recipes: [
      { id: "cook", stationType: 1, inputs: [{ kind: "raw", count: 1 }], outputs: [{ kind: "cooked", count: 1 }] },
    ],
  };
  def.resolvedEntities = [
    {
      kind: "lamp",
      components: {
        LightSource: { radius: 80, fuelRemainingMs: 0 },
        CraftingStation: { stationType: 1 },
      },
    },
  ];
  return def;
}

function spawnLamp(world: GameWorld, fuelMs: number): number {
  const eid = spawnEntity(world, world.archetypes.get("lamp"), getRegistries().componentRegistry, {
    x: 10,
    y: 0,
  });
  LightSource.fuelRemainingMs[eid] = fuelMs;
  return eid;
}

function findEidByKind(world: GameWorld, kind: string): number {
  const [eid] = [...query(world, [NetworkId])].filter((e) => Kind[e] === kind);
  return eid!;
}

/* ------------------------------------------------------------------ */
/* A. 离线燃料快进                                                       */
/* ------------------------------------------------------------------ */

describe("A. 离线燃料快进", () => {
  it("离线跨 2000 tick：燃料归零、站点失效（合成被拒）", async () => {
    const def = fuelDef();
    const sim1 = await createGameSimulation(def);
    const world1 = simWorld(sim1);
    sim1.addPlayer("s1");
    const player = playerEidOf(world1);
    Inventory[player] = { capacity: 4, slots: [{ kind: "raw", count: 5 }, null, null, null] };
    spawnLamp(world1, 1000);

    const record = serializeWorld(world1, "fuel");
    const sim2 = await loadWithOfflineTicks(def, record, 2000);
    const world2 = simWorld(sim2);
    sim2.addPlayer("s2");

    const lamp = findEidByKind(world2, "lamp");
    expect(LightSource.fuelRemainingMs[lamp]).toBe(0);
    // 站点熄火 → 合成拒绝（零副作用：raw 未消耗）
    expect(craftRecipe(world2, playerEidOf(world2), "cook")).toBe(false);
    expect(inventoryCount(world2, playerEidOf(world2), "raw")).toBe(5);
  });

  it("未耗尽时精确扣减（100ms/tick × 10 tick）且站点仍可用", async () => {
    const def = fuelDef();
    const sim1 = await createGameSimulation(def);
    const world1 = simWorld(sim1);
    sim1.addPlayer("s1");
    const player = playerEidOf(world1);
    Inventory[player] = { capacity: 4, slots: [{ kind: "raw", count: 3 }, null, null, null] };
    spawnLamp(world1, 5000);

    const record = serializeWorld(world1, "fuel");
    const sim2 = await loadWithOfflineTicks(def, record, 10);
    const world2 = simWorld(sim2);
    sim2.addPlayer("s2");

    const lamp = findEidByKind(world2, "lamp");
    expect(LightSource.fuelRemainingMs[lamp]).toBe(4000);
    expect(world2.time.tick).toBe(record.tick + 10);
    expect(craftRecipe(world2, playerEidOf(world2), "cook")).toBe(true);
    expect(inventoryCount(world2, playerEidOf(world2), "cooked")).toBe(1);
  });

  it("未配置 fuel 段：离线零影响（燃料不变）", async () => {
    const def = createDefaultGameDefinition();
    def.resolvedItems = ITEMS;
    def.resolvedRules["crafting"] = {
      recipes: [{ id: "cook", stationType: 1, inputs: [{ kind: "raw", count: 1 }], outputs: [{ kind: "cooked", count: 1 }] }],
    };
    def.resolvedEntities = [
      { kind: "lamp", components: { LightSource: { radius: 80, fuelRemainingMs: 0 }, CraftingStation: { stationType: 1 } } },
    ];
    const sim1 = await createGameSimulation(def);
    const world1 = simWorld(sim1);
    sim1.addPlayer("s1");
    spawnLamp(world1, 1000);

    const record = serializeWorld(world1, "nofuel");
    const sim2 = await loadWithOfflineTicks(def, record, 100);
    const lamp = findEidByKind(simWorld(sim2), "lamp");
    expect(LightSource.fuelRemainingMs[lamp]).toBe(1000);
  });
});

/* ------------------------------------------------------------------ */
/* B. 延时制作任务入档                                                   */
/* ------------------------------------------------------------------ */

function slowDef(): LoadedGameDefinition {
  const def = createDefaultGameDefinition();
  def.resolvedItems = ITEMS;
  def.resolvedRules["crafting"] = {
    recipes: [
      { id: "slow", durationTicks: 40, inputs: [{ kind: "m", count: 2 }], outputs: [{ kind: "out", count: 1 }] },
    ],
  };
  return def;
}

/** 开机 + 发起一次 40 tick 制作，返回存档与合成者 networkId。 */
async function startSlowCraft(): Promise<{
  def: LoadedGameDefinition;
  record: WorldRecord;
  ownerNetworkId: number;
}> {
  const def = slowDef();
  const sim = await createGameSimulation(def);
  const world = simWorld(sim);
  const { networkId } = sim.addPlayer("s1");
  const player = playerEidOf(world);
  Inventory[player] = { capacity: 4, slots: [{ kind: "m", count: 5 }, null, null, null] };
  expect(sim.submitCommand("s1", { type: "craft", recipe: "slow" })).toBe(true);
  // 材料即扣（2/5 进入任务），任务表有记录
  expect(inventoryCount(world, player, "m")).toBe(3);
  expect(craftingProgressOf(world, player).length).toBe(1);
  return { def, record: serializeWorld(world, "craft"), ownerNetworkId: networkId };
}

describe("B. 延时制作任务入档", () => {
  it("存档含任务结构（NetworkId/recipeId/绝对 finishTick）；恢复后未完成不丢料、继续到点产出", async () => {
    const { def, record, ownerNetworkId } = await startSlowCraft();

    expect(record.craftingJobs).toHaveLength(1);
    const job = record.craftingJobs![0]!;
    expect(job).toEqual({
      ownerNetworkId,
      recipeId: "slow",
      finishTick: record.tick + 40,
      durationTicks: 40,
    });

    // 零离线读档：任务恢复，已扣材料不回吐、产出未生成
    const sim2 = await loadWithOfflineTicks(def, record, 0);
    const world2 = simWorld(sim2);
    sim2.addPlayer("s2");
    const player2 = playerEidOf(world2);
    expect(inventoryCount(world2, player2, "m")).toBe(3);
    expect(inventoryCount(world2, player2, "out")).toBe(0);
    const progress = craftingProgressOf(world2, player2);
    expect(progress).toHaveLength(1);
    expect(progress[0]!.remainingTicks).toBe(40);

    // 39 tick 未完成；第 40 tick 产出
    for (let i = 0; i < 39; i++) sim2.tick(DT_MS);
    expect(inventoryCount(world2, player2, "out")).toBe(0);
    sim2.tick(DT_MS);
    expect(inventoryCount(world2, player2, "out")).toBe(1);
    expect(craftingProgressOf(world2, player2)).toEqual([]);
  });

  it("离线补差跨过完成点：恢复时直接结算产出（与在线同款 stepCraftingJobs）", async () => {
    const { def, record } = await startSlowCraft();

    const sim2 = await loadWithOfflineTicks(def, record, 40);
    const world2 = simWorld(sim2);
    expect(world2.time.tick).toBe(record.tick + 40);
    sim2.addPlayer("s2");
    const player2 = playerEidOf(world2);
    expect(inventoryCount(world2, player2, "out")).toBe(1);
    expect(craftingProgressOf(world2, player2)).toEqual([]);
  });

  it("恢复后取消退料语义仍可用（材料退回背包，任务清空）", async () => {
    const { def, record } = await startSlowCraft();

    const sim2 = await loadWithOfflineTicks(def, record, 5);
    const world2 = simWorld(sim2);
    sim2.addPlayer("s2");
    const player2 = playerEidOf(world2);
    expect(craftingProgressOf(world2, player2).length).toBe(1);
    expect(sim2.submitCommand("s2", { type: "craft-cancel", recipe: "slow" })).toBe(true);
    expect(craftingProgressOf(world2, player2)).toEqual([]);
    expect(inventoryCount(world2, player2, "m")).toBe(5);
  });

  it("旧档缺 craftingJobs 字段：按空表恢复（不抛错）", async () => {
    const { def, record } = await startSlowCraft();
    const legacy = { ...record, craftingJobs: undefined } as WorldRecord;

    const sim2 = await loadWithOfflineTicks(def, legacy, 0);
    const world2 = simWorld(sim2);
    sim2.addPlayer("s2");
    expect(craftingProgressOf(world2, playerEidOf(world2))).toEqual([]);
    expect(world2.craftingJobs.size).toBe(0);
  });
});

/* ------------------------------------------------------------------ */
/* C/D. 成长与成就同步                                                  */
/* ------------------------------------------------------------------ */

function syncDef(): LoadedGameDefinition {
  const def = createDefaultGameDefinition();
  def.resolvedItems = ITEMS;
  def.netSync = {
    fields: [
      ...(def.netSync?.fields ?? []),
      { component: "Progression", tags: ["Player"], fields: ["totalXp", "level", "skills"] },
      { component: "Achievements", tags: ["Player"], fields: ["unlocked"] },
      // 未注册适配器的 AoS 组件（Nest）：验证"静默跳过"行为不变
      { component: "Nest", tags: ["Player"], fields: ["spawnKind"] },
    ],
  };
  return def;
}

function setProgression(eid: number): void {
  Progression[eid] = {
    totalXp: 1234,
    level: 5,
    skills: { combat: { xp: 40, level: 3 }, gathering: { xp: 10, level: 2 } },
  };
}

describe("C/D. Progression 与 Achievements 同步", () => {
  it("快照含 Progression 展平键；未注册适配器组件无输出；序列化往返保真", async () => {
    const def = syncDef();
    const sim = await createGameSimulation(def);
    const world = simWorld(sim);
    const { networkId } = sim.addPlayer("s1");
    const player = playerEidOf(world);
    setProgression(player);

    const { snapshot } = sim.tick(DT_MS);
    const snap = snapshot.entities.get(networkId)!;
    expect(snap.values["Progression.totalXp"]).toBe(1234);
    expect(snap.values["Progression.level"]).toBe(5);
    expect(snap.values["Progression.skill.combat.xp"]).toBe(40);
    expect(snap.values["Progression.skill.combat.level"]).toBe(3);
    expect(snap.values["Progression.skill.gathering.xp"]).toBe(10);
    expect(snap.values["Progression.skill.gathering.level"]).toBe(2);

    // 未注册适配器：Nest 条目静默跳过（不产生任何字段、不影响其余字段）
    expect(getAosSyncAdapter("Nest")).toBeUndefined();
    expect(Object.keys(snap.values).some((k) => k.startsWith("Nest."))).toBe(false);
    expect(Object.keys(snap.strings).some((k) => k.startsWith("Nest."))).toBe(false);
    expect(snap.values["Transform.x"]).toBe(0);

    // 序列化往返：Progression 随实体入档（无需额外持久化代码）
    const record = serializeWorld(world, "progress");
    const sim2 = await loadWithOfflineTicks(def, record, 0);
    const world2 = simWorld(sim2);
    sim2.addPlayer("s2");
    const restored = Progression[playerEidOf(world2)] as ProgressionState;
    expect(restored).toEqual({
      totalXp: 1234,
      level: 5,
      skills: { combat: { xp: 40, level: 3 }, gathering: { xp: 10, level: 2 } },
    });
  });

  it("Achievements：解锁键进快照；初始化钩子从 world.progress 播种", async () => {
    const def = syncDef();
    const sim = await createGameSimulation(def);
    const world = simWorld(sim);
    const { networkId } = sim.addPlayer("s1");
    const player = playerEidOf(world);
    Achievements[player] = { unlocked: {} };

    world.progress["achievement:village_friend"] = 1;
    markAchievementUnlocked(world, "village_friend");

    const { snapshot } = sim.tick(DT_MS);
    expect(snapshot.entities.get(networkId)!.values["Achievements.village_friend"]).toBe(1);

    // 后加入者：初始化钩子按既有 world.progress 播种（无需等下一次解锁）
    const later = spawnEntity(world, world.archetypes.get("player"), getRegistries().componentRegistry);
    initAchievements(world, later);
    expect(Achievements[later]).toEqual({ unlocked: { village_friend: 1 } });
  });

  it("client-schema 手动副本：字段名/顺序/类型与服务端完全一致（无 schema 字段变更）", () => {
    const read = (rel: string): string => readFileSync(new URL(rel, import.meta.url), "utf8");

    /** 抽取某类块内按声明顺序的 `类型:字段名` 列表（只取 @type 修饰的字段）。 */
    function schemaFields(source: string, className: string): string[] {
      const start = source.indexOf(`export class ${className}`);
      expect(start).toBeGreaterThanOrEqual(0);
      const next = source.indexOf("export class", start + 1);
      const block = source.slice(start, next < 0 ? undefined : next);
      const fields: string[] = [];
      for (const match of block.matchAll(/@type\((.+?)\)\s*(?:public\s+)?(\w+)\s*[:=!]/g)) {
        fields.push(`${match[1]!.trim()}:${match[2]}`);
      }
      return fields;
    }

    const server = {
      EntityState: read("../net/colyseus/state/EntityState.ts"),
      PlayerState: read("../net/colyseus/state/PlayerState.ts"),
      RoomState: read("../net/colyseus/state/RoomState.ts"),
    };
    const client = read("../../src/network/colyseus/client-schema/schema.ts");

    for (const className of ["EntityState", "PlayerState", "RoomState"] as const) {
      expect(schemaFields(client, className), `${className} 字段顺序/类型`).toEqual(
        schemaFields(server[className], className),
      );
    }

    // 成长/成就只扩展动态 values key，不新增 schema 字段：
    // values/stringValues 仍在 EntityState 的既有索引位置上。
    expect(schemaFields(client, "EntityState")).toEqual([
      '"uint32":id',
      '{ map: "number" }:values',
      '{ map: "string" }:stringValues',
    ]);
  });
});
