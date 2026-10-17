/**
 * 玩法补齐：物品耐久与磨损。
 *
 * 覆盖：
 * - 采集磨损 → 耐久归零破碎 → 槽位清空 + 装备引用失效 + 工具门槛重新拒绝；
 * - 战斗命中磨损武器、受击磨损护甲；
 * - 未装备（仅背包）的工具不磨损；
 * - 无 maxDurability 物品完全不受影响（历史行为零回归）；
 * - durability 随 Inventory/ItemMeta 入档，序列化往返保真；
 * - 真实 game 配置端到端（axe 采集至破碎 → toolType 门槛拒绝）；
 * - 加载期 maxDurability × maxStack / wearPerUse 约束 fail-fast。
 */
import { describe, it, expect, beforeAll } from "vitest";
import { addComponent, addEntity } from "bitecs";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  bootstrapFramework,
  createGameInstance,
  createDefaultGameDefinition,
  loadGameDefinition,
  restoreWorld,
  serializeWorld,
  spawnEntity,
} from "framework/index";
import { Transform } from "framework/components/transform";
import { Health, Attack } from "framework/components/combat";
import { NetworkId } from "framework/components/network";
import { Player, Resource } from "framework/components/tags";
import { Inventory, type InventoryEntry } from "framework/components/inventory";
import { Equipment } from "framework/components/equipment";
import { ResourceNode, type ResourceNodeState } from "framework/components/resourceNode";
import { ItemMeta } from "framework/components/itemMeta";
import { addToInventory, dropSlot } from "framework/systems/gameplay/inventoryOps";
import { inventorySystem } from "framework/systems/gameplay/inventorySystem";
import { harvest } from "framework/systems/gameplay/gatheringSystem";
import { attackTarget } from "framework/systems/gameplay/combatSystem";
import type { GameWorld } from "framework/world";
import type { ItemKindSpec } from "framework/config/schema/ItemKindSchema";
import type { WorldRecord } from "framework/repository";

beforeAll(() => {
  bootstrapFramework();
});

function createBareWorld(): GameWorld {
  return createGameInstance(createDefaultGameDefinition()).world;
}

function setItemKind(world: GameWorld, spec: ItemKindSpec): void {
  world.gameDef.itemsByKind!.set(spec.kind, spec);
}

interface PlayerOpts {
  x?: number;
  y?: number;
  capacity?: number;
  attack?: boolean;
}

/** 手工玩家：Transform/NetworkId/Player/Health + Inventory + 空 Equipment 三槽。 */
function spawnTestPlayer(world: GameWorld, opts: PlayerOpts = {}): number {
  const eid = addEntity(world);
  addComponent(world, eid, Transform);
  addComponent(world, eid, NetworkId);
  addComponent(world, eid, Player);
  addComponent(world, eid, Health);
  Health.current[eid] = 100;
  Health.max[eid] = 100;
  if (opts.attack) {
    addComponent(world, eid, Attack);
    Attack.value[eid] = 10;
  }
  Transform.x[eid] = opts.x ?? 0;
  Transform.y[eid] = opts.y ?? 0;
  const capacity = opts.capacity ?? 6;
  Inventory[eid] = { capacity, slots: Array.from({ length: capacity }, () => null) };
  addComponent(world, eid, Equipment);
  Equipment.weaponSlot[eid] = -1;
  Equipment.toolSlot[eid] = -1;
  Equipment.armorSlot[eid] = -1;
  NetworkId.value[eid] = world.nextNetworkId++;
  return eid;
}

interface NodeOpts {
  remaining?: number;
  yieldsKind?: string;
  requiredToolType?: string;
}

/** 手工资源节点：Resource tag + ResourceNode AoS。 */
function spawnTestResource(world: GameWorld, opts: NodeOpts = {}): number {
  const eid = addEntity(world);
  addComponent(world, eid, Transform);
  addComponent(world, eid, NetworkId);
  addComponent(world, eid, Resource);
  const max = opts.remaining ?? 5;
  ResourceNode[eid] = {
    remaining: max,
    max,
    amountPerHit: 1,
    regenMs: 0,
    yieldsKind: opts.yieldsKind ?? "wood",
    directConsume: false,
    depletedSinceMs: null,
    requiredToolType: opts.requiredToolType,
  } satisfies ResourceNodeState;
  NetworkId.value[eid] = world.nextNetworkId++;
  return eid;
}

/** 入包并返回槽位索引（耐久物品 maxStack 1，必落在第一个空槽）。 */
function addToSlot(world: GameWorld, eid: number, kind: string): number {
  const inv = Inventory[eid]!;
  expect(addToInventory(inv, world.gameDef.itemsByKind, kind, 1)).toBe(0);
  const index = inv.slots.findIndex((slot) => slot?.kind === kind);
  expect(index).toBeGreaterThanOrEqual(0);
  return index;
}

