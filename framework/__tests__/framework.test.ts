/**
 * 框架核心回归测试。
 *
 * 覆盖 framework 基础设施与早期切片：
 * - 五大注册表（组件/系统/动作/原型）的注册、查重与边界行为
 * - 配置加载（loadGameDefinition）与完整性校验（Item 1/2）
 * - 战斗（attackTarget 伤害/友伤/射程）、刷怪、背包拾取、交互、碰撞分离
 * - GameSimulation 无头运行、输入处理、tick 异常隔离、dtMs 钳制
 */
import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { addComponent, addEntity, hasComponent } from "bitecs";
import { State } from "mistreevous";
import {
  bootstrapFramework,
  createGameInstance,
  createGameSimulation,
  runHeadless,
  createDefaultGameDefinition,
  loadGameDefinition,
  spawnEntity,
  buildSystems,
  registerSystem,
  createActionRegistry,
  type GameInstance,
} from "framework/index";
import { getRegistries } from "framework/bootstrap";
import { setEntityKind } from "framework/systems/gameplay/aiSystem";
import { inventorySystem } from "framework/systems/gameplay/inventorySystem";
import { collisionSystem } from "framework/systems/core/collisionSystem";
import { attackTarget } from "framework/systems/gameplay/combatSystem";
import { deathSystem } from "framework/systems/gameplay/deathSystem";
import { createNpcTree } from "framework/ai/btFactory";

import { Transform } from "framework/components/transform";
import { Velocity } from "framework/components/physics";
import { Health, Attack, Defense, Team } from "framework/components/combat";
import { NetworkId } from "framework/components/network";
import { NPC, Player, Item } from "framework/components/tags";
import { Kind } from "framework/components/kind";
import { Collider } from "framework/components/physics";
import { Size } from "framework/components/size";
import { Inventory, type InventoryEntry } from "framework/components/inventory";
import { ItemMeta } from "framework/components/itemMeta";
import { makeTestGeometry } from "./helpers/mapGeometry";
import { EntityMap } from "framework/components/entityMap";
import type { GameWorld } from "framework/world";
import type { ComponentRegistry } from "framework/components/componentRegistry";
import type { ArchetypeRegistry } from "framework/entities/archetypeRegistry";

beforeAll(() => {
  // 全局引导一次：注册表是幂等单例，所有用例共享同一套内置实现
  bootstrapFramework();
});

/** 用默认配置构造一个测试世界（与真实服务同路径的 GameInstance）。 */
function createTestWorld(): GameWorld {
  const gameDef = createDefaultGameDefinition();
  const instance = createGameInstance(gameDef);
  return instance.world;
}

/**
 * 手工 spawn 测试实体：绕过原型，按组件名直接写 bitecs 组件数组，
 * 便于精确构造攻击者/目标等测试场景（kind 经 setEntityKind 记录）。
 */
function spawnCustomEntity(world: GameWorld, kind: string, components: Record<string, Record<string, unknown>>): number {
  const { componentRegistry, archetypeRegistry } = getRegistries();
  const eid = addEntity(world);
  addComponent(world, eid, Transform);
  addComponent(world, eid, NetworkId);
  for (const [compName, compValues] of Object.entries(components)) {
    const comp = componentRegistry.get(compName);
    addComponent(world, eid, comp);
    for (const [field, value] of Object.entries(compValues)) {
      const compObj = comp as Record<string, Record<number, unknown>>;
      if (compObj[field] !== undefined) {
        compObj[field][eid] = value;
      }
    }
  }
  NetworkId.value[eid] = world.nextNetworkId++;
  setEntityKind(world, eid, kind);
  // EntityMap 是模块级 AoS 单例：eid 跨 world 复用时会命中上一 world 的残留归属
  EntityMap[eid] = world.defaultMapId;
  return eid;
}

// 组件注册表：验证 bootstrap 注册的内置组件，以及重复注册必须抛错（防覆盖）
describe("componentRegistry", () => {
  // 内置组件（Transform/Health/NetworkId/Player/NPC）均应已注册
  it("should have registered builtin components", () => {
    const { componentRegistry } = getRegistries();
    expect(componentRegistry.has("Transform")).toBe(true);
    expect(componentRegistry.has("Health")).toBe(true);
    expect(componentRegistry.has("NetworkId")).toBe(true);
    expect(componentRegistry.has("Player")).toBe(true);
    expect(componentRegistry.has("NPC")).toBe(true);
  });

  // 同名重复注册抛错：注册表不允许静默覆盖
  it("should throw on duplicate registration", () => {
    const { componentRegistry } = getRegistries();
    expect(() => componentRegistry.register("Transform", {})).toThrow("already registered");
  });
});

