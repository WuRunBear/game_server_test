import { describe, it, expect, beforeAll } from "vitest";
import { addComponent, addEntity, hasComponent, query } from "bitecs";
import {
  bootstrapFramework,
  createGameInstance,
  createGameSimulation,
  createDefaultGameDefinition,
  getRegistries,
  spawnEntity,
  loadGameDefinition,
} from "framework/index";
import { Transform } from "framework/components/transform";
import { Health, Attack, Defense } from "framework/components/combat";
import { NetworkId } from "framework/components/network";
import { Player, Enemy, Resource } from "framework/components/tags";
import { Inventory, type InventoryEntry } from "framework/components/inventory";
import { Equipment } from "framework/components/equipment";
import { CraftingStation } from "framework/components/craftingStation";
import { ResourceNode } from "framework/components/resourceNode";
import {
  equipSlot,
  getEquipModifiers,
  equipmentSystem,
} from "framework/systems/gameplay/equipmentSystem";
import { craftRecipe } from "framework/systems/gameplay/craftingSystem";
import { attackTarget } from "framework/systems/gameplay/combatSystem";
import { harvest, gatheringSystem } from "framework/systems/gameplay/gatheringSystem";
import { setEntityKind } from "framework/systems/gameplay/aiSystem";
import type { GameWorld } from "framework/world";
import type { ItemKindSpec } from "framework/config/schema/ItemKindSchema";
import type { CraftingRecipe } from "framework/config/schema/RuleSchema";

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

function setCraftingRules(world: GameWorld, recipes: CraftingRecipe[], stationRange = 64): void {
  world.gameDef.resolvedRules["crafting"] = { recipes, stationRange };
}

const W1 = { kind: "w1", maxStack: 1, equip: { slot: "weapon" as const, attackBonus: 5 } };
const T1 = { kind: "t1", maxStack: 1, equip: { slot: "tool" as const, gatherMult: 2 } };
const A1 = { kind: "a1", maxStack: 1, equip: { slot: "armor" as const, defenseBonus: 3 } };
const M1 = { kind: "m1", maxStack: 50 };
const M2 = { kind: "m2", maxStack: 50 };
const M3 = { kind: "m3", maxStack: 50 };

interface PlayerOpts {
  x?: number; y?: number; hp?: number; capacity?: number;
  attack?: { value: number; range?: number };
  defense?: number;
  hasEquipment?: boolean;
}

/** 手工 spawn 测试玩家：写 Player/Health/Transform + Inventory + 可选 Attack/Defense/Equipment。 */
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
  if (opts.attack) {
    addComponent(world, eid, Attack);
    Attack.value[eid] = opts.attack.value;
    Attack.range[eid] = opts.attack.range ?? 0;
  }
  if (opts.defense !== undefined) {
    addComponent(world, eid, Defense);
    Defense.value[eid] = opts.defense;
  }
  const capacity = opts.capacity ?? 4;
  Inventory[eid] = { capacity, slots: Array.from({ length: capacity }, () => null) };
  if (opts.hasEquipment !== false) {
    // legacy 组件数组全局共享：显式清零残留（跨 world 同 eid 槽互踩）
    addComponent(world, eid, Equipment);
    Equipment.weaponSlot[eid] = -1;
    Equipment.toolSlot[eid] = -1;
    Equipment.armorSlot[eid] = -1;
  }
  NetworkId.value[eid] = world.nextNetworkId++;
  setEntityKind(world, eid, "test-player");
  return eid;
}

interface EnemyOpts { x?: number; y?: number; hp?: number; defense?: number; }

function spawnTestEnemy(world: GameWorld, opts: EnemyOpts = {}): number {
  const eid = addEntity(world);
  addComponent(world, eid, Transform);
  addComponent(world, eid, NetworkId);
  addComponent(world, eid, Enemy);
  addComponent(world, eid, Health);
  Transform.x[eid] = opts.x ?? 0;
  Transform.y[eid] = opts.y ?? 0;
  Health.current[eid] = opts.hp ?? 30;
  Health.max[eid] = opts.hp ?? 30;
  if (opts.defense !== undefined) {
    addComponent(world, eid, Defense);
    Defense.value[eid] = opts.defense;
  }
  NetworkId.value[eid] = world.nextNetworkId++;
  setEntityKind(world, eid, "test-enemy");
  return eid;
}