function slotsOfKind(inv: InventoryEntry, kind: string) {
  return inv.slots.filter((slot) => slot?.kind === kind);
}

describe("采集磨损与破碎", () => {
  it("每次采集磨损 tool 槽；耐久归零后清槽、装备引用归 -1、工具门槛拒绝", () => {
    const world = createBareWorld();
    setItemKind(world, {
      kind: "test_axe",
      maxStack: 1,
      maxDurability: 3,
      wearPerUse: 1,
      toolType: "axe",
      equip: { slot: "tool" },
    });
    setItemKind(world, { kind: "wood", maxStack: 50 });
    const player = spawnTestPlayer(world);
    const inv = Inventory[player]!;
    const slot = addToSlot(world, player, "test_axe");
    expect(inv.slots[slot]).toEqual({ kind: "test_axe", count: 1, durability: 3 });
    Equipment.toolSlot[player] = slot;

    const node = spawnTestResource(world, {
      remaining: 5,
      yieldsKind: "wood",
      requiredToolType: "axe",
    });

    expect(harvest(world, player, node)).toBe(true);
    expect(inv.slots[slot]!.durability).toBe(2);
    expect(harvest(world, player, node)).toBe(true);
    expect(inv.slots[slot]!.durability).toBe(1);

    // 第三次：耐久 1 - 1 = 0 → 破碎
    expect(harvest(world, player, node)).toBe(true);
    expect(inv.slots[slot]).toBeNull();
    expect(Equipment.toolSlot[player]).toBe(-1);
    expect(ResourceNode[node]!.remaining).toBe(2);
    expect(world.eventBus.queue.some((evt) => evt.name === "on-item-break")).toBe(true);

    // 破碎后工具门槛重新生效：采集被拒绝且节点不动
    expect(harvest(world, player, node)).toBe(false);
    expect(ResourceNode[node]!.remaining).toBe(2);
  });

  it("低耐久 + 大磨损量：一次使用即破碎", () => {
    const world = createBareWorld();
    setItemKind(world, {
      kind: "fragile_pick",
      maxStack: 1,
      maxDurability: 2,
      wearPerUse: 5,
      toolType: "pickaxe",
      equip: { slot: "tool" },
    });
    setItemKind(world, { kind: "stone", maxStack: 50 });
    const player = spawnTestPlayer(world);
    const slot = addToSlot(world, player, "fragile_pick");
    Equipment.toolSlot[player] = slot;
    const node = spawnTestResource(world, {
      remaining: 3,
      yieldsKind: "stone",
      requiredToolType: "pickaxe",
    });

    expect(harvest(world, player, node)).toBe(true);
    expect(Inventory[player]!.slots[slot]).toBeNull();
    expect(Equipment.toolSlot[player]).toBe(-1);
  });
});

describe("战斗磨损与护甲受击磨损", () => {
  it("武器命中磨损；护甲受击磨损；归零破碎后引用归 -1", () => {
    const world = createBareWorld();
    setItemKind(world, {
      kind: "test_sword",
      maxStack: 1,
      maxDurability: 2,
      wearPerUse: 1,
      equip: { slot: "weapon", attackBonus: 5 },
    });
    setItemKind(world, {
      kind: "test_armor",
      maxStack: 1,
      maxDurability: 2,
      wearPerUse: 1,
      equip: { slot: "armor", defenseBonus: 2 },
    });

    const attacker = spawnTestPlayer(world, { attack: true });
    const weaponSlot = addToSlot(world, attacker, "test_sword");
    Equipment.weaponSlot[attacker] = weaponSlot;

    const target = spawnTestPlayer(world);
    const armorSlot = addToSlot(world, target, "test_armor");
    Equipment.armorSlot[target] = armorSlot;

    expect(attackTarget(world, attacker, target)).toBe(true);
    expect(Inventory[attacker]!.slots[weaponSlot]!.durability).toBe(1);
    expect(Inventory[target]!.slots[armorSlot]!.durability).toBe(1);

    expect(attackTarget(world, attacker, target)).toBe(true);
    expect(Inventory[attacker]!.slots[weaponSlot]).toBeNull();
    expect(Equipment.weaponSlot[attacker]).toBe(-1);
    expect(Inventory[target]!.slots[armorSlot]).toBeNull();
    expect(Equipment.armorSlot[target]).toBe(-1);
  });

  it("无耐久武器/护甲不受影响，仅正常造成伤害", () => {
    const world = createBareWorld();
    setItemKind(world, {
      kind: "plain_sword",
      maxStack: 1,
      equip: { slot: "weapon", attackBonus: 1 },
    });
    setItemKind(world, {
      kind: "plain_armor",
      maxStack: 1,
      equip: { slot: "armor", defenseBonus: 1 },
    });
    const attacker = spawnTestPlayer(world, { attack: true });
    const weaponSlot = addToSlot(world, attacker, "plain_sword");
    Equipment.weaponSlot[attacker] = weaponSlot;
    const target = spawnTestPlayer(world);
    const armorSlot = addToSlot(world, target, "plain_armor");
    Equipment.armorSlot[target] = armorSlot;

    expect(attackTarget(world, attacker, target)).toBe(true);
    expect(Inventory[attacker]!.slots[weaponSlot]).toEqual({ kind: "plain_sword", count: 1 });
    expect(Inventory[target]!.slots[armorSlot]).toEqual({ kind: "plain_armor", count: 1 });
  });
});