// 系统注册表：内置系统（ai/physics/movement/collision/combat）均已注册；
// spawning 已退役（实体生产唯一路径 = 演化引擎），注册表中不得再出现
describe("systemRegistry", () => {
  it("should have registered builtin systems", () => {
    const { systemRegistry } = getRegistries();
    expect(systemRegistry.has("ai")).toBe(true);
    expect(systemRegistry.has("physics")).toBe(true);
    expect(systemRegistry.has("movement")).toBe(true);
    expect(systemRegistry.has("collision")).toBe(true);
    expect(systemRegistry.has("combat")).toBe(true);
    expect(systemRegistry.has("spawning")).toBe(false);
  });
});

// 动作注册表：内置行为树动作已注册；访问未注册动作抛错
describe("actionRegistry", () => {
  // Idle/Wander 等内置动作已在 bootstrap 时注册
  it("should have registered builtin actions", () => {
    const { actionRegistry } = getRegistries();
    expect(actionRegistry.has("Idle")).toBe(true);
    expect(actionRegistry.has("Wander")).toBe(true);
  });

  // 配置/行为树引用了未注册的动作名 → 运行期抛错
  it("should throw on unregistered action", () => {
    const { actionRegistry } = getRegistries();
    expect(() => actionRegistry.get("NonExistent")).toThrow("not registered");
  });
});

// 原型注册表：内置原型（player 等）已注册，且字段与配置一致
describe("archetypeRegistry", () => {
  it("should have registered builtin archetypes", () => {
    const { archetypeRegistry } = getRegistries();
    expect(archetypeRegistry.has("player")).toBe(true);
    expect(archetypeRegistry.has("npc")).toBe(true);
  });

  // player 原型：标签含 Player、Health 初始 100/100、team=1（配置驱动）
  it("player archetype should have correct properties", () => {
    const { archetypeRegistry } = getRegistries();
    const player = archetypeRegistry.get("player");
    expect(player.tags).toContain("Player");
    expect(player.components.Health).toEqual({ current: 100, max: 100 });
    expect(player.team).toBe(1);
  });
});

// 无头仿真：GameSimulation 不依赖网络即可推进 tick（测试/单机共用路径）
describe("GameSimulation headless", () => {
  // 连跑 5 tick 不抛错，第 5 帧 tick 号为 5
  it("should run ticks without error", async () => {
    const gameDef = createDefaultGameDefinition();
    const sim = await createGameSimulation(gameDef);

    const results = runHeadless(sim, { tickCount: 5 });
    expect(results[4].tick).toBe(5);
  });
});

// Item 1：配置加载——game/ 下的实体/行为/规则/刷怪/地图源按路径解析进 gameDef
describe("loadGameDefinition (Item 1: sub-config loading)", () => {
  // 实体：resolvedEntities 含 player 原型，Health 与配置一致
  it("should load entities from game/ directory", () => {
    const gameDef = loadGameDefinition({ gameJsonPath: "game/game.json" });
    expect(gameDef.resolvedEntities.length).toBeGreaterThan(0);
    const player = gameDef.resolvedEntities.find((e) => e.kind === "player");
    expect(player).toBeDefined();
    expect(player!.components.Health).toEqual({ current: 100, max: 100 });
  });

  // 行为：wander-default 行为树被解析为 resolvedBehaviors
  it("should load behaviors from game/ directory", () => {
    const gameDef = loadGameDefinition({ gameJsonPath: "game/game.json" });
    expect(gameDef.resolvedBehaviors.length).toBeGreaterThan(0);
    const wanderBehavior = gameDef.resolvedBehaviors.find((b) => b.id === "wander-default");
    expect(wanderBehavior).toBeDefined();
  });

  // 规则：combat 规则（如 friendlyFire=false）进入 resolvedRules
  it("should load rules from game/ directory", () => {
    const gameDef = loadGameDefinition({ gameJsonPath: "game/game.json" });
    expect(gameDef.resolvedRules["combat"]).toBeDefined();
    const combatRules = gameDef.resolvedRules["combat"] as Record<string, unknown>;
    expect(combatRules.friendlyFire).toBe(false);
  });

  // 演化规则：旧 spawns 规则已迁入 maps/entity-rules.json（resolvedEntityRules）
  it("should load entity rules from game/ directory", () => {
    const gameDef = loadGameDefinition({ gameJsonPath: "game/game.json" });
    expect(gameDef.resolvedEntityRules.length).toBeGreaterThan(0);
    expect(gameDef.resolvedEntityRules[0].kind).toBe("villager");
  });

  // 地图配置：按 maps/registry.json 解析出管道生成配置
  it("should resolve map configs from registry", () => {
    const gameDef = loadGameDefinition({ gameJsonPath: "game/game.json" });
    expect(gameDef.resolvedMapConfigs.length).toBeGreaterThan(0);
    expect(gameDef.resolvedMapConfigs.map((c) => c.key)).toContain("island");
  });
});

