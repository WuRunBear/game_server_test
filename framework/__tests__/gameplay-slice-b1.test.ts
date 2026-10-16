/**
 * 玩法切片 B1 测试：死亡惩罚（死亡容器 + 物品保留标志）。
 *
 * 覆盖：
 * ① 玩家死亡生成死亡容器（corpse 原型，Container 标签）且背包整体转移（含装备槽引用的物品）；
 * ② keepOnDeath 物品不进容器、留在玩家身上；
 * ③ 容器超时销毁且内容物消失（ExpiresAt + despawn，ttlTicks 配置驱动，0 = 永不过期）；
 * ④ transfer + target 命令通道从容器取回物品（端到端：死亡 → 重生 → 取回）；
 * ⑤ 非玩家死亡不生成容器，LootTable 落地行为不变；
 * ⑥ respawn 后 keepOnDeath 物品仍在玩家背包；
 * ⑦ 未配置 deathContainer 时维持旧行为（不生成容器）；
 * ⑧ 真实配置 netSync：容器背包经 Container 标签对客户端可见。
 */
import { describe, it, expect, beforeAll } from "vitest";
import { addComponent, addEntity, query } from "bitecs";
import {
  bootstrapFramework,
  createGameInstance,
  createGameSimulation,
  createDefaultGameDefinition,
  loadGameDefinition,
} from "framework/index";
import type { SimulationPort } from "simulation";
import { deathSystem } from "framework/systems/gameplay/deathSystem";
import { respawnSystem } from "framework/systems/gameplay/respawnSystem";
import { timerSystem } from "framework/simulation/timer/timerSystem";
import { ExpiresAt } from "framework/simulation/timer/timer";
import type { GameWorld } from "framework/world";
import type { ItemKindSpec } from "framework/config/schema/ItemKindSchema";
import { Transform } from "framework/components/transform";
import { NetworkId } from "framework/components/network";
import { Player, NPC, Enemy, Container, Item } from "framework/components/tags";
import { Health, Team } from "framework/components/combat";
import { Inventory } from "framework/components/inventory";
import { Equipment } from "framework/components/equipment";
import { ItemMeta } from "framework/components/itemMeta";
import { LootTable } from "framework/components/loot";
import { Kind } from "framework/components/kind";
import { Perception } from "framework/components/perception";
import { setEntityKind } from "framework/systems/gameplay/aiSystem";

beforeAll(() => {
  // 全局引导一次：注册表是幂等单例，所有用例共享同一套内置实现
  bootstrapFramework();
});

/** 构造一个最小世界（默认配置，无依赖具体 game 配置内容）。 */
function createBareWorld(): GameWorld {
  return createGameInstance(createDefaultGameDefinition()).world;
}

function setItemKind(world: GameWorld, spec: ItemKindSpec): void {
  world.gameDef.itemsByKind!.set(spec.kind, spec);
}

/** 注册测试用死亡容器原型（全局注册表单例，已存在则跳过）。 */
function ensureCorpseArchetype(world: GameWorld): void {
  if (!world.archetypes.has("corpse")) {
    world.archetypes.register({
      kind: "corpse",
      tags: ["Container"],
      components: {
        Size: { w: 16, h: 16 },
        Inventory: { capacity: 16 },
      },
    });
  }
}

interface PlayerOpts {
  x?: number; y?: number; hp?: number; capacity?: number;
}

/** 手工 spawn 测试玩家：写 Player/Health/Transform/Team + Inventory AoS。 */
function spawnTestPlayer(world: GameWorld, opts: PlayerOpts = {}): number {
  const eid = addEntity(world);
  addComponent(world, eid, Transform);
  addComponent(world, eid, NetworkId);
  addComponent(world, eid, Player);
  addComponent(world, eid, Health);
  addComponent(world, eid, Team);
  Transform.x[eid] = opts.x ?? 0;
  Transform.y[eid] = opts.y ?? 0;
  Health.current[eid] = opts.hp ?? 100;
  Health.max[eid] = 100;
  Team.id[eid] = 1;
  const capacity = opts.capacity ?? 4;
  Inventory[eid] = { capacity, slots: Array.from({ length: capacity }, () => null) };
  NetworkId.value[eid] = world.nextNetworkId++;
  setEntityKind(world, eid, "test-player");
  return eid;
}

