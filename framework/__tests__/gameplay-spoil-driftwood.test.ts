/**
 * 玩法补齐：食物腐烂 + 漂流木保底。
 *
 * 覆盖：
 * - 地面掉落物按 kind.spoilTicks 到期转换（保留数量）或消失；
 * - 背包/容器堆叠按绝对 spoilAt 到期转换（整堆最早到期）；
 * - 不腐烂物品不受影响；
 * - 读档 + advanceTickTo 离线补差越过 spoilAt 后正确腐烂；
 * - 确定性（重复运行一致）；
 * - 真实 game 配置：rotten 物品、生/熟肉/浆果腐烂参数、漂流木无门槛采 wood。
 */
import { describe, it, expect, beforeAll, afterEach, vi } from "vitest";
import { addComponent, addEntity, hasComponent } from "bitecs";
import {
  bootstrapFramework,
  createDefaultGameDefinition,
  createGameInstance,
  createGameSimulation,
  loadGameDefinition,
  serializeWorld,
  spawnEntity,
  type SimulationPort,
} from "framework/index";
import { Transform } from "framework/components/transform";
import { Player, Item, Resource } from "framework/components/tags";
import { Inventory } from "framework/components/inventory";
import { ItemMeta } from "framework/components/itemMeta";
import { NetworkId } from "framework/components/network";
import { ResourceNode } from "framework/components/resourceNode";
import { addToInventory, dropSlot, spawnDroppedItem } from "framework/systems/gameplay/inventoryOps";
import { harvest } from "framework/systems/gameplay/gatheringSystem";
import { mergeSpoilAt, spoilSystem } from "framework/systems/gameplay/spoilSystem";
import { memoryRepository } from "./helpers/persistence";
import type { GameWorld } from "framework/world";
import type { ItemKindSpec } from "framework/config/schema/ItemKindSchema";
import type { LoadedGameDefinition } from "framework/config/schema/GameDefinitionSchema";
import type { WorldRecord } from "framework/repository";

beforeAll(() => {
  bootstrapFramework();
});

afterEach(() => {
  vi.useRealTimers();
});

function createBareWorld(): GameWorld {
  return createGameInstance(createDefaultGameDefinition()).world;
}

function setItemKind(world: GameWorld, spec: ItemKindSpec): void {
  world.gameDef.itemsByKind!.set(spec.kind, spec);
}

/** 手工玩家：Transform + Player + NetworkId + Inventory（dropSlot 需要 Transform）。 */
function spawnTestPlayer(world: GameWorld, capacity = 4): number {
  const eid = addEntity(world);
  addComponent(world, eid, Transform);
  addComponent(world, eid, NetworkId);
  addComponent(world, eid, Player);
  Inventory[eid] = { capacity, slots: Array.from({ length: capacity }, () => null) };
  NetworkId.value[eid] = world.nextNetworkId++;
  return eid;
}

function registerBasics(world: GameWorld): void {
  setItemKind(world, { kind: "food", maxStack: 20, spoilTicks: 10, spoilInto: "rotten" });
  setItemKind(world, { kind: "rotten", maxStack: 20 });
  setItemKind(world, { kind: "leaf", maxStack: 20, spoilTicks: 5 });
  setItemKind(world, { kind: "stable", maxStack: 20, spoilTicks: 0 });
}

describe("食物腐烂：地面掉落物", () => {
  it("到期转换为 spoilInto 并保留数量（spawn 时写入绝对 spoilAt）", () => {
    const world = createBareWorld();
    registerBasics(world);
    world.time.tick = 100;

    const eid = spawnDroppedItem(world, { kind: "food", count: 3 }, 100, 100, 0, world.defaultMapId, 42);
    expect(ItemMeta[eid]!.spoilAt).toBe(110);
    expect(ItemMeta[eid]!.count).toBe(3);

    world.time.tick = 109;
    spoilSystem(world);
    expect(ItemMeta[eid]!.kind).toBe("food");

    world.time.tick = 110;
    spoilSystem(world);
    expect(ItemMeta[eid]!.kind).toBe("rotten");
    expect(ItemMeta[eid]!.count).toBe(3);
    // rotten 不声明 spoilTicks → 转换后不再计时
    expect(ItemMeta[eid]!.spoilAt).toBeUndefined();
  });

  it("未声明 spoilInto 时到期直接消失", () => {
    const world = createBareWorld();
    registerBasics(world);
    world.time.tick = 0;
    const eid = spawnDroppedItem(world, { kind: "leaf", count: 2 }, 100, 100, 0, world.defaultMapId);
    expect(ItemMeta[eid]!.spoilAt).toBe(5);

    world.time.tick = 5;
    spoilSystem(world);
    expect(hasComponent(world, eid, Item)).toBe(false);
    expect(ItemMeta[eid]).toBeUndefined();
  });
});

