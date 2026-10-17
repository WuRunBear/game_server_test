/**
 * 玩法补齐：采集工具门槛 + 采集掉落表化。
 *
 * 覆盖：
 * - 无门槛节点徒手可采（历史行为零回归）；
 * - requiredToolType 不满足时 harvest 拒绝，interaction 路由跳过该节点；
 * - tool 槽装备声明同 toolType 的物品后可采（错误工具拒绝）；
 * - lootTable 多产物 + 概率掷骰确定性（同 tick/实体重复运行一致），
 *   配置 lootTable 时取代 yieldsKind 单产物路径；
 * - 满包/部分溢出语义沿用既有 harvest；
 * - ResourceNode 新字段随 AoS 入档并 restoreWorld 往返；
 * - 真实 game 配置内容接线（tree/gold_rock/berry_bush + 工具物品）。
 */
import { describe, it, expect, beforeAll } from "vitest";
import { addComponent, addEntity, query } from "bitecs";
import {
  bootstrapFramework,
  createGameInstance,
  createDefaultGameDefinition,
  loadGameDefinition,
  serializeWorld,
  restoreWorld,
  spawnEntity,
} from "framework/index";
import { Transform } from "framework/components/transform";
import { Health } from "framework/components/combat";
import { NetworkId } from "framework/components/network";
import { Player, Resource } from "framework/components/tags";
import { Inventory, type InventoryEntry } from "framework/components/inventory";
import { Equipment } from "framework/components/equipment";
import { ResourceNode, type ResourceNodeState } from "framework/components/resourceNode";
import { Intent } from "framework/components/intent";
import { harvest } from "framework/systems/gameplay/gatheringSystem";
import { createInteractionSystem } from "framework/systems/gameplay/interactionSystem";
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
}

/** 手工 spawn 测试玩家：Player/Health/Transform + Inventory + 空 Equipment 三槽。 */
function spawnTestPlayer(world: GameWorld, opts: PlayerOpts = {}): number {
  const eid = addEntity(world);
  addComponent(world, eid, Transform);
  addComponent(world, eid, NetworkId);
  addComponent(world, eid, Player);
  addComponent(world, eid, Health);
  Health.current[eid] = 100;
  Health.max[eid] = 100;
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
  x?: number;
  y?: number;
  remaining?: number;
  max?: number;
  amountPerHit?: number;
  yieldsKind?: string;
  requiredToolType?: string;
  lootTable?: ResourceNodeState["lootTable"];
}

/** 手工 spawn 测试资源节点：Resource tag + ResourceNode AoS。 */
function spawnTestResource(world: GameWorld, opts: NodeOpts = {}): number {
  const eid = addEntity(world);
  addComponent(world, eid, Transform);
  addComponent(world, eid, NetworkId);
  addComponent(world, eid, Resource);
  Transform.x[eid] = opts.x ?? 0;
  Transform.y[eid] = opts.y ?? 0;
  const max = opts.max ?? opts.remaining ?? 5;
  ResourceNode[eid] = {
    remaining: opts.remaining ?? max,
    max,
    amountPerHit: opts.amountPerHit ?? 1,
    regenMs: 0,
    yieldsKind: opts.yieldsKind ?? "wood",
    directConsume: false,
    depletedSinceMs: null,
    requiredToolType: opts.requiredToolType,
    lootTable: opts.lootTable,
  };
  NetworkId.value[eid] = world.nextNetworkId++;
  return eid;
}

/** 把 kind 物品放进背包 0 号槽并装备到 tool 槽（同时注册 item kind）。 */
function equipTool(
  world: GameWorld,
  playerEid: number,
  kind: string,
  toolType: string,
  gatherMult = 1,
): void {
  setItemKind(world, {
    kind,
    maxStack: 1,
    toolType,
    equip: { slot: "tool", gatherMult },
  });
  Inventory[playerEid]!.slots[0] = { kind, count: 1 };
  Equipment.toolSlot[playerEid] = 0;
}