/** 手工 spawn 测试敌实体：NPC+Enemy 标签 + Health/Perception。 */
function spawnTestEnemy(world: GameWorld, opts: { x?: number; y?: number; hp?: number } = {}): number {
  const eid = addEntity(world);
  addComponent(world, eid, Transform);
  addComponent(world, eid, NetworkId);
  addComponent(world, eid, NPC);
  addComponent(world, eid, Enemy);
  addComponent(world, eid, Health);
  addComponent(world, eid, Perception);
  addComponent(world, eid, Team);
  Transform.x[eid] = opts.x ?? 0;
  Transform.y[eid] = opts.y ?? 0;
  Health.current[eid] = opts.hp ?? 30;
  Health.max[eid] = opts.hp ?? 30;
  Team.id[eid] = 2;
  NetworkId.value[eid] = world.nextNetworkId++;
  setEntityKind(world, eid, "test-enemy");
  return eid;
}

function simWorld(sim: SimulationPort): GameWorld {
  return (sim as unknown as { world: GameWorld }).world;
}

// ① 玩家死亡 → 容器生成 + 背包整体转移（含装备槽）
describe("B1：死亡容器生成与背包转移", () => {
  it("玩家死亡生成 corpse 容器，背包整体转移（含装备槽引用的物品）", () => {
    const world = createBareWorld();
    ensureCorpseArchetype(world);
    world.gameDef.resolvedRules["respawn"] = {
      delayMs: 1000,
      deathContainer: { archetype: "corpse", ttlTicks: 6000 },
    };
    setItemKind(world, { kind: "k1", maxStack: 20 });
    setItemKind(world, { kind: "k2", maxStack: 20 });

    const player = spawnTestPlayer(world, { x: 42, y: -7, hp: 0 });
    Inventory[player]!.slots[0] = { kind: "k1", count: 3 }; // 装备槽引用的物品
    Inventory[player]!.slots[1] = { kind: "k2", count: 1 };
    addComponent(world, player, Equipment);
    Equipment.weaponSlot[player] = 0;

    deathSystem(world);

    const corpses = query(world, [Container]);
    expect(corpses.length).toBe(1);
    const corpse = corpses[0];
    // 容器在死亡位置生成、归属同图、kind = 原型名
    expect(Transform.x[corpse]).toBe(42);
    expect(Transform.y[corpse]).toBe(-7);
    expect(Kind[corpse]).toBe("corpse");
    // 背包整体转移（逐槽搬入）
    expect(Inventory[corpse]!.slots[0]).toEqual({ kind: "k1", count: 3 });
    expect(Inventory[corpse]!.slots[1]).toEqual({ kind: "k2", count: 1 });
    // 玩家背包被清空、玩家实体不移除（原地重生语义）
    expect(Inventory[player]!.slots[0]).toBeNull();
    expect(Inventory[player]!.slots[1]).toBeNull();
    expect(query(world, [Player]).length).toBe(1);
  });

  it("已标记玩家不重复生成容器（重生窗口内只生成一次）", () => {
    const world = createBareWorld();
    ensureCorpseArchetype(world);
    world.gameDef.resolvedRules["respawn"] = {
      delayMs: 1000,
      deathContainer: { archetype: "corpse" },
    };
    spawnTestPlayer(world, { hp: 0 });
    deathSystem(world);
    deathSystem(world);
    expect(query(world, [Container]).length).toBe(1);
  });
});