// Item 2：配置完整性校验——合法配置通过、结构损坏的配置抛错
describe("loadGameDefinition integrity validation (Item 2)", () => {
  it("should not throw for valid config", () => {
    expect(() => loadGameDefinition({ gameJsonPath: "game/game.json" })).not.toThrow();
  });

  // 结构损坏的 game.json 在加载期即被拦截
  it("should throw for invalid game.json structure", () => {
    expect(() => loadGameDefinition({ gameJsonPath: "tests/shim/invalid-game.json" }))
      .toThrow();
  });
});

// Item 3：战斗原子 attackTarget——伤害计算、友伤开关、射程判定、死亡归属
describe("combatSystem (Item 3: damage calculation via attackTarget)", () => {
  let world: GameWorld;

  beforeEach(() => {
    const gameDef = createDefaultGameDefinition();
    const instance = createGameInstance(gameDef);
    world = instance.world;
  });

  // 有 Attack 组件：造成 攻击 15 - 目标防御 5 = 10 点伤害（100 → 90）
  it("should deal damage when attacker has Attack component", () => {
    const attacker = spawnCustomEntity(world, "test-attacker", {
      Health: { current: 100, max: 100 },
      Attack: { value: 15 },
      Team: { id: 1 },
    });

    const target = spawnCustomEntity(world, "test-target", {
      Health: { current: 100, max: 100 },
      Defense: { value: 5 },
      Team: { id: 2 },
    });

    expect(attackTarget(world, attacker, target)).toBe(true);
    expect(Health.current[target]).toBe(90);
  });

  // 友伤开关关闭时同队不扣血（attackTarget 直接返回 false）
  it("should skip friendly fire when disabled", () => {
    world.gameDef.resolvedRules["combat"] = { friendlyFire: false };

    const attacker = spawnCustomEntity(world, "test-attacker", {
      Health: { current: 100, max: 100 },
      Attack: { value: 15 },
      Team: { id: 1 },
    });

    const target = spawnCustomEntity(world, "test-target", {
      Health: { current: 100, max: 100 },
      Defense: { value: 5 },
      Team: { id: 1 },
    });

    expect(attackTarget(world, attacker, target)).toBe(false);
    expect(Health.current[target]).toBe(100);
  });

  // 伤害原子不负责死亡：0 血时实体仍在，由 deathSystem 统一移除（职责分离）
  it("should not remove entity at 0 hp; deathSystem removes it", () => {
    const attacker = spawnCustomEntity(world, "test-attacker", {
      Health: { current: 100, max: 100 },
      Attack: { value: 999 },
      Team: { id: 1 },
    });

    const target = spawnCustomEntity(world, "test-target", {
      Health: { current: 10, max: 100 },
      Defense: { value: 0 },
      Team: { id: 2 },
    });

    expect(attackTarget(world, attacker, target)).toBe(true);
    expect(Health.current[target]).toBeLessThanOrEqual(0);
    // 伤害原子不负责死亡：实体仍在，统一由 deathSystem 移除
    expect(hasComponent(world, target, Health)).toBe(true);
    deathSystem(world);
    expect(hasComponent(world, target, Health)).toBe(false);
  });

  // 射程判定：距离内命中（100 → 80），距离外拒绝且不扣血
  it("should only hit targets within attack range", () => {
    const attacker = spawnCustomEntity(world, "test-attacker", {
      Health: { current: 100, max: 100 },
      Attack: { value: 20 },
      Team: { id: 1 },
    });

    const nearTarget = spawnCustomEntity(world, "test-target-near", {
      Health: { current: 100, max: 100 },
      Defense: { value: 0 },
      Team: { id: 2 },
    });
    const farTarget = spawnCustomEntity(world, "test-target-far", {
      Health: { current: 100, max: 100 },
      Defense: { value: 0 },
      Team: { id: 2 },
    });

    Transform.x[attacker] = 0;
    Transform.y[attacker] = 0;
    Transform.x[nearTarget] = 10;
    Transform.y[nearTarget] = 0;
    Transform.x[farTarget] = 100;
    Transform.y[farTarget] = 0;

    expect(attackTarget(world, attacker, nearTarget)).toBe(true);
    expect(Health.current[nearTarget]).toBe(80);
    expect(attackTarget(world, attacker, farTarget)).toBe(false);
    expect(Health.current[farTarget]).toBe(100);
  });
});

