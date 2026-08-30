/**
 * 生存循环（Slice 1/2）与基础设施测试：生存 / 战斗 / 感知 / 行为树 链路。
 *
 * 覆盖：背包纯函数（addToInventory/consume/drop/transfer）、Need 衰减与
 * 食用补给、采集（harvest）、交互意图路由、combat 原子与冷却、perception
 * 感知、death/respawn、BT 战斗节点（Chase/Attack/Flee 等），以及生存/战斗
 * 闭环集成与真实 netSync 接线（OR 语义 + AoS 展平）。
 */
import { describe, it, expect, beforeAll } from "vitest";
import { addComponent, addEntity, hasComponent, query, removeEntity } from "bitecs";
import { State } from "mistreevous";
import {
  bootstrapFramework,
  createGameInstance,
  createGameSimulation,
  createDefaultGameDefinition,
  loadGameDefinition,
  spawnEntity,
  getRegistries,
  createActionRegistry,
} from "framework/index";
import { Transform } from "framework/components/transform";
import { Size } from "framework/components/size";
import { Velocity } from "framework/components/physics";
import { Health, Attack, Defense, Team } from "framework/components/combat";
import { Cooldown } from "framework/components/timer";
import { NetworkId } from "framework/components/network";
import { Player, Resource, Item, Enemy, NPC } from "framework/components/tags";
import { Perception } from "framework/components/perception";
import { Inventory, type InventoryEntry } from "framework/components/inventory";
import { ItemMeta } from "framework/components/itemMeta";
import { Needs, type Need } from "framework/components/needs";
import { ResourceNode } from "framework/components/resourceNode";
import { LootTable } from "framework/components/loot";
import { Intent } from "framework/components/intent";
import { needDecaySystem } from "framework/systems/gameplay/needDecaySystem";
import { inventorySystem } from "framework/systems/gameplay/inventorySystem";
import { harvest } from "framework/systems/gameplay/gatheringSystem";
import { createInteractionSystem } from "framework/systems/gameplay/interactionSystem";
import { attackTarget, combatSystem } from "framework/systems/gameplay/combatSystem";
import { deathSystem } from "framework/systems/gameplay/deathSystem";
import { respawnSystem } from "framework/systems/gameplay/respawnSystem";
import { perceptionSystem } from "framework/systems/gameplay/perceptionSystem";
import {
  addToInventory,
  consumeSlot,
  dropSlot,
  transferSlot,
} from "framework/systems/gameplay/inventoryOps";
import { setEntityKind, getOrCreateBlackboard } from "framework/systems/gameplay/aiSystem";
import {
  createBlackboard,
  bbGet,
  bbSet,
  BB_PERCEPTION_TARGET,
  type PerceivedTarget,
} from "framework/ai/blackboard";
import { createNpcTree } from "framework/ai/btFactory";
import { stepBehaviourTree } from "framework/ai/btRunner";
import { registerBuiltinActions } from "framework/ai/registerBuiltinActions";
import type { GameWorld } from "framework/world";
import type { ItemKindSpec } from "framework/config/schema/ItemKindSchema";

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

interface PlayerOpts {
  x?: number; y?: number; hp?: number; capacity?: number; needs?: Need[];
  attack?: { value: number; range?: number };
}

/** 手工 spawn 测试玩家：写 Player/Health/Transform + Inventory/Needs AoS。 */
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
  if (opts.attack) {
    addComponent(world, eid, Attack);
    Attack.value[eid] = opts.attack.value;
    Attack.range[eid] = opts.attack.range ?? 0;
  }
  const capacity = opts.capacity ?? 4;
  Inventory[eid] = { capacity, slots: Array.from({ length: capacity }, () => null) };
  Needs[eid] = opts.needs ?? [];
  NetworkId.value[eid] = world.nextNetworkId++;
  setEntityKind(world, eid, "test-player");
  return eid;
}

interface ResourceOpts {
  x?: number; y?: number; remaining?: number; max?: number;
  amountPerHit?: number; regenMs?: number; yieldsKind?: string; directConsume?: boolean;
}

/** 手工 spawn 测试资源节点：写 Resource tag + ResourceNode AoS。 */
function spawnTestResource(world: GameWorld, opts: ResourceOpts = {}): number {
  const eid = addEntity(world);
  addComponent(world, eid, Transform);
  addComponent(world, eid, NetworkId);
  addComponent(world, eid, Resource);
  addComponent(world, eid, Size);
  Transform.x[eid] = opts.x ?? 0;
  Transform.y[eid] = opts.y ?? 0;
  const max = opts.max ?? opts.remaining ?? 1;
  ResourceNode[eid] = {
    remaining: opts.remaining ?? max,
    max,
    amountPerHit: opts.amountPerHit ?? 1,
    regenMs: opts.regenMs ?? 0,
    yieldsKind: opts.yieldsKind ?? "k1",
    directConsume: opts.directConsume ?? false,
    depletedSinceMs: null,
  };
  NetworkId.value[eid] = world.nextNetworkId++;
  setEntityKind(world, eid, "test-resource");
  return eid;
}

interface GroundItemOpts { x?: number; y?: number; kind?: string; count?: number; pickupAfterMs?: number; }

/** 手工 spawn 地面 item 实体：Item tag + ItemMeta AoS。 */
function spawnGroundItem(world: GameWorld, opts: GroundItemOpts = {}): number {
  const eid = addEntity(world);
  addComponent(world, eid, Transform);
  addComponent(world, eid, NetworkId);
  addComponent(world, eid, Item);
  addComponent(world, eid, Size);
  Transform.x[eid] = opts.x ?? 0;
  Transform.y[eid] = opts.y ?? 0;
  ItemMeta[eid] = {
    kind: opts.kind ?? "k1",
    count: opts.count ?? 1,
    pickupAfterMs: opts.pickupAfterMs ?? 0,
  };
  NetworkId.value[eid] = world.nextNetworkId++;
  setEntityKind(world, eid, "test-item");
  return eid;
}