describe("食物腐烂：背包堆叠", () => {
  it("按整堆最早 spoilAt 到期转换，数量保留", () => {
    const world = createBareWorld();
    registerBasics(world);
    const player = spawnTestPlayer(world);
    const inv = Inventory[player]!;
    inv.slots[0] = { kind: "food", count: 4, spoilAt: 30 };
    world.time.tick = 30;

    spoilSystem(world);
    expect(inv.slots[0]).toEqual({ kind: "rotten", count: 4, spoilAt: undefined });
  });

  it("同 kind 合并取最早到期；入包时按 kind 写入 spoilAt", () => {
    const world = createBareWorld();
    registerBasics(world);
    const player = spawnTestPlayer(world);
    const inv = Inventory[player]!;

    // 先入一批（tick 1000 → spoilAt 1010）
    expect(addToInventory(inv, world.gameDef.itemsByKind, "food", 2, { nowTick: 1000 })).toBe(0);
    expect(inv.slots[0]).toEqual({ kind: "food", count: 2, spoilAt: 1010 });

    // 再入一批更早到期的（spoilAt 1005）→ 整堆取最早
    expect(addToInventory(inv, world.gameDef.itemsByKind, "food", 1, { spoilAt: 1005 })).toBe(0);
    expect(inv.slots[0]!.count).toBe(3);
    expect(inv.slots[0]!.spoilAt).toBe(1005);
    expect(mergeSpoilAt(undefined, 5)).toBe(5);
  });

  it("丢弃时继承剩余 spoilAt，不会重置腐烂计时", () => {
    const world = createBareWorld();
    registerBasics(world);
    const player = spawnTestPlayer(world);
    const inv = Inventory[player]!;
    inv.slots[0] = { kind: "food", count: 1, spoilAt: 55 };
    world.time.tick = 40;

    expect(dropSlot(world, player, 0)).toBe(true);
    let groundEid: number | undefined;
    for (let eid = 0; eid < ItemMeta.length; eid++) {
      if (ItemMeta[eid]) groundEid = eid;
    }
    expect(groundEid).toBeDefined();
    expect(ItemMeta[groundEid!]!.spoilAt).toBe(55);
  });
});

describe("食物腐烂：不腐烂物品零影响", () => {
  it("spoilTicks 缺省/0 的地面物与背包堆叠保持原样（即便残留 spoilAt）", () => {
    const world = createBareWorld();
    registerBasics(world);
    const player = spawnTestPlayer(world);
    const inv = Inventory[player]!;
    inv.slots[0] = { kind: "stable", count: 2, spoilAt: 1 };
    inv.slots[1] = { kind: "stable", count: 3 };

    const ground = spawnDroppedItem(world, { kind: "stable", count: 2 }, 0, 0, 0, world.defaultMapId);
    world.time.tick = 100;
    spoilSystem(world);

    expect(inv.slots[0]).toEqual({ kind: "stable", count: 2, spoilAt: 1 });
    expect(inv.slots[1]).toEqual({ kind: "stable", count: 3 });
    expect(ItemMeta[ground]!.kind).toBe("stable");
    expect(ItemMeta[ground]!.count).toBe(2);
  });
});

/** 合成定义：最小 holder 原型（Inventory）+ inventory/spoil 系统，无地图。 */
function buildSpoilDef(): LoadedGameDefinition {
  const def = createDefaultGameDefinition();
  def.systems = [{ id: "inventory" }, { id: "spoil" }];
  def.resolvedEntities = [
    { kind: "holder", components: { Inventory: { capacity: 4 } } },
  ];
  def.resolvedItems = [
    { kind: "food", maxStack: 20, spoilTicks: 20, spoilInto: "rotten" },
    { kind: "rotten", maxStack: 20 },
  ];
  return def;
}