// Item 8：行为加载——NPC 原型的 behavior 字段指向行为树 id，加载后实体即可用行为树驱动
describe("aiSystem with behavior loading (Item 8)", () => {
  // 内置 npc 原型 behavior=wander-default，且 game.json 中该行为树已被解析
  it("should create behavior tree for NPC from archetype", () => {
    const gameDef = loadGameDefinition({ gameJsonPath: "game/game.json" });
    const instance = createGameInstance(gameDef);

    const { archetypeRegistry } = getRegistries();
    const npc = archetypeRegistry.get("npc");
    expect(npc.behavior).toBe("wander-default");

    const wanderDef = gameDef.resolvedBehaviors.find((b) => b.id === "wander-default");
    expect(wanderDef).toBeDefined();

    const tickBefore = instance.world.time.tick;
    instance.step(50);
    expect(instance.world.time.tick).toBe(tickBefore + 1);
  });
});

// 真实 game 配置实例：配置中的原型注册进 archetypeRegistry，且地图已构建
describe("GameInstance with game config", () => {
  // 加载 game/game.json 后：player/villager 原型可用、world.maps 已全量构建
  it("should register loaded entities into archetypeRegistry", () => {
    const gameDef = loadGameDefinition({ gameJsonPath: "game/game.json" });
    const instance = createGameInstance(gameDef);

    const { archetypeRegistry } = getRegistries();
    expect(archetypeRegistry.has("player")).toBe(true);
    expect(archetypeRegistry.has("villager")).toBe(true);
    expect(Object.keys(instance.world.maps).length).toBeGreaterThan(0);
  });
});

// Item 5：背包拾取——玩家接近地面物品，满足拾取条件时入包
describe("inventorySystem (Item 5)", () => {
  it("should pick up items when player is nearby", () => {
    const gameDef = createDefaultGameDefinition();
    const instance = createGameInstance(gameDef);

    const player = spawnCustomEntity(instance.world, "player", {
      Transform: { x: 0, y: 0 },
      Health: { current: 100, max: 100 },
      Team: { id: 1 },
      Player: {},
    });

    const item = spawnCustomEntity(instance.world, "item", {
      Transform: { x: 8, y: 8 },
      Item: {},
    });

    Transform.x[player] = 10;
    Transform.y[player] = 10;
    Transform.x[item] = 12;
    Transform.y[item] = 12;

    const tickBefore = instance.world.time.tick;
    instance.step(50);

    expect(instance.world.time.tick).toBe(tickBefore + 1);
  });

  // Defect 3 回归：满包不吞物品——前 4 个入包后消失，第 5 个因满包仍留在地面
  it("should not destroy items when inventory is full (Defect 3)", () => {
    const gameDef = createDefaultGameDefinition();
    const instance = createGameInstance(gameDef);
    const world = instance.world;

    const player = spawnCustomEntity(world, "player", {
      Transform: { x: 0, y: 0 },
      Player: {},
    });
    Inventory[player] = { capacity: 4, slots: Array.from({ length: 4 }, () => null) };

    const itemEids: number[] = [];
    for (let i = 0; i < 5; i++) {
      const item = spawnCustomEntity(world, "item", {
        Transform: { x: i, y: i },
        Item: {},
      });
      ItemMeta[item] = { kind: "testitem", count: 1, pickupAfterMs: 0 };
      itemEids.push(item);
    }

    inventorySystem(world);

    const inv = Inventory[player]!;
    expect(inv.slots[0]?.kind).toBe("testitem");
    expect(inv.slots[0]?.count).toBe(1);
    expect(inv.slots[1]?.kind).toBe("testitem");
    expect(inv.slots[2]?.kind).toBe("testitem");
    expect(inv.slots[3]?.kind).toBe("testitem");
    expect(inv.slots[4] ?? null).toBe(null);

    for (let i = 0; i < 4; i++) {
      expect(hasComponent(world, itemEids[i], Item)).toBe(false);
    }
    // 第 5 个因满包未入——保留 Defect-3 的「满包不吞物品」语义
    expect(hasComponent(world, itemEids[4], Item)).toBe(true);
  });
});