interface EnemyOpts {
  x?: number; y?: number; hp?: number;
  attack?: { value: number; range?: number };
  visionRadius?: number;
  team?: number;
}

/** 手工 spawn 测试敌实体：NPC+Enemy 标签 + Perception + 可选 Attack/LootTable。 */
function spawnTestEnemy(world: GameWorld, opts: EnemyOpts = {}): number {
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
  Perception.visionRadius[eid] = opts.visionRadius ?? 100;
  Team.id[eid] = opts.team ?? 2;
  if (opts.attack) {
    addComponent(world, eid, Attack);
    Attack.value[eid] = opts.attack.value;
    Attack.range[eid] = opts.attack.range ?? 0;
  }
  NetworkId.value[eid] = world.nextNetworkId++;
  setEntityKind(world, eid, "test-enemy");
  return eid;
}

// 背包纯函数：合入同 kind 未满堆叠、受 maxStack 限制、满包返回未入剩余量、未知 kind 视作 maxStack=1
describe("addToInventory (纯函数)", () => {
  it("合入同 kind 未满堆叠", () => {
    const inv: InventoryEntry = { capacity: 3, slots: [{ kind: "k1", count: 5 }, null, null] };
    const kinds = new Map([["k1", { kind: "k1", maxStack: 20 }]]);
    expect(addToInventory(inv, kinds, "k1", 10)).toBe(0);
    expect(inv.slots[0]).toEqual({ kind: "k1", count: 15 });
  });

  it("用空槽并入且受 maxStack 限制", () => {
    const inv: InventoryEntry = { capacity: 3, slots: [null, null, null] };
    const kinds = new Map([["k2", { kind: "k2", maxStack: 2 }]]);
    expect(addToInventory(inv, kinds, "k2", 5)).toBe(0);
    expect(inv.slots[0]).toEqual({ kind: "k2", count: 2 });
    expect(inv.slots[1]).toEqual({ kind: "k2", count: 2 });
    expect(inv.slots[2]).toEqual({ kind: "k2", count: 1 });
  });

  it("满包时返回未入的剩余量（Defect-3 等价语义）", () => {
    const inv: InventoryEntry = { capacity: 1, slots: [{ kind: "k2", count: 2 }] };
    const kinds = new Map([["k2", { kind: "k2", maxStack: 2 }]]);
    expect(addToInventory(inv, kinds, "k2", 3)).toBe(3);
    expect(inv.slots[0]).toEqual({ kind: "k2", count: 2 });
  });

  it("未知 kind 视作 maxStack=1", () => {
    const inv: InventoryEntry = { capacity: 2, slots: [null, null] };
    expect(addToInventory(inv, undefined, "unknown", 1)).toBe(0);
    expect(inv.slots[0]).toEqual({ kind: "unknown", count: 1 });
  });
});

// 槽操作：consume 恢复 Need 并减堆叠、drop 生成地面物品（有拾取冷却）、transfer 移动/合并/交换
describe("consumeSlot / dropSlot / transferSlot", () => {
  it("consumeSlot 恢复 Need 并减堆叠；不可食用返回 false", () => {
    const world = createBareWorld();
    setItemKind(world, { kind: "k1", maxStack: 5, consume: [{ need: "n1", amount: 20 }] });
    const player = spawnTestPlayer(world, { needs: [{ name: "n1", current: 10, max: 100, decayPerSec: 0, starveDmg: 0 }] });
    Inventory[player]!.slots[0] = { kind: "k1", count: 3 };
    expect(consumeSlot(world, player, 0)).toBe(true);
    expect(Inventory[player]!.slots[0]).toEqual({ kind: "k1", count: 2 });
    expect(Needs[player]![0].current).toBe(30);

    Inventory[player]!.slots[1] = { kind: "k2", count: 1 };
    setItemKind(world, { kind: "k2", maxStack: 5 });
    expect(consumeSlot(world, player, 1)).toBe(false);
    expect(Inventory[player]!.slots[1]).toEqual({ kind: "k2", count: 1 });
  });

  it("consumeSlot 消耗最后 1 个时清空槽", () => {
    const world = createBareWorld();
    setItemKind(world, { kind: "k1", maxStack: 5, consume: [{ need: "n1", amount: 20 }] });
    const player = spawnTestPlayer(world, { needs: [{ name: "n1", current: 5, max: 100, decayPerSec: 0, starveDmg: 0 }] });
    Inventory[player]!.slots[0] = { kind: "k1", count: 1 };
    consumeSlot(world, player, 0);
    expect(Inventory[player]!.slots[0]).toBe(null);
  });

  it("dropSlot 生成 item 实体并在 pickupAfterMs 未到时不可被拾取", () => {
    const world = createBareWorld();
    const player = spawnTestPlayer(world, { x: 100, y: 100 });
    Transform.x[player] = 100;
    Transform.y[player] = 100;
    Inventory[player]!.slots[0] = { kind: "k1", count: 2 };
    const before = query(world, [Item]).length;
    expect(dropSlot(world, player, 0)).toBe(true);
    expect(Inventory[player]!.slots[0]).toBe(null);
    expect(query(world, [Item]).length).toBe(before + 1);

    // 紧贴玩家但 pickupAfterMs 未到 → 不被 inventorySystem 吞
    const item = query(world, [Item])[before];
    Transform.x[item] = 101;
    Transform.y[item] = 101;
    inventorySystem(world);
    expect(hasComponent(world, item, Item)).toBe(true);
  });

  it("transferSlot 空 to → 整槽移动", () => {
    const inv: InventoryEntry = { capacity: 2, slots: [{ kind: "k1", count: 5 }, null] };
    expect(transferSlot(inv, 0, 1)).toBe(true);
    expect(inv.slots[0]).toBe(null);
    expect(inv.slots[1]).toEqual({ kind: "k1", count: 5 });
  });

  it("transferSlot 同 kind 合并遵守 maxStack，溢出则部分合并 + 剩余留源槽", () => {
    const inv: InventoryEntry = { capacity: 2, slots: [{ kind: "k1", count: 15 }, { kind: "k1", count: 10 }] };
    // k1 maxStack = 20 → dst 10，仅能并入 10，源留 5
    expect(transferSlot(inv, 0, 1, () => 20)).toBe(true);
    expect(inv.slots[0]).toEqual({ kind: "k1", count: 5 });
    expect(inv.slots[1]).toEqual({ kind: "k1", count: 20 });
  });

  it("transferSlot 同 kind dst 已满 → 原地交换", () => {
    const inv: InventoryEntry = { capacity: 2, slots: [{ kind: "k1", count: 3 }, { kind: "k1", count: 20 }] };
    expect(transferSlot(inv, 0, 1, () => 20)).toBe(true);
    expect(inv.slots[0]).toEqual({ kind: "k1", count: 20 });
    expect(inv.slots[1]).toEqual({ kind: "k1", count: 3 });
  });
});