describe("食物腐烂：读档 + 离线补差", () => {
  it("存档时未过期 → advanceTickTo 越过 spoilAt → 下一 tick 正确腐烂", async () => {
    const def = buildSpoilDef();
    const SAVED_TICK = 1000;
    const SPOIL_AT = 1020;

    const seedWorld = createGameInstance(def).world;
    seedWorld.time.tick = SAVED_TICK;
    const holder = spawnEntity(
      seedWorld,
      seedWorld.archetypes.get("holder"),
      seedWorld.components_registry,
    );
    Inventory[holder]!.slots[0] = { kind: "food", count: 5, spoilAt: SPOIL_AT };
    const ground = spawnDroppedItem(seedWorld, { kind: "food", count: 2, spoilAt: SPOIL_AT }, 0, 0, 0, "");

    const record: WorldRecord = serializeWorld(seedWorld, "offline-spoil");
    const baseWall = 1_000_000;
    record.savedAt = baseWall;

    // 离线 2s @20tps = 40 tick → 越过 SPOIL_AT
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(baseWall + 2000);
    const sim: SimulationPort = await createGameSimulation(def, {
      repository: memoryRepository(record),
      saveId: "offline-spoil",
    });
    vi.useRealTimers();

    const world = (sim as unknown as { world: GameWorld }).world;
    expect(world.time.tick).toBe(SAVED_TICK + 40);
    const restored = Inventory.find((entry) => entry && entry.slots[0]?.kind === "food");
    expect(restored).toBeDefined();
    expect(restored!.slots[0]!.spoilAt).toBe(SPOIL_AT);

    // 离线补差只推进时钟；下一运行 tick 的系统扫描结算腐烂
    sim.tick(1000 / 20);
    const after = Inventory.find((entry) => entry && entry.slots[0] !== null);
    expect(after!.slots[0]).toEqual({ kind: "rotten", count: 5, spoilAt: undefined });

    // 地面掉落物同样按绝对 tick 跨离线结算（ItemMeta 随存档恢复）
    const groundAfter = ItemMeta.find((meta) => meta !== undefined);
    expect(groundAfter?.kind).toBe("rotten");
    expect(groundAfter?.count).toBe(2);
    expect(hasComponent(world, ground, Item)).toBe(true);
  });
});

describe("食物腐烂：确定性", () => {
  it("同一初始状态下重复运行结果一致", () => {
    const run = () => {
      const world = createBareWorld();
      registerBasics(world);
      const player = spawnTestPlayer(world);
      Inventory[player]!.slots[0] = { kind: "food", count: 3, spoilAt: 10 };
      Inventory[player]!.slots[1] = { kind: "leaf", count: 2, spoilAt: 5 };
      world.time.tick = 10;
      spoilSystem(world);
      return {
        slot0: Inventory[player]!.slots[0],
        slot1: Inventory[player]!.slots[1],
      };
    };

    expect(run()).toEqual(run());
  });
});

describe("漂流木保底", () => {
  const def = loadGameDefinition({ gameJsonPath: "game/game.json" });

  it("beach 生态配置含无工具门槛 driftwood，产物 wood", () => {
    const driftwood = def.resolvedEntities.find((e) => e.kind === "driftwood");
    expect(driftwood).toBeDefined();
    const node = driftwood!.components["ResourceNode"] as Record<string, unknown>;
    expect(node.requiredToolType).toBeUndefined();
    expect(node.yieldsKind).toBe("wood");
    expect(node.regenMs).toBe(600000);

    const beach = def.resolvedEcosystems?.ecosystems.find((e) => e.biome === "beach");
    expect(beach?.spawnTable.some((e) => e.kind === "driftwood")).toBe(true);

    // 真实物品内容：生肉/熟肉/浆果腐烂且熟肉更耐放；rotten 存在
    const raw = def.resolvedItems.find((i) => i.kind === "raw_meat")!;
    const cooked = def.resolvedItems.find((i) => i.kind === "cooked_meat")!;
    const berry = def.resolvedItems.find((i) => i.kind === "berry")!;
    const rotten = def.resolvedItems.find((i) => i.kind === "rotten")!;
    expect(raw.spoilInto).toBe("rotten");
    expect(cooked.spoilInto).toBe("rotten");
    expect(berry.spoilInto).toBe("rotten");
    expect(cooked.spoilTicks!).toBeGreaterThan(raw.spoilTicks!);
    expect(rotten.consume?.[0]?.amount).toBe(5);
    expect(rotten.effects?.some((e) => e.name === "apply-status")).toBe(true);
  });

  it("徒手（无工具）可采且产出 wood", () => {
    const world = createBareWorld();
    setItemKind(world, { kind: "wood", maxStack: 50 });
    setItemKind(world, { kind: "twig", maxStack: 50 });

    const driftwoodSpec = def.resolvedEntities.find((e) => e.kind === "driftwood")!;
    world.archetypes.override(driftwoodSpec);
    const node = spawnEntity(world, world.archetypes.get("driftwood"), world.components_registry);

    const player = spawnTestPlayer(world, 6);
    expect(ResourceNode[node]!.requiredToolType).toBeUndefined();
    expect(hasComponent(world, node, Resource)).toBe(true);

    expect(harvest(world, player, node)).toBe(true);
    const wood = Inventory[player]!.slots.reduce(
      (sum, slot) => (slot && slot.kind === "wood" ? sum + slot.count : sum),
      0,
    );
    expect(wood).toBe(1);
    expect(ResourceNode[node]!.remaining).toBe(1);
  });
});