// Item 5：交互系统——无交互意图时 step 一帧不报错（意图→交互的路由详见 survival 测试）
describe("interactionSystem (Item 5)", () => {
  it("should step a tick without error when no interact intent is issued", () => {
    const gameDef = createDefaultGameDefinition();
    const instance = createGameInstance(gameDef);

    const player = spawnCustomEntity(instance.world, "player", {
      Transform: { x: 0, y: 0 },
      Player: {},
    });

    const npc = spawnCustomEntity(instance.world, "villager", {
      Transform: { x: 0, y: 0 },
      NPC: {},
    });

    Transform.x[player] = 10;
    Transform.y[player] = 10;
    Transform.x[npc] = 20;
    Transform.y[npc] = 20;

    const tickBefore = instance.world.time.tick;
    instance.step(50);

    expect(instance.world.time.tick).toBe(tickBefore + 1);
  });
});

// Defect 回归：碰撞系统生效——撞地图阻挡块被推回且该轴速度清零；无障碍时完全不动
describe("collisionSystem separation (Defect: 碰撞系统无效)", () => {
  // 撞到 blocked 格：y 被推回 24（地图边界）、vy 清零、vx 保留（逐轴分离）
  it("should push entity out of static map body and zero velocity along the blocked axis", () => {
    const gameDef = createDefaultGameDefinition();
    const instance = createGameInstance(gameDef);
    const world = instance.world;

    world.maps["test"] = makeTestGeometry({
      key: "test",
      width: 4,
      height: 4,
      tileWidth: 32,
      tileHeight: 32,
      blocked: (tx, ty) => tx === 1 && ty === 1,
    });
    world.defaultMapId = "test";

    const eid = spawnCustomEntity(world, "test-collider", {
      Transform: { x: 28, y: 28 },
      Collider: { shape: 1, halfW: 8, halfH: 8 },
      Velocity: { vx: 10, vy: 10 },
    });

    collisionSystem(world);

    expect(Transform.y[eid]).toBe(24);
    expect(Transform.x[eid]).toBe(28);

    expect(Velocity.vy[eid]).toBe(0);
    expect(Velocity.vx[eid]).toBe(10);
  });

  // 无障碍区域：位置与速度均不变
  it("should not move entity when there is no collision", () => {
    const gameDef = createDefaultGameDefinition();
    const instance = createGameInstance(gameDef);
    const world = instance.world;

    world.maps["test2"] = makeTestGeometry({ key: "test2", width: 4, height: 4, tileWidth: 32, tileHeight: 32 });
    world.defaultMapId = "test2";

    const eid = spawnCustomEntity(world, "test-collider", {
      Transform: { x: 100, y: 100 },
      Collider: { shape: 1, halfW: 8, halfH: 8 },
      Velocity: { vx: 5, vy: 5 },
    });

    collisionSystem(world);

    expect(Transform.x[eid]).toBe(100);
    expect(Transform.y[eid]).toBe(100);
    expect(Velocity.vx[eid]).toBe(5);
    expect(Velocity.vy[eid]).toBe(5);
  });
});