interface ResourceOpts { x?: number; y?: number; yieldsKind?: string; amountPerHit?: number; }

function spawnTestResource(world: GameWorld, opts: ResourceOpts = {}): number {
  const eid = addEntity(world);
  addComponent(world, eid, Transform);
  addComponent(world, eid, NetworkId);
  addComponent(world, eid, Resource);
  Transform.x[eid] = opts.x ?? 0;
  Transform.y[eid] = opts.y ?? 0;
  ResourceNode[eid] = {
    remaining: 5,
    max: 5,
    amountPerHit: opts.amountPerHit ?? 1,
    regenMs: 0,
    yieldsKind: opts.yieldsKind ?? "m1",
    directConsume: false,
    depletedSinceMs: null,
  };
  NetworkId.value[eid] = world.nextNetworkId++;
  setEntityKind(world, eid, "test-resource");
  return eid;
}

function spawnTestStation(world: GameWorld, opts: { x?: number; y?: number; stationType?: number } = {}): number {
  const eid = addEntity(world);
  addComponent(world, eid, Transform);
  addComponent(world, eid, NetworkId);
  addComponent(world, eid, CraftingStation);
  Transform.x[eid] = opts.x ?? 0;
  Transform.y[eid] = opts.y ?? 0;
  CraftingStation.stationType[eid] = opts.stationType ?? 1;
  NetworkId.value[eid] = world.nextNetworkId++;
  setEntityKind(world, eid, "test-station");
  return eid;
}

/** 把背包初始化为指定 kind 堆叠（容量内）。 */
function fillInventory(inv: InventoryEntry, entries: { kind: string; count: number }[]): void {
  for (let i = 0; i < entries.length; i++) {
    inv.slots[i] = { ...entries[i] };
  }
}

describe("Slice 3：equipSlot 穿戴原子", () => {
  it("武器穿戴成功：写入 weaponSlot", () => {
    const world = createBareWorld();
    setItemKind(world, W1);
    const player = spawnTestPlayer(world);
    Inventory[player]!.slots[2] = { kind: "w1", count: 1 };

    expect(equipSlot(world, player, 2)).toBe(true);
    expect(Equipment.weaponSlot[player]).toBe(2);
  });

  it("不可穿戴物品（无 equip 效果）拒绝", () => {
    const world = createBareWorld();
    setItemKind(world, M1);
    const player = spawnTestPlayer(world);
    Inventory[player]!.slots[0] = { kind: "m1", count: 3 };

    expect(equipSlot(world, player, 0)).toBe(false);
    expect(Equipment.weaponSlot[player]).toBe(-1);
  });

  it("工具/护甲写入对应槽位", () => {
    const world = createBareWorld();
    setItemKind(world, T1);
    setItemKind(world, A1);
    const player = spawnTestPlayer(world);
    Inventory[player]!.slots[1] = { kind: "t1", count: 1 };
    Inventory[player]!.slots[3] = { kind: "a1", count: 1 };

    expect(equipSlot(world, player, 1)).toBe(true);
    expect(Equipment.toolSlot[player]).toBe(1);
    expect(equipSlot(world, player, 3)).toBe(true);
    expect(Equipment.armorSlot[player]).toBe(3);
  });

  it("无 Equipment 组件的实体拒绝穿戴", () => {
    const world = createBareWorld();
    setItemKind(world, W1);
    const player = spawnTestPlayer(world, { hasEquipment: false });
    Inventory[player]!.slots[0] = { kind: "w1", count: 1 };

    expect(equipSlot(world, player, 0)).toBe(false);
  });
});