// Need 衰减：按 dt 衰减、归零扣血（死亡统一交 deathSystem）、decayScale 规则倍率生效
describe("needDecaySystem", () => {
  it("按 dt 衰减 Needs", () => {
    const world = createBareWorld();
    const player = spawnTestPlayer(world, {
      needs: [{ name: "n1", current: 100, max: 100, decayPerSec: 0.5, starveDmg: 0 }],
    });
    world.time.dtMs = 1000;
    needDecaySystem(world);
    expect(Needs[player]![0].current).toBeCloseTo(99.5, 5);
  });

  it("归零时扣 Health；实体保留（死亡统一归 deathSystem）", () => {
    const world = createBareWorld();
    const player = spawnTestPlayer(world, {
      hp: 50,
      needs: [{ name: "n1", current: 0, max: 100, decayPerSec: 0, starveDmg: 200 }],
    });
    world.time.dtMs = 1000;
    needDecaySystem(world);
    expect(Health.current[player]).toBeLessThanOrEqual(0);
    // 饿死不直接移除：玩家分支由 deathSystem 标记重生
    expect(query(world, [Player]).length).toBe(1);
  });

  it("decayedScale 规则倍率生效", () => {
    const world = createBareWorld();
    world.gameDef.resolvedRules["needs"] = { decayScale: 2 };
    const player = spawnTestPlayer(world, {
      needs: [{ name: "n1", current: 100, max: 100, decayPerSec: 1, starveDmg: 0 }],
    });
    world.time.dtMs = 1000;
    needDecaySystem(world);
    expect(Needs[player]![0].current).toBeCloseTo(98, 5); // 100 - 1*2*1
  });
});

// 采集：remaining-- 且产出入包；满包/枯竭拒绝、directConsume 直接恢复 Need、部分入时剩余落地面
describe("harvest (gatheringModule)", () => {
  it("成功：remaining-- 且物品入背包", () => {
    const world = createBareWorld();
    setItemKind(world, { kind: "k1", maxStack: 20 });
    const player = spawnTestPlayer(world, { capacity: 4 });
    const node = spawnTestResource(world, { remaining: 5, max: 5, yieldsKind: "k1" });
    expect(harvest(world, player, node)).toBe(true);
    expect(ResourceNode[node]!.remaining).toBe(4);
    expect(Inventory[player]!.slots[0]).toEqual({ kind: "k1", count: 1 });
  });

  it("满包拒绝：不动节点", () => {
    const world = createBareWorld();
    setItemKind(world, { kind: "k1", maxStack: 1 });
    const player = spawnTestPlayer(world, { capacity: 1 });
    Inventory[player]!.slots[0] = { kind: "k1", count: 1 };
    const node = spawnTestResource(world, { remaining: 5, max: 5, yieldsKind: "k1" });
    expect(harvest(world, player, node)).toBe(false);
    expect(ResourceNode[node]!.remaining).toBe(5);
  });

  it("枯竭拒绝", () => {
    const world = createBareWorld();
    setItemKind(world, { kind: "k1", maxStack: 20 });
    const player = spawnTestPlayer(world);
    const node = spawnTestResource(world, { remaining: 0, max: 5, yieldsKind: "k1" });
    expect(harvest(world, player, node)).toBe(false);
  });

  it("directConsume 直接恢复 Need 不入背包", () => {
    const world = createBareWorld();
    setItemKind(world, { kind: "kw", maxStack: 1, consume: [{ need: "n2", amount: 30 }] });
    const player = spawnTestPlayer(world, {
      needs: [{ name: "n1", current: 100, max: 100, decayPerSec: 0, starveDmg: 0 },
              { name: "n2", current: 10, max: 100, decayPerSec: 0, starveDmg: 0 }],
    });
    const node = spawnTestResource(world, { remaining: 999, max: 999, yieldsKind: "kw", directConsume: true });
    expect(harvest(world, player, node)).toBe(true);
    expect(Needs[player]![1].current).toBe(40);
    expect(Inventory[player]!.slots[0]).toBe(null);
  });

  it("部分入：剩余落到地面 item 实体", () => {
    const world = createBareWorld();
    setItemKind(world, { kind: "k1", maxStack: 1 });
    // capacity 2：槽 0 满（k1 count1），槽 1 空。amountPerHit=2 → 入 1 到槽1，剩 1 掉地
    const player = spawnTestPlayer(world, { x: 0, y: 0, capacity: 2 });
    Inventory[player]!.slots[0] = { kind: "k1", count: 1 };
    const node = spawnTestResource(world, { remaining: 5, max: 5, amountPerHit: 2, yieldsKind: "k1" });
    const before = query(world, [Item]).length;
    expect(harvest(world, player, node)).toBe(true);
    expect(Inventory[player]!.slots[1]).toEqual({ kind: "k1", count: 1 });
    expect(query(world, [Item]).length).toBe(before + 1);
  });
});

