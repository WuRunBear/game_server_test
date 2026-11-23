/**
 * CC-07 State Sync Completion：netSync 配置完整性 + 适配器投影测试。
 *
 * 覆盖：
 * - 真实 `game/game.json` 的 `netSync.fields` 含 CC-07 要求的组件/字段，
 *   且每个 SoA 字段在组件定义里真实存在（防配置笔误导致启动期/运行期缺字段）；
 * - 每个 netSync 里配置的 AoS 组件都有同步适配器（否则字段静默缺失）；
 * - StateMachine / Modifiers / ExpiresAt / spoilAt / Projectile.ownerNetworkId
 *   / Category 的适配器输出（含“组件缺失不抛异常”）；
 * - 真实配置端到端快照：敌人冷却/血条/阵营、资源 pips、树状态机、投射物归属
 *   都进入 values/strings，且投射物只暴露 networkId 不暴露 eid。
 *
 * 注意：AoS 组件是模块级 `[] as T[]`（eid 槽跨 world 共享），每个用例后清空。
 */
import { describe, it, expect, beforeAll, afterEach } from "vitest";
import { addComponent, addEntity, query } from "bitecs";
import {
  bootstrapFramework,
  createDefaultGameDefinition,
  createGameInstance,
  createGameSimulation,
  getRegistries,
  loadGameDefinition,
  spawnEntity,
  type SimulationPort,
} from "framework/index";
import { NetworkId } from "framework/components/network";
import { Transform } from "framework/components/transform";
import { Projectile } from "framework/components/projectile";
import { Lifetime } from "framework/components/lifetime";
import { ItemMeta } from "framework/components/itemMeta";
import { Inventory } from "framework/components/inventory";
import { ResourceNode } from "framework/components/resourceNode";
import { Kind } from "framework/components/kind";
import { Ledger } from "framework/components/ledger";
import { Placeable } from "framework/components/placeable";
import { GridOccupancy } from "framework/components/gridOccupancy";
import { Structure } from "framework/components/structure";
import { Player, Enemy, NPC, Item, Resource, Container } from "framework/components/tags";
import { ExpiresAt } from "framework/simulation/timer/timer";
import { StateMachine } from "framework/simulation/stateMachine/stateMachine";
import { Modifiers } from "framework/simulation/modifiers/modifiers";
import { getAosSyncAdapter, type AosSyncAdapter } from "framework/simulation/aosSyncAdapters";
import { spawnProjectile } from "framework/systems/gameplay/projectileSystem";
import type { LoadedGameDefinition } from "framework/config/schema/GameDefinitionSchema";
import type { GameWorld } from "framework/world";

beforeAll(() => {
  bootstrapFramework();
});

/** 清空测试涉及的模块级 AoS 单例（跨 world 共享 eid 槽）。 */
afterEach(() => {
  for (let i = 0; i < ItemMeta.length; i++) ItemMeta[i] = undefined;
  for (let i = 0; i < Inventory.length; i++) Inventory[i] = undefined;
  for (let i = 0; i < ResourceNode.length; i++) ResourceNode[i] = undefined;
  for (let i = 0; i < Kind.length; i++) Kind[i] = "";
  for (let i = 0; i < Ledger.length; i++) Ledger[i] = undefined;
  for (let i = 0; i < ExpiresAt.length; i++) ExpiresAt[i] = undefined;
  for (let i = 0; i < StateMachine.length; i++) StateMachine[i] = undefined;
  for (let i = 0; i < Modifiers.length; i++) Modifiers[i] = undefined;
});

function loadRealDef(): LoadedGameDefinition {
  return loadGameDefinition({ gameJsonPath: "game/game.json" });
}

function entriesOf(def: LoadedGameDefinition, component: string) {
  return (def.netSync?.fields ?? []).filter((field) => field.component === component);
}

function oneEntryOf(def: LoadedGameDefinition, component: string) {
  const entries = entriesOf(def, component);
  expect(entries.length, `netSync 条目 ${component} 缺失`).toBeGreaterThan(0);
  return entries[0]!;
}

function simWorld(sim: SimulationPort): GameWorld {
  return (sim as unknown as { world: GameWorld }).world;
}

/** 裸世界：默认定义 + 手工时间（适配器只用 world.time / 组件查询）。 */
function bareWorld(tick = 50): GameWorld {
  const world = createGameInstance(createDefaultGameDefinition()).world;
  world.time.tick = tick;
  return world;
}