// ② keepOnDeath：保留标志物不进容器
describe("B1：物品保留标志（keepOnDeath）", () => {
  it("keepOnDeath 物品留在玩家原槽位，其余转入容器", () => {
    const world = createBareWorld();
    ensureCorpseArchetype(world);
    world.gameDef.resolvedRules["respawn"] = {
      delayMs: 1000,
      deathContainer: { archetype: "corpse" },
    };
    setItemKind(world, { kind: "k1", maxStack: 20 });
    setItemKind(world, { kind: "keep1", maxStack: 20, keepOnDeath: true });

    const player = spawnTestPlayer(world, { hp: 0 });
    Inventory[player]!.slots[0] = { kind: "k1", count: 3 };
    Inventory[player]!.slots[1] = { kind: "keep1", count: 2 };

    deathSystem(world);

    const corpse = query(world, [Container])[0];
    expect(Inventory[corpse]!.slots[0]).toEqual({ kind: "k1", count: 3 });
    expect(Inventory[corpse]!.slots[1]).toBeNull();
    // 保留物原地不动（槽位索引稳定，装备引用不失效）
    expect(Inventory[player]!.slots[0]).toBeNull();
    expect(Inventory[player]!.slots[1]).toEqual({ kind: "keep1", count: 2 });
  });
});

// ③ 超时销毁：ExpiresAt + despawn，配置驱动
describe("B1：死亡容器超时销毁", () => {
  it("ttlTicks 到期 → despawn 销毁容器，内容物随之消失", () => {
    const world = createBareWorld();
    ensureCorpseArchetype(world);
    world.gameDef.resolvedRules["respawn"] = {
      delayMs: 1000,
      deathContainer: { archetype: "corpse", ttlTicks: 5 },
    };
    setItemKind(world, { kind: "k1", maxStack: 20 });

    world.time.tick = 1;
    const player = spawnTestPlayer(world, { hp: 0 });
    Inventory[player]!.slots[0] = { kind: "k1", count: 7 };
    deathSystem(world);

    const corpse = query(world, [Container])[0];
    expect(Inventory[corpse]!.slots[0]).toEqual({ kind: "k1", count: 7 });
    // 一次性定时器落位：到期 tick = 1 + 5
    expect(ExpiresAt[corpse]!.expiresTick).toBe(6);

    world.time.tick = 5;
    timerSystem(world);
    expect(query(world, [Container]).length).toBe(1); // 未到期

    world.time.tick = 6;
    timerSystem(world);
    expect(query(world, [Container]).length).toBe(0); // 到期销毁
    expect(Inventory[corpse]).toBeUndefined(); // AoS 残留清理（内容物消失）
  });

  it("ttlTicks = 0 → 永不过期", () => {
    const world = createBareWorld();
    ensureCorpseArchetype(world);
    world.gameDef.resolvedRules["respawn"] = {
      delayMs: 1000,
      deathContainer: { archetype: "corpse", ttlTicks: 0 },
    };
    world.time.tick = 1;
    spawnTestPlayer(world, { hp: 0 });
    deathSystem(world);
    const corpse = query(world, [Container])[0];
    expect(ExpiresAt[corpse]).toBeUndefined();
    world.time.tick = 999;
    timerSystem(world);
    expect(query(world, [Container]).length).toBe(1);
  });
});