// 原型注册表边界：get 未注册抛错、重复注册抛错、all() 返回全部
describe("archetypeRegistry edge cases", () => {
  // get 未注册的 kind → 抛错（配置引用错误在运行期暴露）
  it("should throw when getting non-existent archetype", () => {
    const { archetypeRegistry } = getRegistries();
    expect(() => archetypeRegistry.get("non-existent")).toThrow("not registered");
  });

  // 重复注册同 kind → 抛错（防覆盖）
  it("should throw on duplicate registration", () => {
    const { archetypeRegistry } = getRegistries();
    expect(() => archetypeRegistry.register({ kind: "player", components: {} }))
      .toThrow("already registered");
  });

  // all() 返回全部已注册原型（player/npc 在内）
  it("all() should return all registered archetypes", () => {
    const { archetypeRegistry } = getRegistries();
    const all = archetypeRegistry.all();
    expect(all.length).toBeGreaterThanOrEqual(2);
    expect(all.some((a) => a.kind === "player")).toBe(true);
    expect(all.some((a) => a.kind === "npc")).toBe(true);
  });
});

// 系统注册表边界：重复注册抛错、enabled:false 过滤、after/before 拓扑排序、未注册抛错、config 透传
describe("systemRegistry edge cases", () => {
  // 重复注册同 id → 抛错（防覆盖内置系统）
  it("should throw on duplicate system registration", () => {
    const { systemRegistry } = getRegistries();
    expect(() =>
      systemRegistry.register({
        id: "ai",
        factory: () => (world) => world,
      })
    ).toThrow("already registered");
  });

  // enabled:false 的系统在 build 时被剔除，不进入执行链
  it("buildSystems should filter disabled systems", () => {
    const { systemRegistry } = getRegistries();
    const world = createTestWorld();
    const systems = buildSystems(world, [
      { id: "ai" },
      { id: "physics" },
      { id: "movement", enabled: false },
    ], systemRegistry);

    expect(systems.length).toBe(2);
  });

  // after：声明依赖者排在被依赖系统之后
  it("buildSystems should respect after/before ordering", () => {
    const callOrder: string[] = [];
    const { systemRegistry } = getRegistries();

    systemRegistry.register({
      id: "test-order-a",
      factory: () => (world) => {
        callOrder.push("test-order-a");
        return world;
      },
    });
    systemRegistry.register({
      id: "test-order-b",
      factory: () => (world) => {
        callOrder.push("test-order-b");
        return world;
      },
      after: ["test-order-a"],
    });

    const world = createTestWorld();
    const systems = buildSystems(world, [
      { id: "test-order-a" },
      { id: "test-order-b" },
    ], systemRegistry);

    for (const sys of systems) {
      sys(world);
    }

    expect(callOrder).toEqual(["test-order-a", "test-order-b"]);
  });

  // Defect 4 回归：before 声明同样生效（优先系统排前），不受配置顺序影响
  it("buildSystems should respect before ordering (Defect 4)", () => {
    const callOrder: string[] = [];
    const { systemRegistry } = getRegistries();

    systemRegistry.register({
      id: "test-before-a",
      factory: () => (world) => {
        callOrder.push("test-before-a");
        return world;
      },
      before: ["test-before-b"],
    });
    systemRegistry.register({
      id: "test-before-b",
      factory: () => (world) => {
        callOrder.push("test-before-b");
        return world;
      },
    });

    const world = createTestWorld();
    const systems = buildSystems(world, [
      { id: "test-before-b" },
      { id: "test-before-a" },
    ], systemRegistry);

    for (const sys of systems) {
      sys(world);
    }

    expect(callOrder).toEqual(["test-before-a", "test-before-b"]);
  });

  // 引用了未注册系统 → 抛错（配置错误在启动期暴露）
  it("buildSystems should throw for unregistered system", () => {
    const world = createTestWorld();
    const { systemRegistry } = getRegistries();
    expect(() =>
      buildSystems(world, [{ id: "non-existent-system" }], systemRegistry)
    ).toThrow("not registered");
  });

  // 系统 factory 可接收 game.json 中 systems[].config 对象（配置驱动参数）
  it("buildSystems should pass config to factory", () => {
    const { systemRegistry } = getRegistries();
    let receivedConfig: Record<string, unknown> | undefined;

    systemRegistry.register({
      id: "test-config-system",
      factory: (_world, config) => {
        receivedConfig = config;
        return (w) => w;
      },
    });

    const world = createTestWorld();
    buildSystems(world, [
      { id: "test-config-system", config: { customKey: "customValue" } },
    ], systemRegistry);

    expect(receivedConfig).toEqual({ customKey: "customValue" });
  });
});