describe("未装备与无耐久物品", () => {
  it("只放在背包、未装备到 tool 槽的耐用品不磨损", () => {
    const world = createBareWorld();
    setItemKind(world, {
      kind: "bag_axe",
      maxStack: 1,
      maxDurability: 3,
      wearPerUse: 1,
      toolType: "axe",
      equip: { slot: "tool" },
    });
    setItemKind(world, { kind: "wood", maxStack: 50 });
    const player = spawnTestPlayer(world);
    const slot = addToSlot(world, player, "bag_axe");
    const node = spawnTestResource(world, { remaining: 5, yieldsKind: "wood" });

    expect(harvest(world, player, node)).toBe(true);
    expect(harvest(world, player, node)).toBe(true);
    expect(Inventory[player]!.slots[slot]!.durability).toBe(3);
    expect(Equipment.toolSlot[player]).toBe(-1);
  });

  it("无 maxDurability 的工具可无限使用且槽位不写 durability 字段", () => {
    const world = createBareWorld();
    setItemKind(world, {
      kind: "plain_axe",
      maxStack: 1,
      toolType: "axe",
      equip: { slot: "tool" },
    });
    setItemKind(world, { kind: "wood", maxStack: 50 });
    const player = spawnTestPlayer(world);
    const slot = addToSlot(world, player, "plain_axe");
    Equipment.toolSlot[player] = slot;
    const node = spawnTestResource(world, {
      remaining: 10,
      yieldsKind: "wood",
      requiredToolType: "axe",
    });

    for (let i = 0; i < 5; i++) {
      expect(harvest(world, player, node)).toBe(true);
    }
    expect(Inventory[player]!.slots[slot]).toEqual({ kind: "plain_axe", count: 1 });
    expect(Equipment.toolSlot[player]).toBe(slot);
  });
});

describe("持久化", () => {
  it("durability 随 Inventory 入档，serialize → JSON → restore 往返保真", () => {
    const def = createDefaultGameDefinition();
    def.resolvedEntities = [
      {
        kind: "holder",
        components: {
          Inventory: { capacity: 4 },
          Equipment: { weaponSlot: -1, toolSlot: -1, armorSlot: -1 },
        },
      },
    ];
    def.resolvedItems = [
      { kind: "relic", maxStack: 1, maxDurability: 12, wearPerUse: 1, equip: { slot: "tool" } },
    ];

    const world = createGameInstance(def).world;
    const holder = spawnEntity(world, world.archetypes.get("holder"), world.components_registry);
    Inventory[holder]!.slots[0] = { kind: "relic", count: 1, durability: 7 };
    Equipment.toolSlot[holder] = 0;
    const networkId = NetworkId.value[holder];

    const record = JSON.parse(JSON.stringify(serializeWorld(world, "durability"))) as WorldRecord;

    const world2 = createGameInstance(def).world;
    restoreWorld(world2, record);
    const restored = [...Array(world2.nextNetworkId).keys()].find(
      (eid) => NetworkId.value[eid] === networkId,
    );
    expect(restored).toBeDefined();
    expect(Inventory[restored!]!.slots[0]).toEqual({ kind: "relic", count: 1, durability: 7 });
    expect(Equipment.toolSlot[restored!]).toBe(0);
  });

  it("丢弃再拾取继承剩余耐久（ItemMeta.durability 不重置）", () => {
    const world = createBareWorld();
    setItemKind(world, {
      kind: "relic",
      maxStack: 1,
      maxDurability: 12,
      wearPerUse: 1,
      equip: { slot: "tool" },
    });
    const player = spawnTestPlayer(world);
    Inventory[player]!.slots[0] = { kind: "relic", count: 1, durability: 4 };

    expect(dropSlot(world, player, 0)).toBe(true);
    const ground = ItemMeta.findIndex((meta) => meta?.kind === "relic");
    expect(ground).toBeGreaterThanOrEqual(0);
    expect(ItemMeta[ground]!.durability).toBe(4);

    // 走到掉落物位置并越过防瞬拾延迟 → 自动拾取回背包
    Transform.x[player] = Transform.x[ground];
    Transform.y[player] = Transform.y[ground];
    world.time.tick = 50; // now = 2500ms > pickupAfterMs(1000)
    inventorySystem(world);

    expect(Inventory[player]!.slots[0]).toEqual({ kind: "relic", count: 1, durability: 4 });
    expect(ItemMeta[ground]).toBeUndefined();
  });
});