// 交互路由：读 Intent 对最近资源执行 harvest 后清空意图；超距不执行仍清空；死亡残留意图不跨重生窗口
describe("interactionSystem 路由", () => {
  it("读 Intent 并对最近 Resource 节点 harvest，随后清空 Intent", () => {
    const world = createBareWorld();
    setItemKind(world, { kind: "k1", maxStack: 20 });
    const player = spawnTestPlayer(world, { x: 0, y: 0 });
    const node = spawnTestResource(world, { x: 10, y: 0, remaining: 5, max: 5, yieldsKind: "k1" });
    Intent[player] = "interact";
    createInteractionSystem({ range: 24 })(world);
    expect(Intent[player]).toBe(null);
    expect(ResourceNode[node]!.remaining).toBe(4);
    expect(Inventory[player]!.slots[0]).toEqual({ kind: "k1", count: 1 });
  });

  it("范围外不 harvest 但仍清空 Intent", () => {
    const world = createBareWorld();
    setItemKind(world, { kind: "k1", maxStack: 20 });
    const player = spawnTestPlayer(world, { x: 0, y: 0 });
    const node = spawnTestResource(world, { x: 100, y: 0, remaining: 5, max: 5, yieldsKind: "k1" });
    Intent[player] = "interact";
    createInteractionSystem({ range: 24 })(world);
    expect(Intent[player]).toBe(null);
    expect(ResourceNode[node]!.remaining).toBe(5);
  });

  it("死亡玩家残留意图被消费：不跨重生窗口触发幽灵攻击", () => {
    const world = createBareWorld();
    world.gameDef.resolvedRules["respawn"] = { delayMs: 0 };
    const player = spawnTestPlayer(world, { x: 0, y: 0, hp: 0, attack: { value: 50, range: 40 } });
    const enemy = spawnTestEnemy(world, { x: 10, y: 0, hp: 100 });
    Intent[player] = "attack";
    // 死亡 tick：意图先被消费（置 null），再被死亡守卫拒绝路由
    createInteractionSystem({ range: 24 })(world);
    expect(Intent[player]).toBe(null);
    expect(Health.current[enemy]).toBe(100);
    // 重生后不留攻击意图，无需输入也不会发出幽灵一击
    deathSystem(world);
    respawnSystem(world);
    expect(Intent[player]).toBe(null);
    createInteractionSystem({ range: 24 })(world);
    expect(Health.current[enemy]).toBe(100);
  });
});

// netSync 接线：多组件同字段以 OR 语义并入一列；AoS 组件经适配器展平为 numbers/strings
describe("netSync：OR 语义 + AoS 适配（用真实 game 配置的 netSync 接线）", () => {
  it("仅 Transform+Size 的 item 实体对快照可见（OR 语义修旧 AND-query 缺陷）", async () => {
    const { componentRegistry, archetypeRegistry } = getRegistries();
    const gameDef = loadGameDefinition({ gameJsonPath: "game/game.json" });
    const sim = await createGameSimulation(gameDef);
    const world = (sim as unknown as { world: GameWorld }).world;
    // 用真实 "item" archetype spawn（只有 Size+Item+Transform）
    const item = spawnEntity(world, archetypeRegistry.get("item"), componentRegistry, { x: 5, y: 5 });
    ItemMeta[item] = { kind: "k1", count: 2, pickupAfterMs: 0 };
    const { snapshot } = sim.tick(50);
    let found = false;
    for (const snap of snapshot.entities.values()) {
      if (snap.strings["ItemMeta.kind"] === "k1" && snap.values["ItemMeta.count"] === 2) {
        found = true; break;
      }
    }
    expect(found).toBe(true);
  });

  it("玩家 Needs/Inventory 通过 AoS 适配展平为 strings + numbers", async () => {
    const gameDef = loadGameDefinition({ gameJsonPath: "game/game.json" });
    const sim = await createGameSimulation(gameDef);
    const { networkId } = sim.addPlayer("s1");
    const { snapshot } = sim.tick(50);
    const snap = snapshot.entities.get(networkId)!;
    // Needs 按索引展平（玩家原型声明了 2 个 Need）
    expect(typeof snap.strings["Needs.0.name"]).toBe("string");
    expect(snap.strings["Needs.0.name"].length).toBeGreaterThan(0);
    expect(typeof snap.values["Needs.0.current"]).toBe("number");
    expect(typeof snap.values["Needs.0.max"]).toBe("number");
    // Inventory 按槽展平（玩家原型声明 capacity 12 → 全发，空槽占位）
    expect(snap.strings["Inventory.0.kind"]).toBe("");
    expect(snap.values["Inventory.0.count"]).toBe(0);
    expect(snap.strings["Inventory.11.kind"]).toBeDefined();
  });
});