function countOf(inv: InventoryEntry, kind: string): number {
  return inv.slots.reduce((sum, slot) => (slot && slot.kind === kind ? sum + slot.count : sum), 0);
}

function countsByKind(inv: InventoryEntry): Record<string, number> {
  const out: Record<string, number> = {};
  for (const slot of inv.slots) {
    if (!slot) continue;
    out[slot.kind] = (out[slot.kind] ?? 0) + slot.count;
  }
  return out;
}

describe("采集工具门槛", () => {
  it("无门槛节点徒手可采（历史行为零回归）", () => {
    const world = createBareWorld();
    setItemKind(world, { kind: "wood", maxStack: 50 });
    const player = spawnTestPlayer(world);
    const node = spawnTestResource(world, { remaining: 5, yieldsKind: "wood" });

    expect(harvest(world, player, node)).toBe(true);
    expect(ResourceNode[node]!.remaining).toBe(4);
    expect(countOf(Inventory[player]!, "wood")).toBe(1);
  });

  it("门槛不满足：harvest 拒绝且节点不动", () => {
    const world = createBareWorld();
    setItemKind(world, { kind: "wood", maxStack: 50 });
    const player = spawnTestPlayer(world);
    const node = spawnTestResource(world, {
      remaining: 5,
      yieldsKind: "wood",
      requiredToolType: "axe",
    });

    expect(harvest(world, player, node)).toBe(false);
    expect(ResourceNode[node]!.remaining).toBe(5);
    expect(countOf(Inventory[player]!, "wood")).toBe(0);
  });

  it("装备同 toolType 的工具后可采；错误工具/错误槽位拒绝", () => {
    const world = createBareWorld();
    setItemKind(world, { kind: "wood", maxStack: 50 });
    const player = spawnTestPlayer(world);
    const node = spawnTestResource(world, {
      remaining: 5,
      yieldsKind: "wood",
      requiredToolType: "axe",
    });

    // 错误工具（pickaxe 对 axe 门槛）→ 拒绝
    equipTool(world, player, "test_pick", "pickaxe");
    expect(harvest(world, player, node)).toBe(false);
    expect(ResourceNode[node]!.remaining).toBe(5);

    // 正确工具（tool 槽 + 同 toolType）→ 可采，且 gatherMult 照常放大产出
    equipTool(world, player, "test_axe", "axe", 2);
    expect(harvest(world, player, node)).toBe(true);
    expect(ResourceNode[node]!.remaining).toBe(4);
    expect(countOf(Inventory[player]!, "wood")).toBe(2);
  });

  it("工具只在背包/武器槽、未装备到 tool 槽 → 仍拒绝", () => {
    const world = createBareWorld();
    setItemKind(world, { kind: "wood", maxStack: 50 });
    setItemKind(world, {
      kind: "loose_axe",
      maxStack: 1,
      toolType: "axe",
      equip: { slot: "tool" },
    });
    const player = spawnTestPlayer(world);
    Inventory[player]!.slots[0] = { kind: "loose_axe", count: 1 };
    const node = spawnTestResource(world, {
      remaining: 5,
      yieldsKind: "wood",
      requiredToolType: "axe",
    });

    expect(harvest(world, player, node)).toBe(false);
    expect(ResourceNode[node]!.remaining).toBe(5);
  });

  it("interaction 路由跳过工具不满足的最近节点，改采次近可采节点", () => {
    const world = createBareWorld();
    setItemKind(world, { kind: "wood", maxStack: 50 });
    const player = spawnTestPlayer(world, { x: 0, y: 0 });
    const gated = spawnTestResource(world, {
      x: 5,
      y: 0,
      remaining: 5,
      yieldsKind: "wood",
      requiredToolType: "axe",
    });
    const open = spawnTestResource(world, { x: 10, y: 0, remaining: 5, yieldsKind: "wood" });

    Intent[player] = "interact";
    createInteractionSystem({ range: 24 })(world);

    expect(Intent[player]).toBe(null);
    expect(ResourceNode[gated]!.remaining).toBe(5); // 最近的被跳过，不动
    expect(ResourceNode[open]!.remaining).toBe(4); // 次近的可采 → 采到
  });

  it("范围内只有工具不满足的节点 → 不采集", () => {
    const world = createBareWorld();
    setItemKind(world, { kind: "wood", maxStack: 50 });
    const player = spawnTestPlayer(world, { x: 0, y: 0 });
    const gated = spawnTestResource(world, {
      x: 5,
      y: 0,
      remaining: 5,
      yieldsKind: "wood",
      requiredToolType: "axe",
    });

    Intent[player] = "interact";
    createInteractionSystem({ range: 24 })(world);

    expect(Intent[player]).toBe(null);
    expect(ResourceNode[gated]!.remaining).toBe(5);
    expect(countOf(Inventory[player]!, "wood")).toBe(0);
  });
});