describe("真实配置端到端", () => {
  const def = loadGameDefinition({ gameJsonPath: "game/game.json" });

  it("axe/pickaxe/spear/stone_axe 均声明 maxDurability 与磨损量", () => {
    for (const kind of ["axe", "pickaxe", "spear", "stone_axe"]) {
      const spec = def.resolvedItems.find((item) => item.kind === kind)!;
      expect(spec.maxDurability, kind).toBeGreaterThan(0);
      expect(spec.wearPerUse, kind).toBeGreaterThan(0);
      expect(spec.maxStack ?? 1, kind).toBe(1);
    }
  });

  it("真实 axe 采集至破碎：槽位清空、引用归 -1，随后 axe 门槛拒绝采集", () => {
    const world = createGameInstance(def).world;
    const player = spawnEntity(
      world,
      world.archetypes.get("player"),
      world.components_registry,
    );
    const inv = Inventory[player]!;
    expect(addToInventory(inv, def.itemsByKind, "axe", 1)).toBe(0);
    const axeIndex = inv.slots.findIndex((slot) => slot?.kind === "axe");
    const axe = def.itemsByKind!.get("axe")!;
    expect(inv.slots[axeIndex]!.durability).toBe(axe.maxDurability);
    Equipment.toolSlot[player] = axeIndex;

    const tree = spawnEntity(world, world.archetypes.get("tree"), world.components_registry);
    const maxUses = axe.maxDurability!;
    for (let i = 0; i < maxUses; i++) {
      // 每次补满节点，只考察工具磨损（不触发 regen 路径）
      ResourceNode[tree]!.remaining = 1;
      ResourceNode[tree]!.depletedSinceMs = null;
      expect(harvest(world, player, tree), `harvest #${i + 1}`).toBe(true);
    }

    expect(inv.slots[axeIndex]).toBeNull();
    expect(Equipment.toolSlot[player]).toBe(-1);
    expect(slotsOfKind(inv, "axe")).toHaveLength(0);

    // 工具门槛联动：无 axe 后该树不可采，节点剩余不变
    ResourceNode[tree]!.remaining = 1;
    ResourceNode[tree]!.depletedSinceMs = null;
    expect(harvest(world, player, tree)).toBe(false);
    expect(ResourceNode[tree]!.remaining).toBe(1);
  });
});

describe("加载期校验", () => {
  function withItemsDir(files: Record<string, unknown>, run: (gameJsonPath: string) => void): void {
    const dir = mkdtempSync(join(tmpdir(), "durability-items-"));
    try {
      writeFileSync(
        join(dir, "game.json"),
        JSON.stringify({
          id: "durability-test",
          tickRate: 20,
          world: { tile: { width: 16, height: 16 } },
          items: "./items/*.json",
        }),
      );
      mkdirSync(join(dir, "items"));
      for (const [name, content] of Object.entries(files)) {
        writeFileSync(join(dir, "items", name), JSON.stringify(content));
      }
      run(join(dir, "game.json"));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  it("maxDurability 与 maxStack != 1 冲突 → 加载期抛错", () => {
    withItemsDir(
      { "bad.json": { kind: "bad", maxStack: 2, maxDurability: 10 } },
      (gameJsonPath) => {
        expect(() => loadGameDefinition({ gameJsonPath })).toThrow(/maxDurability but maxStack 2/);
      },
    );
  });

  it("wearPerUse 缺少 maxDurability → 加载期抛错", () => {
    withItemsDir(
      { "bad.json": { kind: "bad", maxStack: 1, wearPerUse: 2 } },
      (gameJsonPath) => {
        expect(() => loadGameDefinition({ gameJsonPath })).toThrow(/wearPerUse without maxDurability/);
      },
    );
  });

  it("合法组合（maxStack 1 + maxDurability + wearPerUse）正常加载", () => {
    withItemsDir(
      { "good.json": { kind: "good", maxStack: 1, maxDurability: 10, wearPerUse: 2 } },
      (gameJsonPath) => {
        const loaded = loadGameDefinition({ gameJsonPath });
        expect(loaded.resolvedItems).toHaveLength(1);
        expect(loaded.resolvedItems[0]).toMatchObject({
          kind: "good",
          maxDurability: 10,
          wearPerUse: 2,
        });
      },
    );
  });
});