// Slice 1 集成：两条生存路径闭环——消耗地面物品恢复 Need，或经采集→食用闭环；Need 归零不掉进负值
describe("Slice 1 集成：生存循环两条路径", () => {
  it("路径 A：采集 → 食用 → Need 回升", () => {
    const world = createBareWorld();
    setItemKind(world, { kind: "k1", maxStack: 20, consume: [{ need: "n1", amount: 20 }] });
    const player = spawnTestPlayer(world, {
      needs: [{ name: "n1", current: 100, max: 100, decayPerSec: 0, starveDmg: 0 }],
    });
    const node = spawnTestResource(world, { x: 10, y: 0, remaining: 5, max: 5, yieldsKind: "k1" });
    // 交互采集
    Intent[player] = "interact";
    createInteractionSystem({ range: 24 })(world);
    expect(Inventory[player]!.slots[0]).toEqual({ kind: "k1", count: 1 });
    // 食用回升
    Needs[player]![0].current = 40;
    expect(consumeSlot(world, player, 0)).toBe(true);
    expect(Needs[player]![0].current).toBe(60);
  });

  it("路径 B：不补给 → 饿死 → deathSystem 标记 → respawnSystem 原地重生", () => {
    const world = createBareWorld();
    world.gameDef.resolvedRules["respawn"] = { delayMs: 0 };
    const player = spawnTestPlayer(world, {
      hp: 50,
      needs: [{ name: "n1", current: 0, max: 100, decayPerSec: 0, starveDmg: 200 },
              { name: "n2", current: 0, max: 100, decayPerSec: 0, starveDmg: 200 }],
    });
    world.time.dtMs = 1000;
    for (let i = 0; i < 100 && (Health.current[player] ?? 0) > 0; i++) {
      needDecaySystem(world);
    }
    expect(Health.current[player]).toBeLessThanOrEqual(0);
    // 玩家不被移除 → death 标记 → respawn 重置回满
    expect(query(world, [Player]).length).toBe(1);
    deathSystem(world);
    respawnSystem(world);
    expect(Health.current[player]).toBe(100);
    expect(Needs[player]![0].current).toBe(100);
  });
});

// combat 原子：伤害=攻-防、冷却限制出手、友伤开关、超射程拒；0 血后由 deathSystem 收尾
describe("Slice 2：combatSystem attackTarget 原子", () => {
  it("冷却中拒绝攻击", () => {
    const world = createBareWorld();
    const player = spawnTestPlayer(world, { attack: { value: 10 } });
    addComponent(world, player, Cooldown);
    Cooldown.remainingMs[player] = 500;
    const enemy = spawnTestEnemy(world, { x: 10, y: 0, hp: 100 });
    expect(attackTarget(world, player, enemy)).toBe(false);
    expect(Health.current[enemy]).toBe(100);
  });

  it("目标已死（Health ≤ 0）拒绝攻击", () => {
    const world = createBareWorld();
    const player = spawnTestPlayer(world, { attack: { value: 10 } });
    const enemy = spawnTestEnemy(world, { x: 10, y: 0, hp: 0 });
    expect(attackTarget(world, player, enemy)).toBe(false);
  });

  it("combatSystem 递减冷却，冷却结束后 attackTarget 再次命中", () => {
    const world = createBareWorld();
    const player = spawnTestPlayer(world, { attack: { value: 10 } });
    addComponent(world, player, Cooldown);
    Cooldown.remainingMs[player] = 0; // 清跨 world 残留（legacy 组件数组全局共享）
    const enemy = spawnTestEnemy(world, { x: 10, y: 0, hp: 100 });
    expect(attackTarget(world, player, enemy)).toBe(true);
    expect(attackTarget(world, player, enemy)).toBe(false); // 冷却中
    world.time.dtMs = 1000;
    combatSystem(world);
    expect(attackTarget(world, player, enemy)).toBe(true);
    expect(Health.current[enemy]).toBe(80);
  });
});

// 感知：光内/夜内过滤——光源内或白天内的目标不可感知，范围与遮挡共同决定可见性
describe("Slice 2：perceptionSystem", () => {
  it("视野内写最近敌对目标；同队不写", () => {
    const world = createBareWorld();
    const self = spawnTestEnemy(world, { x: 0, y: 0, visionRadius: 50 });
    const ally = spawnTestEnemy(world, { x: 5, y: 0, visionRadius: 50, team: 2 });
    const near = spawnTestPlayer(world, { x: 10, y: 0 });
    const far = spawnTestPlayer(world, { x: 100, y: 0 });
    perceptionSystem(world);
    const bb = getOrCreateBlackboard(world, self);
    const target = bbGet<PerceivedTarget>(bb, BB_PERCEPTION_TARGET);
    expect(target?.eid).toBe(near);
    expect(target?.dist).toBe(10);
  });

  it("视野内无敌对 → 黑板写 null", () => {
    const world = createBareWorld();
    const self = spawnTestEnemy(world, { x: 0, y: 0, visionRadius: 50 });
    const ally = spawnTestEnemy(world, { x: 5, y: 0, visionRadius: 50, team: 2 });
    perceptionSystem(world);
    const bb = getOrCreateBlackboard(world, self);
    expect(bbGet(bb, BB_PERCEPTION_TARGET)).toBeNull();
  });

  it("不感知尸体（Health ≤ 0，含重生窗口玩家）", () => {
    const world = createBareWorld();
    const self = spawnTestEnemy(world, { x: 0, y: 0, visionRadius: 50 });
    const corpse = spawnTestPlayer(world, { x: 10, y: 0, hp: 0 });
    perceptionSystem(world);
    const bb = getOrCreateBlackboard(world, self);
    expect(bbGet(bb, BB_PERCEPTION_TARGET)).toBeNull();
  });

  it("team 0 视为中立：不构成感知目标", () => {
    const world = createBareWorld();
    const self = spawnTestEnemy(world, { x: 0, y: 0, visionRadius: 50 });
    const neutral = addEntity(world);
    addComponent(world, neutral, Transform);
    addComponent(world, neutral, Team);
    addComponent(world, neutral, Health);
    Transform.x[neutral] = 5;
    Transform.y[neutral] = 0;
    Team.id[neutral] = 0;
    Health.current[neutral] = 50;
    Health.max[neutral] = 50;
    perceptionSystem(world);
    const bb = getOrCreateBlackboard(world, self);
    expect(bbGet(bb, BB_PERCEPTION_TARGET)).toBeNull();
  });
});