describe("采集掉落表化", () => {
  it("多产物按概率掷骰：guaranteed / 0 概率 / 0.5 概率；同 tick 同实体重跑结果一致", () => {
    const world = createBareWorld();
    world.time.tick = 123;
    setItemKind(world, { kind: "wood", maxStack: 50 });
    setItemKind(world, { kind: "twig", maxStack: 50 });
    setItemKind(world, { kind: "sap", maxStack: 10 });
    const player = spawnTestPlayer(world, { capacity: 8 });
    const node = spawnTestResource(world, {
      remaining: 5,
      // 掉落表配置时应取代 yieldsKind：这个 kind 未注册且不应产出
      yieldsKind: "ghost_kind",
      lootTable: [
        { kind: "wood", qty: 1, chance: 1 },
        { kind: "twig", qty: 1, chance: 0.5 },
        { kind: "sap", qty: 1, chance: 0 },
      ],
    });

    expect(harvest(world, player, node)).toBe(true);
    const first = countsByKind(Inventory[player]!);
    expect(first["wood"]).toBe(1); // chance 1 必出
    expect(first["sap"]).toBeUndefined(); // chance 0 必不出
    expect(first["ghost_kind"]).toBeUndefined(); // 不回退 yieldsKind

    // 同 tick / 同玩家 / 同节点：重置背包与节点后重跑 → 掷骰序列完全一致
    Inventory[player]!.slots.fill(null);
    ResourceNode[node]!.remaining = 5;
    ResourceNode[node]!.depletedSinceMs = null;
    expect(harvest(world, player, node)).toBe(true);
    expect(countsByKind(Inventory[player]!)).toEqual(first);
  });

  it("掉落表产出同样受 gatherMult 放大（门槛与效率正交）", () => {
    const world = createBareWorld();
    setItemKind(world, { kind: "wood", maxStack: 50 });
    setItemKind(world, { kind: "twig", maxStack: 50 });
    const player = spawnTestPlayer(world, { capacity: 8 });
    equipTool(world, player, "test_axe", "axe", 2);
    const node = spawnTestResource(world, {
      remaining: 5,
      requiredToolType: "axe",
      lootTable: [
        { kind: "wood", qty: 1, chance: 1 },
        { kind: "twig", qty: 2, chance: 0 },
      ],
    });

    expect(harvest(world, player, node)).toBe(true);
    expect(countOf(Inventory[player]!, "wood")).toBe(2); // qty 1 × gatherMult 2
    expect(countOf(Inventory[player]!, "twig")).toBe(0);
    expect(ResourceNode[node]!.remaining).toBe(4);
  });

  it("满包：掉落表产物一点也未入 → 拒绝且不动节点", () => {
    const world = createBareWorld();
    setItemKind(world, { kind: "wood", maxStack: 1 });
    const player = spawnTestPlayer(world, { capacity: 1 });
    Inventory[player]!.slots[0] = { kind: "wood", count: 1 };
    const node = spawnTestResource(world, {
      remaining: 5,
      lootTable: [{ kind: "wood", qty: 1, chance: 1 }],
    });

    expect(harvest(world, player, node)).toBe(false);
    expect(ResourceNode[node]!.remaining).toBe(5);
  });

  it("部分入包：剩余按既有语义落地面 item", () => {
    const world = createBareWorld();
    setItemKind(world, { kind: "wood", maxStack: 1 });
    const player = spawnTestPlayer(world, { capacity: 2 });
    Inventory[player]!.slots[0] = { kind: "wood", count: 1 };
    const node = spawnTestResource(world, {
      remaining: 5,
      lootTable: [{ kind: "wood", qty: 2, chance: 1 }],
    });
    const itemsBefore = query(world, [NetworkId]).length;

    expect(harvest(world, player, node)).toBe(true);
    expect(Inventory[player]!.slots[1]).toEqual({ kind: "wood", count: 1 });
    // 溢出 1 个 → 多出一个地面 item 实体
    expect(query(world, [NetworkId]).length).toBe(itemsBefore + 1);
    expect(ResourceNode[node]!.remaining).toBe(4);
  });
});