/** 只有 NetworkId 的实体（不挂任何 netSync 组件）。 */
function netEntity(world: GameWorld, networkId: number): number {
  const eid = addEntity(world);
  addComponent(world, eid, NetworkId);
  NetworkId.value[eid] = networkId;
  return eid;
}

function adapterOf(name: string): AosSyncAdapter {
  const adapter = getAosSyncAdapter(name);
  expect(adapter, `AoS 适配器 ${name} 未注册`).toBeDefined();
  return adapter!;
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. 配置完整性
// ─────────────────────────────────────────────────────────────────────────────

describe("netSync 配置完整性（真实 game.json）", () => {
  it("CC-07 要求的组件/字段全部在 netSync.fields 中", () => {
    const def = loadRealDef();

    expect(oneEntryOf(def, "Health").fields).toEqual(expect.arrayContaining(["current", "max"]));
    expect(oneEntryOf(def, "Attack").fields).toEqual(expect.arrayContaining(["value", "range"]));
    expect(oneEntryOf(def, "Defense").fields).toEqual(expect.arrayContaining(["value"]));
    expect(oneEntryOf(def, "Team").fields).toEqual(expect.arrayContaining(["id"]));
    expect(oneEntryOf(def, "Perception").fields).toEqual(expect.arrayContaining(["visionRadius"]));
    expect(oneEntryOf(def, "Transform").fields).toEqual(expect.arrayContaining(["x", "y", "rot", "scale"]));
    expect(oneEntryOf(def, "Velocity").fields).toEqual(expect.arrayContaining(["vx", "vy"]));

    // Cooldown 不再限定 Player 标签：敌人攻击冷却也要出网。
    const cooldown = oneEntryOf(def, "Cooldown");
    expect(cooldown.fields).toContain("remainingMs");
    expect(cooldown.tags).toBeUndefined();

    // Projectile：方向/尺寸/伤害；owner eid 绝不出网（归属走派生 ownerNetworkId）。
    const projectile = oneEntryOf(def, "Projectile");
    expect(projectile.fields).toEqual(expect.arrayContaining(["vx", "vy", "radius", "damage"]));
    expect(projectile.fields).not.toContain("owner");
    expect(projectile.fields).not.toContain("ownerNetworkId");

    expect(oneEntryOf(def, "ResourceNode").fields).toEqual(expect.arrayContaining(["remaining", "max", "infinite"]));
    expect(oneEntryOf(def, "LightSource").fields).toContain("fuelInfinite");
    expect(oneEntryOf(def, "Placeable").fields).toContain("ownerNetworkId");
    expect(oneEntryOf(def, "GridOccupancy").fields).toContain("cellLevel");

    // Inventory 两个隐私条目（Player/Container）都补 spoilAt。
    const inventories = entriesOf(def, "Inventory");
    expect(inventories.length).toBe(2);
    for (const entry of inventories) expect(entry.fields).toContain("spoilAt");
    expect(oneEntryOf(def, "ItemMeta").fields).toContain("spoilAt");

    expect(oneEntryOf(def, "Ledger").fields).toContain("entries");
    expect(oneEntryOf(def, "StateMachine").fields).toEqual(expect.arrayContaining(["state", "stateTick"]));
    expect(oneEntryOf(def, "Modifiers").fields).toContain("stats");
    expect(oneEntryOf(def, "ExpiresAt").fields).toContain("remainingTicks");

    // 派生投影（Category / Projectile.ownerNetworkId / Lifetime.remainingTicks）
    // 挂在 Kind 适配器上输出——Kind 条目必须保持无 tags、覆盖全体实体。
    const kind = oneEntryOf(def, "Kind");
    expect(kind.fields).toContain("value");
    expect(kind.tags).toBeUndefined();
  });

  it("每个 netSync SoA 字段在组件定义里真实存在；每个 AoS 条目都有适配器", () => {
    const def = loadRealDef();
    const { componentRegistry } = getRegistries();

    for (const entry of def.netSync?.fields ?? []) {
      // 派生投影伪组件（Crafting）无注册组件，跳过。
      if (!componentRegistry.has(entry.component)) continue;
      const component = componentRegistry.get(entry.component);

      if (Array.isArray(component)) {
        expect(
          getAosSyncAdapter(entry.component),
          `AoS 组件 ${entry.component} 已配置 netSync 但没有适配器`,
        ).toBeDefined();
        continue;
      }

      for (const field of entry.fields) {
        expect(
          component as Record<string, unknown>,
          `${entry.component}.${field} 不在组件定义中`,
        ).toHaveProperty(field);
      }
    }
  });

  it("所有同步 key 都不以 owner/eid 形式暴露内部实体 id", () => {
    const def = loadRealDef();
    const projectile = oneEntryOf(def, "Projectile");
    // 只允许派生键 Projectile.ownerNetworkId；禁止直接同步 owner / ownerEid。
    expect(projectile.fields.some((f) => /owner/i.test(f))).toBe(false);
    for (const entry of def.netSync?.fields ?? []) {
      for (const field of entry.fields) {
        expect(`${entry.component}.${field}`).not.toMatch(/\.(eid|ownerEid)$/);
      }
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. 适配器投影
// ─────────────────────────────────────────────────────────────────────────────

describe("AoS 适配器：StateMachine / Modifiers / ExpiresAt", () => {
  it("StateMachine 输出 state（字符串）+ stateTick（进入 tick）", () => {
    const world = bareWorld();
    const eid = netEntity(world, 11);
    StateMachine[eid] = { state: "burning", enteredTick: 12 };

    const out = adapterOf("StateMachine")(world, eid, ["state", "stateTick"]);
    expect(out.strings["StateMachine.state"]).toBe("burning");
    expect(out.numbers["StateMachine.stateTick"]).toBe(12);
  });

  it("Modifiers 按 stat 输出生效合计/条目数/最早到期 tick/source 计数", () => {
    const world = bareWorld(50);
    const eid = netEntity(world, 12);
    Modifiers[eid] = {
      moveSpeed: [
        { mul: -0.5, source: "slow", expiresTick: 100 },
        { mul: -0.2, source: "poison" },
      ],
      attack: [
        { add: 5, source: "rage" },
        { add: 99, source: "rage", expiresTick: 50 }, // 50 ≥ expiresTick → 失效
      ],
      poisoned: [{ bool: true, source: "poison" }],
      defense: [{ add: 10, expiresTick: 10 }], // 全部失效 → 整个 stat 无键
    };

    const out = adapterOf("Modifiers")(world, eid, ["stats"]);
    expect(out.numbers["Modifiers.moveSpeed.mul"]).toBeCloseTo(-0.7);
    expect(out.numbers["Modifiers.moveSpeed.add"]).toBe(0);
    expect(out.numbers["Modifiers.moveSpeed.count"]).toBe(2);
    expect(out.numbers["Modifiers.moveSpeed.expiresTick"]).toBe(100);
    expect(out.numbers["Modifiers.moveSpeed.source.slow"]).toBe(1);
    expect(out.numbers["Modifiers.moveSpeed.source.poison"]).toBe(1);

    expect(out.numbers["Modifiers.attack.add"]).toBe(5);
    expect(out.numbers["Modifiers.attack.count"]).toBe(1);
    expect(out.numbers["Modifiers.attack.source.rage"]).toBe(1);

    expect(out.numbers["Modifiers.poisoned.bool"]).toBe(1);

    expect(Object.keys(out.numbers).some((key) => key.startsWith("Modifiers.defense."))).toBe(false);
  });

  it("ExpiresAt 输出剩余 tick（不暴露效果参数/eid）", () => {
    const world = bareWorld(50);
    const eid = netEntity(world, 13);
    ExpiresAt[eid] = { expiresTick: 80, effect: { name: "demo", params: { targetEid: eid } } };

    const out = adapterOf("ExpiresAt")(world, eid, ["remainingTicks"]);
    expect(out.numbers["ExpiresAt.remainingTicks"]).toBe(30);
    expect(Object.keys(out.strings)).toHaveLength(0);
  });
});

describe("AoS 适配器：食物腐烂 spoilAt（绝对 tick）", () => {
  it("ItemMeta 只对腐烂物品输出绝对 spoilAt", () => {
    const world = bareWorld();
    const eid = netEntity(world, 21);
    ItemMeta[eid] = { kind: "food", count: 2, pickupAfterMs: 0, spoilAt: 110 };

    const out = adapterOf("ItemMeta")(world, eid, ["kind", "count", "spoilAt"]);
    expect(out.strings["ItemMeta.kind"]).toBe("food");
    expect(out.numbers["ItemMeta.count"]).toBe(2);
    expect(out.numbers["ItemMeta.spoilAt"]).toBe(110);

    ItemMeta[eid] = { kind: "rock", count: 1, pickupAfterMs: 0 };
    const stable = adapterOf("ItemMeta")(world, eid, ["kind", "count", "spoilAt"]);
    expect(stable.numbers["ItemMeta.spoilAt"]).toBeUndefined();
  });

  it("Inventory 按槽输出绝对 spoilAt（空槽/不腐烂不写键）", () => {
    const world = bareWorld();
    const eid = netEntity(world, 22);
    Inventory[eid] = {
      capacity: 3,
      slots: [
        { kind: "food", count: 1, spoilAt: 90 },
        null,
        { kind: "axe", count: 1, durability: 5 },
      ],
    };

    const out = adapterOf("Inventory")(world, eid, ["slots", "durability", "spoilAt"]);
    expect(out.numbers["Inventory.0.spoilAt"]).toBe(90);
    expect(out.numbers["Inventory.1.spoilAt"]).toBeUndefined();
    expect(out.numbers["Inventory.2.spoilAt"]).toBeUndefined();
  });
});

describe("派生投影：Category / Projectile.ownerNetworkId / Lifetime.remainingTicks", () => {
  it("Category 使用框架通用词分类所有实体类型", () => {
    const world = bareWorld();
    const cases: Array<[string, number]> = [];
    const add = (component: object, networkId: number): void => {
      const eid = netEntity(world, networkId);
      addComponent(world, eid, component as never);
      cases.push([String(networkId), eid]);
    };

    add(Player, 31);
    const enemyNpc = netEntity(world, 32);
    addComponent(world, enemyNpc, Enemy);
    addComponent(world, enemyNpc, NPC);
    cases.push(["enemy-npc", enemyNpc]);
    add(NPC, 33);
    add(Projectile, 34);
    add(Placeable, 35);
    add(Structure, 36);
    add(Resource, 37);
    add(Container, 38);
    add(Item, 39);
    cases.push(["other", netEntity(world, 40)]);

    const categoryOf = (eid: number): string =>
      adapterOf("Kind")(world, eid, ["value"]).strings["Category.value"];

    expect(categoryOf(cases[0]![1])).toBe("player");
    expect(categoryOf(cases[1]![1])).toBe("enemy");
    expect(categoryOf(cases[2]![1])).toBe("npc");
    expect(categoryOf(cases[3]![1])).toBe("projectile");
    expect(categoryOf(cases[4]![1])).toBe("structure");
    expect(categoryOf(cases[5]![1])).toBe("structure");
    expect(categoryOf(cases[6]![1])).toBe("resource");
    expect(categoryOf(cases[7]![1])).toBe("container");
    expect(categoryOf(cases[8]![1])).toBe("item");
    expect(categoryOf(cases[9]![1])).toBe("other");
  });

  it("Projectile.ownerNetworkId 输出主人 networkId；无主/非法 owner 回退 0", () => {
    const world = bareWorld(50);
    const owner = netEntity(world, 700);
    const projectile = netEntity(world, 701);
    addComponent(world, projectile, Projectile);
    Projectile.owner[projectile] = owner;

    const out = adapterOf("Kind")(world, projectile, ["value"]);
    expect(out.strings["Category.value"]).toBe("projectile");
    expect(out.numbers["Projectile.ownerNetworkId"]).toBe(700);

    Projectile.owner[projectile] = -1;
    const unowned = adapterOf("Kind")(world, projectile, ["value"]);
    expect(unowned.numbers["Projectile.ownerNetworkId"]).toBe(0);
  });

  it("Lifetime.remainingTicks = max(0, expiresTick - tick)", () => {
    const world = bareWorld(50);
    const eid = netEntity(world, 702);
    addComponent(world, eid, Lifetime);
    Lifetime.expiresTick[eid] = 120;

    const out = adapterOf("Kind")(world, eid, ["value"]);
    expect(out.numbers["Lifetime.remainingTicks"]).toBe(70);

    Lifetime.expiresTick[eid] = 40;
    expect(adapterOf("Kind")(world, eid, ["value"]).numbers["Lifetime.remainingTicks"]).toBe(0);
  });

  it("适配器对空实体/缺失组件不抛异常", () => {
    const world = bareWorld(50);
    const empty = netEntity(world, 800);
    for (const name of ["StateMachine", "Modifiers", "ExpiresAt", "ItemMeta", "Inventory", "Kind"]) {
      expect(() => adapterOf(name)(world, empty, ["state", "stateTick", "stats", "remainingTicks", "spoilAt", "value"]))
        .not.toThrow();
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. 真实配置端到端快照
// ─────────────────────────────────────────────────────────────────────────────

describe("真实 game.json 快照接线", () => {
  it("敌人冷却/血条/攻防阵营、资源 pips、树状态机、投射物归属都进入快照", async () => {
    const def = loadRealDef();
    const sim = await createGameSimulation(def);
    const world = simWorld(sim);
    const { componentRegistry, archetypeRegistry } = getRegistries();

    const boar = spawnEntity(world, archetypeRegistry.get("boar"), componentRegistry, { x: 100, y: 100 });
    Modifiers[boar] = { moveSpeed: [{ mul: -0.5, source: "slow" }] };
    const tree = spawnEntity(world, archetypeRegistry.get("tree"), componentRegistry, { x: 120, y: 120 });
    const campfire = spawnEntity(world, archetypeRegistry.get("campfire"), componentRegistry, { x: 140, y: 140 });
    const wall = spawnEntity(world, archetypeRegistry.get("wall"), componentRegistry, { x: 160, y: 160 });
    GridOccupancy.cellX[wall] = 3;
    GridOccupancy.cellY[wall] = 4;
    GridOccupancy.cellLevel[wall] = 1;
    GridOccupancy.cellW[wall] = 1;
    GridOccupancy.cellH[wall] = 1;
    const villager = spawnEntity(world, archetypeRegistry.get("villager"), componentRegistry, { x: 180, y: 180 });

    const { networkId: playerNetworkId } = sim.addPlayer("s1");
    const [playerEid] = query(world, [Player]);
    const projectile = spawnProjectile(
      world,
      playerEid!,
      Transform.x[playerEid!],
      Transform.y[playerEid!],
      0,
      0,
      1000,
      8,
      5,
    );

    const { snapshot } = sim.tick(50);

    const boarSnap = snapshot.entities.get(NetworkId.value[boar])!;
    expect(boarSnap).toBeDefined();
    expect(boarSnap.values["Health.max"]).toBe(60);
    expect(boarSnap.values["Attack.value"]).toBe(8);
    expect(boarSnap.values["Attack.range"]).toBe(32);
    expect(boarSnap.values["Team.id"]).toBe(2);
    expect(boarSnap.values["Perception.visionRadius"]).toBe(160);
    expect(boarSnap.values["Cooldown.remainingMs"]).toBe(0);
    expect(boarSnap.strings["Category.value"]).toBe("enemy");
    expect(boarSnap.values["Modifiers.moveSpeed.mul"]).toBe(-0.5);
    expect(boarSnap.values["Modifiers.moveSpeed.count"]).toBe(1);
    // scale 的语义中性值是 1（spawn 初始化）；0 会让客户端把实体缩放成不可见。
    expect(boarSnap.values["Transform.scale"]).toBe(1);

    const treeSnap = snapshot.entities.get(NetworkId.value[tree])!;
    expect(treeSnap).toBeDefined();
    expect(treeSnap.strings["Category.value"]).toBe("resource");
    expect(treeSnap.strings["StateMachine.state"]).toBe("alive");
    // 进入 tick 是绝对 tick（世界开机已演化的 initialAgeTicks 非 0）
    expect(treeSnap.values["StateMachine.stateTick"]).toBeGreaterThanOrEqual(0);
    expect(treeSnap.values["StateMachine.stateTick"]).toBeLessThanOrEqual(snapshot.tick);
    expect(treeSnap.values["ResourceNode.max"]).toBe(3);
    expect(treeSnap.values["ResourceNode.infinite"]).toBe(0);

    // 篝火：无限燃料标记 + 无主放置物（0），客户端不再显示假倒计时。
    const campfireSnap = snapshot.entities.get(NetworkId.value[campfire])!;
    expect(campfireSnap.strings["Category.value"]).toBe("structure");
    expect(campfireSnap.values["LightSource.fuelInfinite"]).toBe(1);
    expect(campfireSnap.values["Placeable.ownerNetworkId"]).toBe(0);

    // 多层建造：格组占用层号。
    const wallSnap = snapshot.entities.get(NetworkId.value[wall])!;
    expect(wallSnap.values["GridOccupancy.cellLevel"]).toBe(1);

    // 商店库存：NPC 账本按 kind 展平。
    const villagerSnap = snapshot.entities.get(NetworkId.value[villager])!;
    expect(villagerSnap.strings["Category.value"]).toBe("npc");
    expect(villagerSnap.values["Ledger.shell"]).toBe(100);

    const projectileSnap = snapshot.entities.get(NetworkId.value[projectile])!;
    expect(projectileSnap).toBeDefined();
    expect(projectileSnap.strings["Category.value"]).toBe("projectile");
    expect(projectileSnap.values["Projectile.ownerNetworkId"]).toBe(playerNetworkId);
    expect(projectileSnap.values["Projectile.vx"]).toBe(0);
    expect(projectileSnap.values["Projectile.radius"]).toBe(8);
    expect(projectileSnap.values["Projectile.damage"]).toBe(5);
  });
});