// death：击杀者/位置归属落盘为掉落记录；无击杀者（环境致死）也照常掉落
describe("Slice 2：deathSystem", () => {
  it("非玩家无掉落 → removeEntity", () => {
    const world = createBareWorld();
    spawnTestEnemy(world, { hp: 0 });
    deathSystem(world);
    expect(query(world, [Enemy]).length).toBe(0);
  });

  it("有 LootTable 且命中 → 生成地面 item 实体", () => {
    const world = createBareWorld();
    setItemKind(world, { kind: "m1", maxStack: 20 });
    const enemy = spawnTestEnemy(world, { x: 0, y: 0, hp: 0 });
    LootTable[enemy] = [{ kind: "m1", qty: 2, chance: 1 }];
    deathSystem(world);
    const items = query(world, [Item]);
    expect(items.length).toBe(1);
    expect(ItemMeta[items[0]]).toMatchObject({ kind: "m1", count: 2 });
  });

  it("chance 0 不产出掉落", () => {
    const world = createBareWorld();
    setItemKind(world, { kind: "m1", maxStack: 20 });
    const enemy = spawnTestEnemy(world, { hp: 0 });
    LootTable[enemy] = [{ kind: "m1", qty: 1, chance: 0 }];
    deathSystem(world);
    expect(query(world, [Item]).length).toBe(0);
  });

  it("玩家分支：不移除，标记重生", () => {
    const world = createBareWorld();
    world.gameDef.resolvedRules["respawn"] = { delayMs: 0 };
    const player = spawnTestPlayer(world, { hp: 0 });
    deathSystem(world);
    expect(query(world, [Player]).length).toBe(1);
    respawnSystem(world);
    expect(Health.current[player]).toBe(100);
  });

  it("已标记玩家不重复掷骰掉落（重生窗口内只掷一次）", () => {
    const world = createBareWorld();
    setItemKind(world, { kind: "m1", maxStack: 20 });
    world.gameDef.resolvedRules["respawn"] = { delayMs: 1000 };
    const player = spawnTestPlayer(world, { hp: 0, x: 0, y: 0 });
    LootTable[player] = [{ kind: "m1", qty: 1, chance: 1 }];
    deathSystem(world);
    deathSystem(world);
    const items = query(world, [Item]);
    expect(items.length).toBe(1);
  });
});

// respawn：按延迟在出生点重建实体并清残留（含背包/冷却/死亡窗口拒绝等状态恢复）
describe("Slice 2：respawnSystem", () => {
  it("延迟未到不重置", () => {
    const world = createBareWorld();
    world.gameDef.resolvedRules["respawn"] = { delayMs: 1000 };
    const player = spawnTestPlayer(world, { hp: 0, x: 5, y: 5 });
    deathSystem(world);
    respawnSystem(world);
    expect(Health.current[player]).toBe(0);
  });

  it("到期重置 Health + 传送出生点 + Needs 回满", () => {
    const world = createBareWorld();
    world.gameDef.resolvedRules["respawn"] = { delayMs: 0 };
    const player = spawnTestPlayer(world, {
      hp: 0, x: 42, y: 42,
      needs: [{ name: "n1", current: 0, max: 100, decayPerSec: 0, starveDmg: 0 }],
    });
    deathSystem(world);
    respawnSystem(world);
    expect(Health.current[player]).toBe(100);
    expect(Transform.x[player]).toBe(0);
    expect(Transform.y[player]).toBe(0);
    expect(Needs[player]![0].current).toBe(100);
  });

  it("断线残留标记（实体已移除）被清理，不抛错", () => {
    const world = createBareWorld();
    const player = spawnTestPlayer(world, { hp: 0 });
    deathSystem(world);
    removeEntity(world, player);
    expect(() => respawnSystem(world)).not.toThrow();
    expect(query(world, [Player]).length).toBe(0);
  });
});