describe("ResourceNode 新字段持久化 / 真实配置接线", () => {
  it("requiredToolType/lootTable 随 AoS 入档并 restoreWorld 往返", () => {
    const def = loadGameDefinition({ gameJsonPath: "game/game.json" });
    const world = createGameInstance(def).world;
    const treeArch = world.archetypes.get("tree");
    expect(treeArch).toBeDefined();
    const eid = spawnEntity(world, treeArch!, world.components_registry);

    // 模拟运行时状态（存档值胜出）
    const node = ResourceNode[eid]!;
    node.remaining = 2;
    node.requiredToolType = "test_tool";
    node.lootTable = [
      { kind: "loot_a", qty: 3, chance: 0.25 },
      { kind: "loot_b", qty: 1, chance: 1 },
    ];
    const networkId = NetworkId.value[eid];

    const record = JSON.parse(JSON.stringify(serializeWorld(world, "rt"))) as WorldRecord;

    const world2 = createGameInstance(def).world;
    restoreWorld(world2, record);
    const restoredEid = query(world2, [NetworkId]).find((e) => NetworkId.value[e] === networkId);
    expect(restoredEid).toBeDefined();
    expect(ResourceNode[restoredEid!]).toMatchObject({
      remaining: 2,
      requiredToolType: "test_tool",
      lootTable: [
        { kind: "loot_a", qty: 3, chance: 0.25 },
        { kind: "loot_b", qty: 1, chance: 1 },
      ],
    });

    // netSync 字段未扩展：配置只同步 remaining（新字段属服务端权威配置）
    const resourceSync = def.netSync?.fields?.find((f) => f.component === "ResourceNode");
    expect(resourceSync?.fields).toEqual(["remaining"]);
  });

  it("真实内容：tree 需 axe + 多产物表，gold_rock 需 pickaxe，berry_bush 无门槛", () => {
    const def = loadGameDefinition({ gameJsonPath: "game/game.json" });
    const world = createGameInstance(def).world;
    const spawnOf = (kind: string): number =>
      spawnEntity(world, world.archetypes.get(kind)!, world.components_registry);

    const tree = ResourceNode[spawnOf("tree")]!;
    expect(tree.requiredToolType).toBe("axe");
    expect(tree.lootTable?.map((e) => e.kind)).toEqual(["wood", "twig", "sap"]);
    expect(tree.lootTable?.find((e) => e.kind === "wood")?.chance).toBe(1);

    expect(ResourceNode[spawnOf("gold_rock")]!.requiredToolType).toBe("pickaxe");
    expect(ResourceNode[spawnOf("berry_bush")]!.requiredToolType).toBeUndefined();

    // 工具物品：axe/stone_axe 同 toolType axe，pickaxe 自带 pickaxe
    expect(def.itemsByKind!.get("axe")?.toolType).toBe("axe");
    expect(def.itemsByKind!.get("stone_axe")?.toolType).toBe("axe");
    expect(def.itemsByKind!.get("pickaxe")?.toolType).toBe("pickaxe");
    // 工具槽 + 采集倍率
    expect(def.itemsByKind!.get("axe")?.equip?.slot).toBe("tool");
    expect(def.itemsByKind!.get("stone_axe")?.equip?.gatherMult).toBe(2);
  });
});