describe("Slice 3：getEquipModifiers 加成读取", () => {
  it("武器/护甲数值累加、工具倍率生效", () => {
    const world = createBareWorld();
    setItemKind(world, W1);
    setItemKind(world, T1);
    setItemKind(world, A1);
    const player = spawnTestPlayer(world);
    Inventory[player]!.slots[0] = { kind: "w1", count: 1 };
    Inventory[player]!.slots[1] = { kind: "t1", count: 1 };
    Inventory[player]!.slots[2] = { kind: "a1", count: 1 };
    equipSlot(world, player, 0);
    equipSlot(world, player, 1);
    equipSlot(world, player, 2);

    const m = getEquipModifiers(world, player);
    expect(m.attackBonus).toBe(5);
    expect(m.defenseBonus).toBe(3);
    expect(m.gatherMult).toBe(2);
  });

  it("槽类型不匹配：weaponSlot 指向的工具不提供攻击加成（防串槽）", () => {
    const world = createBareWorld();
    setItemKind(world, T1);
    const player = spawnTestPlayer(world);
    Inventory[player]!.slots[0] = { kind: "t1", count: 1 };
    Equipment.weaponSlot[player] = 0;

    const m = getEquipModifiers(world, player);
    expect(m.attackBonus).toBe(0);
    expect(m.gatherMult).toBe(1); // toolSlot 未装备 → 工具效果不生效
  });

  it("空槽自愈：装备的槽被清空后加成归零；tick 体把引用归 -1", () => {
    const world = createBareWorld();
    setItemKind(world, W1);
    const player = spawnTestPlayer(world);
    Inventory[player]!.slots[1] = { kind: "w1", count: 1 };
    equipSlot(world, player, 1);
    expect(getEquipModifiers(world, player).attackBonus).toBe(5);

    Inventory[player]!.slots[1] = null;
    expect(getEquipModifiers(world, player).attackBonus).toBe(0);

    equipmentSystem(world);
    expect(Equipment.weaponSlot[player]).toBe(-1);
  });

  it("无背包实体的加成读取返回零值", () => {
    const world = createBareWorld();
    const enemy = spawnTestEnemy(world);
    expect(getEquipModifiers(world, enemy)).toEqual({ attackBonus: 0, defenseBonus: 0, gatherMult: 1 });
  });
});