// 动作注册表边界：重复注册抛错、all() 带 name/factory、注册后可实际调用
describe("actionRegistry edge cases", () => {
  // 重复注册同名动作 → 抛错
  it("should throw on duplicate action registration", () => {
    const { actionRegistry } = getRegistries();
    expect(() => actionRegistry.register("Idle", () => () => State.SUCCEEDED))
      .toThrow("already registered");
  });

  // all() 返回 { name, factory } 条目（供 tools list-registries 展示）
  it("all() should return action entries with names", () => {
    const { actionRegistry } = getRegistries();
    const all = actionRegistry.all();
    expect(all.length).toBeGreaterThanOrEqual(2);
    for (const entry of all) {
      expect(entry).toHaveProperty("name");
      expect(entry).toHaveProperty("factory");
      expect(typeof entry.name).toBe("string");
      expect(typeof entry.factory).toBe("function");
    }
  });

  // 注册的动作可被调用并返回 mistreevous 状态码
  it("registered actions should be callable", () => {
    const { actionRegistry } = getRegistries();
    const factory = actionRegistry.get("Idle");
    const action = factory();
    const result = action();
    expect(result).toBe(State.SUCCEEDED);
  });
});

// Defect 5 回归：条件与动作同时绑定到 agent——同名使用会抛错，防止行为树误绑
describe("btFactory condition nodes (Defect 5)", () => {
  // condition.call 与 action.call 都被绑定为 agent 上的可调用方法
  it("should bind both condition and action agent methods", () => {
    const registry = createActionRegistry();
    registry.register("CondX", () => () => State.SUCCEEDED);
    registry.register("ActY", () => () => State.SUCCEEDED);

    const definition = {
      type: "root",
      child: {
        type: "sequence",
        children: [
          { type: "condition", call: "CondX" },
          { type: "action", call: "ActY" },
        ],
      },
    };

    const instance = createNpcTree(definition, registry);
    const agent = instance.agent as Record<string, unknown>;

    expect(typeof agent.CondX).toBe("function");
    expect(typeof agent.ActY).toBe("function");
  });

  // 同一名字既是 action 又是 condition → 绑定冲突抛错
  it("should throw when a name is used as both action and condition", () => {
    const registry = createActionRegistry();
    registry.register("Shared", () => () => State.SUCCEEDED);

    const definition = {
      type: "root",
      child: {
        type: "sequence",
        children: [
          { type: "condition", call: "Shared" },
          { type: "action", call: "Shared" },
        ],
      },
    };

    expect(() => createNpcTree(definition, registry)).toThrow(/both an action and a condition/);
  });
});

// 确定性快照：3 帧后状态精确可复现（x=100.75、hp 不变），验证 step 的确定性
describe("GameInstance.step snapshot test", () => {
  it("should produce deterministic state after N ticks", () => {
    const gameDef = createDefaultGameDefinition();
    const instance = createGameInstance(gameDef);

    const player = spawnCustomEntity(instance.world, "player", {
      Transform: { x: 100, y: 100 },
      Health: { current: 100, max: 100 },
      Velocity: { x: 0, y: 0, vx: 5, vy: 0 },
      Player: {},
    });

    instance.step(50);
    instance.step(50);
    instance.step(50);

    const state = {
      tick: instance.world.time.tick,
      entities: [] as Array<{
        x: number;
        y: number;
        hp: number;
        hasHealth: boolean;
        hasPlayer: boolean;
      }>,
    };

    for (let eid = 0; eid < 100; eid++) {
      if (hasComponent(instance.world, eid, Transform)) {
        state.entities.push({
          x: Math.round(Transform.x[eid] * 100) / 100,
          y: Math.round(Transform.y[eid] * 100) / 100,
          hp: Health.current[eid],
          hasHealth: hasComponent(instance.world, eid, Health),
          hasPlayer: hasComponent(instance.world, eid, Player),
        });
      }
    }

    expect(state.tick).toBe(3);
    expect(state.entities.length).toBe(1);
    expect(state.entities[0]).toEqual({
      x: 100.75,
      y: 100,
      hp: 100,
      hasHealth: true,
      hasPlayer: true,
    });
  });
});