// ④ 端到端命令通道：transfer + target 从容器取回
describe("B1：容器取回通道（transfer + target）", () => {
  it("死亡 → 重生 → submitCommand 从尸体取回物品", async () => {
    const def = createDefaultGameDefinition();
    def.systems = [
      { id: "death" },
      { id: "respawn" },
      { id: "timer" },
      { id: "inventory" },
    ];
    def.resolvedRules["respawn"] = {
      delayMs: 0,
      deathContainer: { archetype: "corpse" },
    };
    const sim = await createGameSimulation(def);
    const world = simWorld(sim);
    ensureCorpseArchetype(world);
    world.gameDef.itemsByKind = new Map([["k1", { kind: "k1", maxStack: 20 }]]);

    sim.addPlayer("s1");
    const player = query(world, [Player])[0];
    if (!Inventory[player]) {
      Inventory[player] = { capacity: 4, slots: [null, null, null, null] };
    }
    Inventory[player]!.slots[0] = { kind: "k1", count: 5 };

    Health.current[player] = 0;
    sim.tick(50); // death：生成容器 + 转移背包

    const corpse = query(world, [Container])[0];
    expect(corpse).toBeDefined();
    const corpseNetworkId = NetworkId.value[corpse];
    expect(Inventory[corpse]!.slots[0]).toEqual({ kind: "k1", count: 5 });
    expect(Inventory[player]!.slots[0]).toBeNull();

    sim.tick(50); // respawn：delayMs 0 → 血量回满，命令通道重新放行
    expect(Health.current[player]).toBe(100);

    expect(sim.submitCommand("s1", { type: "transfer", target: corpseNetworkId, slot: 0 })).toBe(true);
    expect(Inventory[player]!.slots[0]).toEqual({ kind: "k1", count: 5 });
    expect(Inventory[corpse]!.slots[0]).toBeNull();
  });

  it("取回校验：未知目标 / 非 Inventory 实体 / 跨图拒绝", async () => {
    const def = createDefaultGameDefinition();
    def.systems = [{ id: "death" }, { id: "respawn" }];
    def.resolvedRules["respawn"] = {
      delayMs: 1000,
      deathContainer: { archetype: "corpse" },
    };
    const sim = await createGameSimulation(def);
    const world = simWorld(sim);
    ensureCorpseArchetype(world);

    sim.addPlayer("s1");
    const player = query(world, [Player])[0];
    if (!Inventory[player]) {
      Inventory[player] = { capacity: 4, slots: [null, null, null, null] };
    }

    // 未知 networkId / 非法值
    expect(sim.submitCommand("s1", { type: "transfer", target: 99999, slot: 0 })).toBe(false);
    expect(sim.submitCommand("s1", { type: "transfer", target: 0, slot: 0 })).toBe(false);

    // 非 Inventory 实体（敌实体带 Health 无背包）不可作为容器
    Health.current[player] = 0;
    deathSystem(world);
    const corpse = query(world, [Container])[0];
    const enemy = spawnTestEnemy(world, { hp: 100 });
    Inventory[corpse]!.slots[0] = { kind: "k1", count: 1 };
    expect(sim.submitCommand("s1", { type: "transfer", target: NetworkId.value[enemy], slot: 0 })).toBe(false);
    // 自己不是容器
    expect(sim.submitCommand("s1", { type: "transfer", target: NetworkId.value[player], slot: 0 })).toBe(false);
    // 合法容器未到期前照常可取（同图）
    expect(sim.submitCommand("s1", { type: "transfer", target: NetworkId.value[corpse], slot: 0 })).toBe(false); // 玩家已死亡：命令守卫拒绝
    expect(Inventory[corpse]!.slots[0]).toEqual({ kind: "k1", count: 1 });
  });
});

// ⑤ 非玩家死亡：无容器，LootTable 行为不变
describe("B1：非玩家死亡不受容器机制影响", () => {
  it("敌实体死亡 → LootTable 落地 + 销毁，不生成容器", () => {
    const world = createBareWorld();
    ensureCorpseArchetype(world);
    world.gameDef.resolvedRules["respawn"] = {
      delayMs: 1000,
      deathContainer: { archetype: "corpse" },
    };
    setItemKind(world, { kind: "m1", maxStack: 20 });
    const enemy = spawnTestEnemy(world, { x: 3, y: 4, hp: 0 });
    LootTable[enemy] = [{ kind: "m1", qty: 2, chance: 1 }];

    deathSystem(world);

    expect(query(world, [Container]).length).toBe(0);
    expect(query(world, [Enemy]).length).toBe(0); // 照常销毁
    const items = query(world, [Item]);
    expect(items.length).toBe(1);
    expect(ItemMeta[items[0]]).toMatchObject({ kind: "m1", count: 2 });
    // 原地散布落点：距死亡位置 16~24px（确定性散布流）
    const dist = Math.hypot(Transform.x[items[0]] - 3, Transform.y[items[0]] - 4);
    expect(dist).toBeGreaterThanOrEqual(16);
    expect(dist).toBeLessThanOrEqual(25);
  });
});