describe("Slice 3：craftRecipe 合成原子", () => {
  it("成功：inputs 消耗 + output 入包", () => {
    const world = createBareWorld();
    setItemKind(world, M1);
    setItemKind(world, M2);
    setCraftingRules(world, [
      { id: "r1", inputs: [{ kind: "m1", count: 2 }], outputs: [{ kind: "m2", count: 1 }] },
    ]);
    const player = spawnTestPlayer(world);
    fillInventory(Inventory[player]!, [{ kind: "m1", count: 3 }]);

    expect(craftRecipe(world, player, "r1")).toBe(true);
    const inv = Inventory[player]!;
    expect(inv.slots[0]).toEqual({ kind: "m1", count: 1 });
    expect(inv.slots[1]).toEqual({ kind: "m2", count: 1 });
  });

  it("缺料拒绝：零副作用", () => {
    const world = createBareWorld();
    setItemKind(world, M1);
    setItemKind(world, M2);
    setCraftingRules(world, [
      { id: "r1", inputs: [{ kind: "m1", count: 5 }], outputs: [{ kind: "m2", count: 1 }] },
    ]);
    const player = spawnTestPlayer(world);
    fillInventory(Inventory[player]!, [{ kind: "m1", count: 3 }]);

    expect(craftRecipe(world, player, "r1")).toBe(false);
    expect(Inventory[player]!.slots[0]).toEqual({ kind: "m1", count: 3 });
  });

  it("未知 recipe 拒绝", () => {
    const world = createBareWorld();
    setCraftingRules(world, []);
    const player = spawnTestPlayer(world);
    expect(craftRecipe(world, player, "nope")).toBe(false);
  });

  it("满包拒绝：输出无空槽且不可合并 → 不消耗材料", () => {
    const world = createBareWorld();
    setItemKind(world, M1);
    setItemKind(world, M3);
    setCraftingRules(world, [
      { id: "r1", inputs: [{ kind: "m1", count: 2 }], outputs: [{ kind: "m3", count: 1 }] },
    ]);
    const player = spawnTestPlayer(world, { capacity: 2 });
    fillInventory(Inventory[player]!, [{ kind: "m1", count: 2 }, { kind: "m1", count: 2 }]);

    expect(craftRecipe(world, player, "r1")).toBe(false);
    expect(Inventory[player]!.slots[0]).toEqual({ kind: "m1", count: 2 });
    expect(Inventory[player]!.slots[1]).toEqual({ kind: "m1", count: 2 });
  });

  it("输出可并入已有半满堆叠 → 允许合成", () => {
    const world = createBareWorld();
    setItemKind(world, { kind: "raw", maxStack: 20 });
    setItemKind(world, { kind: "cooked", maxStack: 20 });
    setCraftingRules(world, [
      { id: "cook", stationType: 1, inputs: [{ kind: "raw", count: 1 }], outputs: [{ kind: "cooked", count: 1 }] },
    ]);
    const player = spawnTestPlayer(world, { capacity: 2 });
    fillInventory(Inventory[player]!, [{ kind: "raw", count: 1 }, { kind: "cooked", count: 19 }]);
    spawnTestStation(world, { x: 0, y: 0, stationType: 1 });

    expect(craftRecipe(world, player, "cook")).toBe(true);
    const inv = Inventory[player]!;
    expect(inv.slots[0]).toBeNull(); // raw_meat 被消耗
    expect(inv.slots[1]).toEqual({ kind: "cooked", count: 20 }); // 合并进半满堆叠
  });

  it("站点类型匹配且距离内 → 成功；超距/类型不匹配 → 拒绝", () => {
    const world = createBareWorld();
    setItemKind(world, M1);
    setItemKind(world, M2);
    setCraftingRules(world, [
      { id: "r1", stationType: 1, inputs: [{ kind: "m1", count: 1 }], outputs: [{ kind: "m2", count: 1 }] },
    ]);
    const player = spawnTestPlayer(world, { x: 0, y: 0 });
    fillInventory(Inventory[player]!, [{ kind: "m1", count: 3 }]);

    // 匹配站点距离内 → 成功
    const matching = spawnTestStation(world, { x: 50, y: 0, stationType: 1 });
    expect(craftRecipe(world, player, "r1")).toBe(true);
    Inventory[player]!.slots[0] = { kind: "m1", count: 3 };

    // 匹配站点移出范围 → 拒绝（零副作用）
    Transform.x[matching] = 1000;
    expect(craftRecipe(world, player, "r1")).toBe(false);
    Inventory[player]!.slots[0] = { kind: "m1", count: 3 };

    // 近处只有类型不匹配的站点 → 拒绝（零副作用）
    spawnTestStation(world, { x: 0, y: 0, stationType: 2 });
    expect(craftRecipe(world, player, "r1")).toBe(false);
    expect(Inventory[player]!.slots[0]).toEqual({ kind: "m1", count: 3 });
  });

  it("材料分散多槽也可消耗", () => {
    const world = createBareWorld();
    setItemKind(world, M1);
    setItemKind(world, M2);
    setCraftingRules(world, [
      { id: "r1", inputs: [{ kind: "m1", count: 3 }], outputs: [{ kind: "m2", count: 1 }] },
    ]);
    const player = spawnTestPlayer(world, { capacity: 4 });
    fillInventory(Inventory[player]!, [
      { kind: "m1", count: 2 },
      { kind: "m1", count: 1 },
      { kind: "m2", count: 1 },
    ]);

    expect(craftRecipe(world, player, "r1")).toBe(true);
    const inv = Inventory[player]!;
    expect(inv.slots[0]).toBeNull();
    expect(inv.slots[1]).toBeNull();
    expect(inv.slots[2]).toEqual({ kind: "m2", count: 2 });
  });
});