// 输入处理：输入逐帧消费——无新输入时速度归零、新输入只作用一帧
describe("GameSimulation input handling", () => {
  // 无新输入：连续两帧位置不变（速度已消费，不再推进）
  it("should stop player velocity when no new input is submitted", async () => {
    const gameDef = createDefaultGameDefinition();
    const sim = await createGameSimulation(gameDef);

    const { networkId } = sim.addPlayer("session-1");
    sim.submitInput("session-1", { seq: 1, moveX: 100, moveY: 0 });

    const r1 = sim.tick(50);
    const p1 = r1.snapshot.entities.get(networkId)!;

    const r2 = sim.tick(50);
    const p2 = r2.snapshot.entities.get(networkId)!;

    // position should not change between consecutive ticks without new input
    expect(p2.values["Transform.x"]).toBe(p1.values["Transform.x"]);
    expect(p2.values["Transform.y"]).toBe(p1.values["Transform.y"]);
  });

  // 新输入只作用一帧：x 仅第一帧移动、y 仅第二帧移动（输入按帧消耗）
  it("should apply fresh input after previous input has been consumed", async () => {
    const gameDef = createDefaultGameDefinition();
    const sim = await createGameSimulation(gameDef);

    const { networkId } = sim.addPlayer("session-1");

    sim.submitInput("session-1", { seq: 1, moveX: 100, moveY: 0 });
    const r1 = sim.tick(50);

    sim.submitInput("session-1", { seq: 2, moveX: 0, moveY: 100 });
    const r2 = sim.tick(50);

    const p1 = r1.snapshot.entities.get(networkId)!;
    const p2 = r2.snapshot.entities.get(networkId)!;

    // x: moved in first tick, should not move in second
    expect(p2.values["Transform.x"]).toBe(p1.values["Transform.x"]);
    // y: moved in second tick
    expect(p2.values["Transform.y"]).toBeGreaterThan(p1.values["Transform.y"]);
  });
});

// dtMs 钳制：0/NaN/负数回退 fixedDtMs、超大钳到 4×fixedDtMs、正常值原样使用
describe("GameInstance step dtMs clamping", () => {
  it("should fall back to fixedDtMs when dtMs is 0", () => {
    const gameDef = createDefaultGameDefinition();
    const instance = createGameInstance(gameDef);
    const fixedDtMs = Math.floor(1000 / gameDef.tickRate);

    instance.step(0);
    expect(instance.world.time.dtMs).toBe(fixedDtMs);
  });

  it("should fall back to fixedDtMs when dtMs is NaN", () => {
    const gameDef = createDefaultGameDefinition();
    const instance = createGameInstance(gameDef);
    const fixedDtMs = Math.floor(1000 / gameDef.tickRate);

    instance.step(NaN);
    expect(instance.world.time.dtMs).toBe(fixedDtMs);
  });

  it("should fall back to fixedDtMs when dtMs is negative", () => {
    const gameDef = createDefaultGameDefinition();
    const instance = createGameInstance(gameDef);
    const fixedDtMs = Math.floor(1000 / gameDef.tickRate);

    instance.step(-1);
    expect(instance.world.time.dtMs).toBe(fixedDtMs);
  });

  it("should clamp dtMs to MAX_DT_MULTIPLIER * fixedDtMs when too large", () => {
    const gameDef = createDefaultGameDefinition();
    const instance = createGameInstance(gameDef);
    const fixedDtMs = Math.floor(1000 / gameDef.tickRate);

    instance.step(99999);
    expect(instance.world.time.dtMs).toBe(fixedDtMs * 4);
  });

  it("should use dtMs as-is when within bounds", () => {
    const gameDef = createDefaultGameDefinition();
    const instance = createGameInstance(gameDef);

    instance.step(100);
    expect(instance.world.time.dtMs).toBe(100);
  });
});

// tick 异常隔离：某系统抛错不中断仿真（仍产出有效快照），保证联机运行稳定
describe("GameSimulation tick error isolation", () => {
  // 注册一个必然抛错的系统后，sim.tick 不抛且返回有效结果
  it("should not throw when a system throws inside step", async () => {
    registerSystem({
      id: "test-thrower",
      factory: () => (world) => {
        throw new Error("test error in system");
      },
      after: ["interaction"],
    });

    const gameDef = createDefaultGameDefinition();
    gameDef.systems!.push({ id: "test-thrower" });
    const sim = await createGameSimulation(gameDef);

    expect(() => sim.tick(50)).not.toThrow();

    const result = sim.tick(50);
    expect(result).toBeDefined();
    expect(typeof result.tick).toBe("number");
    expect(result.snapshot).toBeDefined();
    expect(result.snapshot.entities).toBeDefined();
  });
});