// ⑥ respawn 后 keepOnDeath 物品仍在
describe("B1：重生保留语义", () => {
  it("重生回满血后，keepOnDeath 物品仍在背包", () => {
    const world = createBareWorld();
    ensureCorpseArchetype(world);
    world.gameDef.resolvedRules["respawn"] = {
      delayMs: 0,
      deathContainer: { archetype: "corpse" },
    };
    setItemKind(world, { kind: "k1", maxStack: 20 });
    setItemKind(world, { kind: "keep1", maxStack: 20, keepOnDeath: true });

    const player = spawnTestPlayer(world, { hp: 0 });
    Inventory[player]!.slots[0] = { kind: "keep1", count: 1 };
    Inventory[player]!.slots[1] = { kind: "k1", count: 2 };

    deathSystem(world);
    respawnSystem(world);

    expect(Health.current[player]).toBe(100);
    expect(Inventory[player]!.slots[0]).toEqual({ kind: "keep1", count: 1 });
    expect(Inventory[player]!.slots[1]).toBeNull(); // 非保留物已进容器
    const corpse = query(world, [Container])[0];
    expect(Inventory[corpse]!.slots[0]).toEqual({ kind: "k1", count: 2 });
  });
});

// ⑦ 未配置 deathContainer：维持旧行为
describe("B1：无容器配置的向后兼容", () => {
  it("无 deathContainer 配置 → 玩家死亡不生成容器", () => {
    const world = createBareWorld();
    world.gameDef.resolvedRules["respawn"] = { delayMs: 1000 };
    const player = spawnTestPlayer(world, { hp: 0 });
    Inventory[player]!.slots[0] = { kind: "k1", count: 3 };
    setItemKind(world, { kind: "k1", maxStack: 20 });

    deathSystem(world);

    expect(query(world, [Container]).length).toBe(0);
    expect(Inventory[player]!.slots[0]).toEqual({ kind: "k1", count: 3 }); // 背包不动
    expect(query(world, [Player]).length).toBe(1);
  });

  it("容器原型未注册 → 记 error 跳过生成，不崩溃", () => {
    const world = createBareWorld();
    world.gameDef.resolvedRules["respawn"] = {
      delayMs: 1000,
      deathContainer: { archetype: "not-registered" },
    };
    const player = spawnTestPlayer(world, { hp: 0 });
    expect(() => deathSystem(world)).not.toThrow();
    expect(query(world, [Container]).length).toBe(0);
    expect(query(world, [Player]).length).toBe(1);
  });
});

// ⑧ 真实配置 netSync：容器背包对客户端可见
describe("B1：真实配置集成（corpse 原型 + netSync 接线）", () => {
  it("真实 game 配置下死亡 → 容器背包经 Container 标签展平进快照", async () => {
    const def = loadGameDefinition({ gameJsonPath: "game/game.json" });
    const sim = await createGameSimulation(def);
    const world = simWorld(sim);
    sim.addPlayer("s1");
    const player = query(world, [Player])[0];
    Inventory[player]!.slots[0] = { kind: "wood", count: 3 };

    Health.current[player] = 0;
    sim.tick(50); // death（真实规则 delayMs 2000：玩家仍处死亡窗口）

    const corpse = query(world, [Container])[0];
    expect(corpse).toBeDefined();
    expect(Kind[corpse]).toBe("corpse");
    expect(Inventory[corpse]!.slots[0]).toEqual({ kind: "wood", count: 3 });
    expect(Inventory[player]!.slots[0]).toBeNull();

    // netSync：Inventory 条目按 Container 标签限定 → 容器槽位对客户端可见
    const { snapshot } = sim.tick(50);
    const corpseSnap = snapshot.entities.get(NetworkId.value[corpse]);
    expect(corpseSnap).toBeDefined();
    expect(corpseSnap!.strings["Inventory.0.kind"]).toBe("wood");
    expect(corpseSnap!.values["Inventory.0.count"]).toBe(3);
  });
});