describe("Slice 3：combatSystem / gatheringSystem 读装备修正", () => {
  it("攻击者武器加成：damage = 基础 + attackBonus", () => {
    const world = createBareWorld();
    setItemKind(world, W1);
    const player = spawnTestPlayer(world, { attack: { value: 10, range: 40 } });
    const enemy = spawnTestEnemy(world, { hp: 100 });
    Inventory[player]!.slots[0] = { kind: "w1", count: 1 };
    equipSlot(world, player, 0);

    expect(attackTarget(world, player, enemy)).toBe(true);
    expect(Health.current[enemy]).toBe(85);
  });

  it("目标护甲加成：damage 扣除基础防御 + defenseBonus", () => {
    const world = createBareWorld();
    setItemKind(world, W1);
    setItemKind(world, A1);
    const player = spawnTestPlayer(world, { attack: { value: 10, range: 40 } });
    const enemy = spawnTestEnemy(world, { hp: 100, defense: 2 });
    Inventory[player]!.slots[0] = { kind: "w1", count: 1 };
    equipSlot(world, player, 0);
    addComponent(world, enemy, Equipment);
    Equipment.weaponSlot[enemy] = -1;
    Equipment.toolSlot[enemy] = -1;
    Equipment.armorSlot[enemy] = -1;
    Inventory[enemy] = { capacity: 4, slots: [null, null, null, null] };
    Inventory[enemy]!.slots[1] = { kind: "a1", count: 1 };
    equipSlot(world, enemy, 1);

    expect(attackTarget(world, player, enemy)).toBe(true);
    // 10 + 5 攻 - (2 + 3) 防 = 10
    expect(Health.current[enemy]).toBe(90);
  });

  it("harvest 工具倍率：装备 gatherMult 2 → 单次产出翻倍", () => {
    const world = createBareWorld();
    setItemKind(world, M1);
    setItemKind(world, T1);
    const player = spawnTestPlayer(world);
    const node = spawnTestResource(world, { yieldsKind: "m1", amountPerHit: 1 });
    Inventory[player]!.slots[1] = { kind: "t1", count: 1 };
    equipSlot(world, player, 1);

    expect(harvest(world, player, node)).toBe(true);
    expect(Inventory[player]!.slots[0]).toEqual({ kind: "m1", count: 2 });
  });

  it("无工具时单次产出保持 1", () => {
    const world = createBareWorld();
    setItemKind(world, M1);
    const player = spawnTestPlayer(world);
    const node = spawnTestResource(world, { yieldsKind: "m1", amountPerHit: 1 });

    expect(harvest(world, player, node)).toBe(true);
    expect(Inventory[player]!.slots[0]).toEqual({ kind: "m1", count: 1 });
  });
});

describe("Slice 3：GameSimulation 命令路由", () => {
  it("submitCommand craft / equip 生效；无效命令返回 false", () => {
    const gameDef = createDefaultGameDefinition();
    gameDef.resolvedRules["crafting"] = {
      recipes: [{ id: "r1", inputs: [{ kind: "m1", count: 2 }], outputs: [{ kind: "m2", count: 1 }] }],
      stationRange: 64,
    };
    const sim = createGameSimulation(gameDef);
    const world = (sim as unknown as { world: GameWorld }).world;
    setItemKind(world, M1);
    setItemKind(world, M2);
    setItemKind(world, W1);

    sim.addPlayer("s1");
    const playerEid = query(world, [Player])[0];
    addComponent(world, playerEid, Equipment);
    Equipment.weaponSlot[playerEid] = -1;
    Equipment.toolSlot[playerEid] = -1;
    Equipment.armorSlot[playerEid] = -1;
    Inventory[playerEid] = { capacity: 4, slots: Array.from({ length: 4 }, () => null) };
    const inv = Inventory[playerEid]!;
    fillInventory(inv, [{ kind: "m1", count: 2 }]);

    expect(sim.submitCommand("s1", { type: "craft", recipe: "r1" })).toBe(true);
    expect(inv.slots[0]).toEqual({ kind: "m2", count: 1 }); // m1 消耗后空出的槽被产出占用

    expect(sim.submitCommand("s1", { type: "equip", slot: 1 })).toBe(false); // m2 材料不可穿戴
    expect(Equipment.weaponSlot[playerEid]).toBe(-1);
    inv.slots[1] = { kind: "w1", count: 1 };
    expect(sim.submitCommand("s1", { type: "equip", slot: 1 })).toBe(true);
    expect(Equipment.weaponSlot[playerEid]).toBe(1);

    expect(sim.submitCommand("s1", { type: "craft", recipe: "missing" })).toBe(false);
  });
});