// BT 战斗节点：Chase 追击/Attack 攻击并回传黑板上目标状态/目标丢失返回待机，验证行为树驱动战斗
describe("Slice 2：BT 战斗节点", () => {
  function makeInstance(definition: Parameters<typeof createNpcTree>[0]) {
    const registry = createActionRegistry();
    registerBuiltinActions(registry);
    return createNpcTree(definition, registry);
  }

  it("IsTargetInVision：有目标 true / 无目标（未写与写 null）false", () => {
    const world = createBareWorld();
    const self = spawnTestEnemy(world, {});
    const inst = makeInstance({ type: "root", child: { type: "condition", call: "IsTargetInVision" } });
    const bb = createBlackboard(self);
    // 从未写入（undefined）→ false
    stepBehaviourTree(inst, { world, self, bb });
    expect(inst.tree.getState()).toBe(State.FAILED);
    // 生产无目标形态：perception 写入 null → false（Defect：旧实现 null!==undefined 恒 true）
    bbSet(bb, BB_PERCEPTION_TARGET, null);
    inst.tree.reset();
    stepBehaviourTree(inst, { world, self, bb });
    expect(inst.tree.getState()).toBe(State.FAILED);
    // 有目标 → true
    bbSet(bb, BB_PERCEPTION_TARGET, { eid: 999, dist: 10 });
    inst.tree.reset();
    stepBehaviourTree(inst, { world, self, bb });
    expect(inst.tree.getState()).toBe(State.SUCCEEDED);
  });

  it("rabbit 整树：无目标（bb 写 null）时回退 Wander 移动", () => {
    const world = createBareWorld();
    const self = spawnTestEnemy(world, { x: 0, y: 0 });
    const inst = makeInstance({
      type: "root",
      child: {
        type: "selector",
        children: [
          {
            type: "sequence",
            children: [
              { type: "condition", call: "IsTargetInVision" },
              { type: "action", call: "Flee", args: { speed: 80 } },
            ],
          },
          { type: "action", call: "Wander", args: { speed: 40 } },
        ],
      },
    });
    const bb = createBlackboard(self);
    bbSet(bb, BB_PERCEPTION_TARGET, null);
    stepBehaviourTree(inst, { world, self, bb });
    expect(inst.tree.getState()).toBe(State.RUNNING);
    expect(Math.hypot(Velocity.vx[self], Velocity.vy[self])).toBeGreaterThan(0);
  });

  it("Attack：冷却中保持 RUNNING 接战（不退回 Wander）", () => {
    const world = createBareWorld();
    const self = spawnTestEnemy(world, { x: 0, y: 0, attack: { value: 10, range: 30 } });
    addComponent(world, self, Cooldown);
    Cooldown.remainingMs[self] = 500;
    const target = spawnTestPlayer(world, { x: 10, y: 0, hp: 100 });
    const inst = makeInstance({ type: "root", child: { type: "action", call: "Attack" } });
    const bb = createBlackboard(self);
    bbSet(bb, BB_PERCEPTION_TARGET, { eid: target, dist: 10 });
    stepBehaviourTree(inst, { world, self, bb });
    expect(inst.tree.getState()).toBe(State.RUNNING);
    expect(Health.current[target]).toBe(100);
  });

  it("Chase：射程外朝目标移动并保持 RUNNING；到位（进入射程）→ SUCCEEDED 推进序列", () => {
    const world = createBareWorld();
    const self = spawnTestEnemy(world, { x: 0, y: 0 });
    const farTarget = spawnTestPlayer(world, { x: 50, y: 0 });
    const inst = makeInstance({ type: "root", child: { type: "action", call: "Chase", args: { speed: 10 } } });
    const bb = createBlackboard(self);
    // 射程外（默认射程 32 < dist 50）→ RUNNING + 朝目标移动
    bbSet(bb, BB_PERCEPTION_TARGET, { eid: farTarget, dist: 50 });
    stepBehaviourTree(inst, { world, self, bb });
    expect(inst.tree.getState()).toBe(State.RUNNING);
    expect(Velocity.vx[self]).toBeGreaterThan(0);
    // 到位（dist 10 ≤ 32）→ SUCCEEDED，让 sequence 继续到 InAttackRange/Attack
    const nearTarget = spawnTestPlayer(world, { x: 10, y: 0 });
    bbSet(bb, BB_PERCEPTION_TARGET, { eid: nearTarget, dist: 10 });
    inst.tree.reset();
    stepBehaviourTree(inst, { world, self, bb });
    expect(inst.tree.getState()).toBe(State.SUCCEEDED);
    expect(Velocity.vx[self]).toBe(0);
  });

  it("InAttackRange：射程内 true / 射程外 false", () => {
    const world = createBareWorld();
    const self = spawnTestEnemy(world, { x: 0, y: 0, attack: { value: 5, range: 30 } });
    const target = spawnTestPlayer(world, { x: 10, y: 0 });
    const inst = makeInstance({ type: "root", child: { type: "condition", call: "InAttackRange" } });
    const bb = createBlackboard(self);
    bbSet(bb, BB_PERCEPTION_TARGET, { eid: target, dist: 10 });
    stepBehaviourTree(inst, { world, self, bb });
    expect(inst.tree.getState()).toBe(State.SUCCEEDED);
    bbSet(bb, BB_PERCEPTION_TARGET, { eid: target, dist: 99 });
    inst.tree.reset();
    stepBehaviourTree(inst, { world, self, bb });
    expect(inst.tree.getState()).toBe(State.FAILED);
  });

  it("Attack：射程内命中扣血", () => {
    const world = createBareWorld();
    const self = spawnTestEnemy(world, { x: 0, y: 0, attack: { value: 10, range: 30 } });
    const target = spawnTestPlayer(world, { x: 10, y: 0, hp: 100 });
    const inst = makeInstance({ type: "root", child: { type: "action", call: "Attack" } });
    const bb = createBlackboard(self);
    bbSet(bb, BB_PERCEPTION_TARGET, { eid: target, dist: 10 });
    stepBehaviourTree(inst, { world, self, bb });
    expect(Health.current[target]).toBe(90);
  });

  it("Flee：背向目标移动", () => {
    const world = createBareWorld();
    const self = spawnTestEnemy(world, { x: 0, y: 0 });
    const target = spawnTestPlayer(world, { x: 20, y: 0 });
    const inst = makeInstance({ type: "root", child: { type: "action", call: "Flee", args: { speed: 10 } } });
    const bb = createBlackboard(self);
    bbSet(bb, BB_PERCEPTION_TARGET, { eid: target, dist: 20 });
    stepBehaviourTree(inst, { world, self, bb });
    expect(inst.tree.getState()).toBe(State.RUNNING);
    expect(Velocity.vx[self]).toBeLessThan(0);
  });
});

