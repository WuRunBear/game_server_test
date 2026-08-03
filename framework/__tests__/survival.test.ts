import { describe, it, expect, beforeAll } from "vitest";
import { addComponent, addEntity, hasComponent, query } from "bitecs";
import {
  bootstrapFramework,
  createGameInstance,
  createGameSimulation,
  createDefaultGameDefinition,
  loadGameDefinition,
  spawnEntity,
  getRegistries,
} from "framework/index";
import { Transform } from "framework/components/transform";
import { Size } from "framework/components/size";
import { Health } from "framework/components/combat";
import { NetworkId } from "framework/components/network";
import { Player, Resource, Item } from "framework/components/tags";
import { Inventory, type InventoryEntry } from "framework/components/inventory";
import { ItemMeta } from "framework/components/itemMeta";
import { Needs, type Need } from "framework/components/needs";
import { ResourceNode } from "framework/components/resourceNode";
import { Intent } from "framework/components/intent";
import { needDecaySystem } from "framework/systems/gameplay/needDecaySystem";
import { inventorySystem } from "framework/systems/gameplay/inventorySystem";
import { harvest } from "framework/systems/gameplay/gatheringSystem";
import { createInteractionSystem } from "framework/systems/gameplay/interactionSystem";
import {
  addToInventory,
  consumeSlot,
  dropSlot,
  transferSlot,
} from "framework/systems/gameplay/inventoryOps";
import { setEntityKind } from "framework/systems/gameplay/aiSystem";
import type { GameWorld } from "framework/world";
import type { ItemKindSpec } from "framework/config/schema/ItemKindSchema";

beforeAll(() => {
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
}

/** 手工 spawn 测试玩家：写 Player/Health/Transform + Inventory/Needs AoS。 */
function spawnTestPlayer(world: GameWorld, opts: PlayerOpts = {}): number {
  const eid = addEntity(world);
  addComponent(world, eid, Transform);
  addComponent(world, eid, NetworkId);
  addComponent(world, eid, Player);
  addComponent(world, eid, Health);
  Transform.x[eid] = opts.x ?? 0;
  Transform.y[eid] = opts.y ?? 0;
  Health.current[eid] = opts.hp ?? 100;
  Health.max[eid] = 100;
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

  it("归零时扣 Health；Health≤0 移除实体", () => {
    const world = createBareWorld();
    const player = spawnTestPlayer(world, {
      hp: 50,
      needs: [{ name: "n1", current: 0, max: 100, decayPerSec: 0, starveDmg: 200 }],
    });
    world.time.dtMs = 1000;
    needDecaySystem(world);
    expect(Health.current[player]).toBeLessThanOrEqual(0);
    expect(query(world, [Player]).length).toBe(0);
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
});

describe("netSync：OR 语义 + AoS 适配（用真实 game 配置的 netSync 接线）", () => {
  it("仅 Transform+Size 的 item 实体对快照可见（OR 语义修旧 AND-query 缺陷）", () => {
    const { componentRegistry, archetypeRegistry } = getRegistries();
    const gameDef = loadGameDefinition({ gameJsonPath: "game/game.json" });
    const sim = createGameSimulation(gameDef);
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

  it("玩家 Needs/Inventory 通过 AoS 适配展平为 strings + numbers", () => {
    const gameDef = loadGameDefinition({ gameJsonPath: "game/game.json" });
    const sim = createGameSimulation(gameDef);
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

  it("路径 B：不补给 → 饿死移除", () => {
    const world = createBareWorld();
    const player = spawnTestPlayer(world, {
      hp: 50,
      needs: [{ name: "n1", current: 0, max: 100, decayPerSec: 0, starveDmg: 200 },
              { name: "n2", current: 0, max: 100, decayPerSec: 0, starveDmg: 200 }],
    });
    world.time.dtMs = 1000;
    let alive = true;
    for (let i = 0; i < 100 && alive; i++) {
      needDecaySystem(world);
      if (query(world, [Player]).length === 0) alive = false;
    }
    expect(alive).toBe(false);
  });
});