describe("Slice 3 集成：合成→装备→采集翻倍 / 合成矛→攻击增强", () => {
  it("demo 主线：craft tool → equip → harvest 翻倍；craft weapon → 伤害 +15", () => {
    const world = createBareWorld();
    setItemKind(world, { kind: "m1", maxStack: 50 }); // 通用材料 A
    setItemKind(world, { kind: "m2", maxStack: 50 }); // 通用材料 B
    setItemKind(world, { kind: "m3", maxStack: 1, equip: { slot: "tool", gatherMult: 2 } });
    setItemKind(world, { kind: "m4", maxStack: 1, equip: { slot: "weapon", attackBonus: 15 } });
    setCraftingRules(world, [
      { id: "tool", inputs: [{ kind: "m1", count: 1 }, { kind: "m2", count: 1 }], outputs: [{ kind: "m3", count: 1 }] },
      { id: "weapon", inputs: [{ kind: "m1", count: 2 }, { kind: "m2", count: 1 }], outputs: [{ kind: "m4", count: 1 }] },
    ]);

    const player = spawnTestPlayer(world, { attack: { value: 10, range: 40 }, capacity: 12 });
    fillInventory(Inventory[player]!, [
      { kind: "m1", count: 3 },
      { kind: "m2", count: 2 },
    ]);

    // 合成工具并装备
    expect(craftRecipe(world, player, "tool")).toBe(true);
    const toolSlot = Inventory[player]!.slots.findIndex((s) => s?.kind === "m3");
    expect(toolSlot).toBeGreaterThan(0);
    expect(equipSlot(world, player, toolSlot)).toBe(true);
    expect(getEquipModifiers(world, player).gatherMult).toBe(2);

    // 采集翻倍：剩 m1 2 + 新产出 2
    const node = spawnTestResource(world, { yieldsKind: "m1", amountPerHit: 1 });
    expect(harvest(world, player, node)).toBe(true);
    const total = Inventory[player]!.slots.reduce(
      (sum, s) => sum + (s?.kind === "m1" ? s.count : 0), 0,
    );
    expect(total).toBe(4);

    // 合成武器并装备：攻击 10 + 15
    expect(craftRecipe(world, player, "weapon")).toBe(true);
    const weaponSlot = Inventory[player]!.slots.findIndex((s) => s?.kind === "m4");
    expect(equipSlot(world, player, weaponSlot)).toBe(true);

    const enemy = spawnTestEnemy(world, { hp: 100 });
    expect(attackTarget(world, player, enemy)).toBe(true);
    expect(Health.current[enemy]).toBe(75);
  });

  it("真实 spawn 路径：player archetype 带 Equipment 组件（-1 初始化）", () => {
    const gameDef = loadRealGameDefForArchetype();
    const instance = createGameInstance(gameDef);
    const world = instance.world;
    const { componentRegistry, archetypeRegistry } = getRegistries();

    const player = spawnEntity(world, archetypeRegistry.get("player"), componentRegistry, { x: 0, y: 0 });
    expect(hasComponent(world, player, Equipment)).toBe(true);
    expect(Equipment.weaponSlot[player]).toBe(-1);
    expect(Equipment.toolSlot[player]).toBe(-1);
    expect(Equipment.armorSlot[player]).toBe(-1);
  });

  it("真实 game 配置：crafting 规则可加载且与 item 表一致（validateIntegrity 校验通过）", () => {
    const def = loadGameDefinition({ gameJsonPath: "game/game.json" });
    const crafting = def.resolvedRules["crafting"] as { recipes: CraftingRecipe[] };
    expect(crafting.recipes.length).toBe(5);
    const kinds = new Set(def.resolvedItems.map((i) => i.kind));
    for (const recipe of crafting.recipes) {
      for (const io of [...recipe.inputs, ...recipe.outputs]) {
        expect(kinds.has(io.kind)).toBe(true);
      }
    }
  });

  it("真实 netSync 接线：Equipment/CraftingStation 字段进入快照", () => {
    const def = loadGameDefinition({ gameJsonPath: "game/game.json" });
    def.resolvedSpawns = [];
    const sim = createGameSimulation(def);
    const { networkId } = sim.addPlayer("s1");
    const { snapshot } = sim.tick(50);

    const playerSnap = snapshot.entities.get(networkId);
    expect(playerSnap).toBeDefined();
    expect(playerSnap!.values["Equipment.weaponSlot"]).toBe(-1);
    expect(playerSnap!.values["Equipment.toolSlot"]).toBe(-1);
    expect(playerSnap!.values["Equipment.armorSlot"]).toBe(-1);
  });
});

function loadRealGameDefForArchetype() {
  const def = loadGameDefinition({ gameJsonPath: "game/game.json" });
  def.resolvedSpawns = [];
  return def;
}