// 战斗闭环集成：感知→追击→攻击→死亡→掉落→重生 整条链在多系统协作下正确运转
describe("Slice 2 集成：战斗闭环", () => {
  it("玩家攻击意图击杀敌人 → 掉落落地", () => {
    const world = createBareWorld();
    setItemKind(world, { kind: "m1", maxStack: 20 });
    const player = spawnTestPlayer(world, { x: 0, y: 0, attack: { value: 50, range: 40 } });
    const enemy = spawnTestEnemy(world, { x: 10, y: 0, hp: 30 });
    LootTable[enemy] = [{ kind: "m1", qty: 1, chance: 1 }];
    Intent[player] = "attack";
    createInteractionSystem({ range: 24 })(world);
    expect(Health.current[enemy]).toBeLessThanOrEqual(0);
    deathSystem(world);
    expect(query(world, [Enemy]).length).toBe(0);
    const items = query(world, [Item]);
    expect(items.length).toBe(1);
    expect(ItemMeta[items[0]]?.kind).toBe("m1");
  });

  it("敌人感知 → BT Attack 击杀玩家 → 重生回出生点", () => {
    const world = createBareWorld();
    world.gameDef.resolvedRules["respawn"] = { delayMs: 0 };
    const player = spawnTestPlayer(world, { x: 20, y: 0, hp: 30 });
    const enemy = spawnTestEnemy(world, {
      x: 0, y: 0, hp: 100,
      attack: { value: 50, range: 40 },
      visionRadius: 100,
    });
    perceptionSystem(world);
    const bb = getOrCreateBlackboard(world, enemy);
    expect(bbGet<PerceivedTarget>(bb, BB_PERCEPTION_TARGET)?.eid).toBe(player);

    const registry = createActionRegistry();
    registerBuiltinActions(registry);
    const inst = createNpcTree({
      type: "root",
      child: {
        type: "sequence",
        children: [
          { type: "condition", call: "IsTargetInVision" },
          { type: "action", call: "Attack" },
        ],
      },
    }, registry);
    stepBehaviourTree(inst, { world, self: enemy, bb });
    expect(Health.current[player]).toBeLessThanOrEqual(0);

    deathSystem(world);
    respawnSystem(world);
    expect(Health.current[player]).toBe(100);
    expect(Transform.x[player]).toBe(0);
    expect(Transform.y[player]).toBe(0);
  });

  it("GameSimulation：applyInputs 把 attack 意图写入 → interactionSystem 路由命中", async () => {
    const gameDef = createDefaultGameDefinition();
    const sim = await createGameSimulation(gameDef);
    const world = (sim as unknown as { world: GameWorld }).world;
    const { networkId } = sim.addPlayer("s1");
    const playerEid = query(world, [Player])[0];
    addComponent(world, playerEid, Attack);
    Attack.value[playerEid] = 50;
    Attack.range[playerEid] = 40;
    const enemy = spawnTestEnemy(world, { x: 10, y: 0, hp: 30 });
    // 跨 world 残留清理：真实 game.json 的 override 会替换全局 player 原型（含 Cooldown），
    // 且 legacy 组件数组全局共享——显式清零防止上一用例残留的冷却拦截本次攻击
    Cooldown.remainingMs[playerEid] = 0;
    sim.submitInput("s1", { seq: 1, moveX: 0, moveY: 0, attack: true });
    sim.tick(50);
    expect(Health.current[enemy]).toBeLessThanOrEqual(0);
  });

  it("集成：真实 aiSystem 全链路——hostile 感知→追击→击杀玩家→死亡标记→重生", () => {
    const gameDef = loadGameDefinition({ gameJsonPath: "game/game.json" });
    gameDef.resolvedSpawns = []; // 确定性：关掉随机生成规则
    // delayMs 2000：死亡与重生跨 tick 分离（0 会在同一 tick 内完成，循环检测不到中间态）
    gameDef.resolvedRules["respawn"] = { delayMs: 2000, resetNeeds: true };
    const instance = createGameInstance(gameDef);
    const world = instance.world;
    const { componentRegistry, archetypeRegistry } = getRegistries();

    // 游戏无关：测试本地注册一个带敌对行为的通用原型，走真实 archetype→behavior→BT 链路
    archetypeRegistry.register({
      kind: "test-hostile",
      tags: ["NPC", "Enemy"],
      components: {
        Size: { w: 20, h: 14 },
        Velocity: {},
        Collider: { shape: 1, halfW: 10, halfH: 7 },
        Health: { current: 60, max: 60 },
        Attack: { value: 8, range: 32 },
        Cooldown: {},
        Perception: { visionRadius: 160, hostilityRange: 80 },
        LootTable: [{ kind: "m1", qty: 1, chance: 1 }],
      },
      behavior: "test-hostile-bt",
      team: 2,
    });
    gameDef.resolvedBehaviors.push({
      id: "test-hostile-bt",
      definition: {
        type: "root",
        child: {
          type: "selector",
          children: [
            {
              type: "sequence",
              children: [
                { type: "condition", call: "IsTargetInVision" },
                { type: "action", call: "Chase", args: { speed: 60 } },
                { type: "condition", call: "InAttackRange" },
                { type: "action", call: "Attack" },
              ],
            },
            { type: "action", call: "Wander", args: { speed: 40 } },
          ],
        },
      },
    });

    const player = spawnEntity(world, archetypeRegistry.get("player"), componentRegistry, { x: 0, y: 0 });
    Health.current[player] = 10; // 快速死亡（hostile 8 dmg/1s）
    const hostile = spawnEntity(world, archetypeRegistry.get("test-hostile"), componentRegistry, { x: 40, y: 0 });
    // 清零 Velocity 残留（legacy 组件数组全局共享，前序用例可能写过同 eid 槽），防玩家/敌漂移出视野
    Velocity.vx[player] = 0;
    Velocity.vy[player] = 0;
    Velocity.vx[hostile] = 0;
    Velocity.vy[hostile] = 0;
    setItemKind(world, { kind: "m1", maxStack: 20 });

    let sawDead = false;
    let sawRespawn = false;
    for (let i = 0; i < 400 && !sawRespawn; i++) {
      instance.step(50);
      if ((Health.current[player] ?? 0) <= 0) sawDead = true;
      if (sawDead && (Health.current[player] ?? 0) > 0) sawRespawn = true;
    }

    expect(sawDead).toBe(true);
    expect(sawRespawn).toBe(true);
    expect(Health.current[player]).toBe(100);
  });
});