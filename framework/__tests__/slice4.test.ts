/**
 * Slice 4 测试：昼夜循环 / 条件刷怪 / 行为树扩展 / 放置 链路。
 *
 * 覆盖：dayNightCycleSystem、刷怪条件（isNight）、BT 通用节点
 * （IsNight/Sleep/IsInLight）、夜间敌对与火光回避集成、placeEntity 放置原子、
 * GameSimulation place 命令与 timeOfDay 快照，以及真实 game 配置集成。
 */
import { makeTestGeometry } from "./helpers/mapGeometry";
import { describe, it, expect, beforeAll } from "vitest";
import { addComponent, addEntity, query } from "bitecs";
import { State } from "mistreevous";
import {
  bootstrapFramework,
  createGameInstance,
  createGameSimulation,
  createDefaultGameDefinition,
  loadGameDefinition,
  spawnEntity,
  getRegistries,
  getSpawnCondition,
  PHASE_DAY,
  PHASE_NIGHT,
} from "framework/index";
import { Transform } from "framework/components/transform";
import { Velocity, Collider, ColliderShape } from "framework/components/physics";
import { Health, Team } from "framework/components/combat";
import { Cooldown } from "framework/components/timer";
import { NetworkId } from "framework/components/network";
import { Player, NPC, Enemy, Resource } from "framework/components/tags";
import { Perception } from "framework/components/perception";
import { LightSource } from "framework/components/lightSource";
import { Placeable } from "framework/components/placeable";
import { CraftingStation } from "framework/components/craftingStation";
import { Inventory, type InventoryEntry } from "framework/components/inventory";
import { Kind } from "framework/components/kind";
import { dayNightCycleSystem } from "framework/systems/gameplay/dayNightCycleSystem";
import { spawningSystem } from "framework/systems/gameplay/spawningSystem";
import { placeEntity } from "framework/systems/gameplay/placeableSystem";
import { aiSystem, setEntityKind } from "framework/systems/gameplay/aiSystem";
import { perceptionSystem } from "framework/systems/gameplay/perceptionSystem";
import { movementSystem } from "framework/systems/core/movementSystem";
import { createNpcTree } from "framework/ai/btFactory";
import { stepBehaviourTree } from "framework/ai/btRunner";
import { createBlackboard } from "framework/ai/blackboard";
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

function setDayNightRule(world: GameWorld, rule: { cycleLengthSec: number; nightStartHour?: number; nightEndHour?: number }): void {
  world.gameDef.resolvedRules["daynight"] = rule;
}

function setPlaceRule(world: GameWorld, rule: { placeRange: number }): void {
  world.gameDef.resolvedRules["place"] = rule;
}

/** 注册测试原型（全局注册表单例，跨用例重复注册会抛错 → 已存在则跳过）。 */
function ensureArchetype(world: GameWorld, spec: Parameters<typeof world.archetypes.register>[0]): void {
  if (!world.archetypes.has(spec.kind)) {
    world.archetypes.register(spec);
  }
}

/** 给裸 world 挂一块 8×8 测试地图（128×128 像素，全可走，常驻激活）。 */
function attachTestMap(world: GameWorld): void {
  world.maps["test"] = makeTestGeometry({ key: "test", width: 8, height: 8 });
  world.activeMaps.add("test");
  world.defaultMapId = "test";
}

interface PlayerOpts {
  x?: number; y?: number; hp?: number; capacity?: number; team?: number;
}

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
  Team.id[eid] = opts.team ?? 1;
  Inventory[eid] = {
    capacity: opts.capacity ?? 4,
    slots: Array.from({ length: opts.capacity ?? 4 }, () => null),
  };
  NetworkId.value[eid] = world.nextNetworkId++;
  setEntityKind(world, eid, "test-player");
  return eid;
}

interface HunterOpts { x?: number; y?: number; hp?: number; }

/** 经 spawnEntity 走真实 spawn 路径的测试 NPC（夜间猎手行为由注册的 w1 原型驱动）。 */
function spawnTestHunter(world: GameWorld, opts: HunterOpts = {}): number {
  const { componentRegistry, archetypeRegistry } = getRegistries();
  const eid = spawnEntity(world, archetypeRegistry.get("w1"), componentRegistry, {
    x: opts.x ?? 0,
    y: opts.y ?? 0,
  });
  if (opts.hp !== undefined) Health.current[eid] = opts.hp;
  // legacy 组件数组全局共享：显式清零残留，防上一用例的冷却拦截本次攻击
  Cooldown.remainingMs[eid] = 0;
  return eid;
}

/** 注册 w1 原型（NPC+Enemy、感知/攻击/冷却）+ w1-night 行为树（夜间猎手，复用 game 行为结构）。 */
function registerHunterArchetypeAndBehavior(world: GameWorld): void {
  ensureArchetype(world, {
    kind: "w1",
    tags: ["NPC", "Enemy"],
    components: {
      Size: { w: 22, h: 14 },
      Velocity: {},
      Collider: { shape: 1, halfW: 11, halfH: 7 },
      Health: { current: 80, max: 80 },
      Attack: { value: 10, range: 32 },
      Cooldown: {},
      Perception: { visionRadius: 180, hostilityRange: 100 },
    },
    behavior: "w1-night",
    team: 2,
  });
  world.gameDef.resolvedBehaviors = [
    {
      id: "w1-night",
      definition: {
        type: "root",
        child: {
          type: "selector",
          children: [
            {
              type: "sequence",
              children: [
                { type: "condition", call: "IsNight" },
                { type: "condition", call: "IsInLight" },
                { type: "action", call: "Sleep" },
              ],
            },
            {
              type: "sequence",
              while: { call: "IsNight" },
              children: [
                { type: "condition", call: "IsTargetInVision" },
                { type: "action", call: "Chase", args: { speed: 70 } },
                { type: "condition", call: "InAttackRange" },
                { type: "action", call: "Attack" },
              ],
            },
            { type: "action", call: "Sleep" },
          ],
        },
      },
    },
  ];
}

function spawnTestLight(world: GameWorld, opts: { x?: number; y?: number; radius?: number; fuel?: number } = {}): number {
  const eid = addEntity(world);
  addComponent(world, eid, Transform);
  addComponent(world, eid, NetworkId);
  addComponent(world, eid, LightSource);
  Transform.x[eid] = opts.x ?? 0;
  Transform.y[eid] = opts.y ?? 0;
  LightSource.radius[eid] = opts.radius ?? 50;
  LightSource.fuelRemainingMs[eid] = opts.fuel ?? 1_000_000_000;
  NetworkId.value[eid] = world.nextNetworkId++;
  setEntityKind(world, eid, "test-light");
  return eid;
}

function fillInventory(inv: InventoryEntry, entries: { kind: string; count: number }[]): void {
  for (let i = 0; i < entries.length; i++) {
    inv.slots[i] = { ...entries[i] };
  }
}

// 昼夜系统：hour 按 cycleLengthSec 推进，跨 nightStart/nightEnd 边界切换相位（支持跨午夜）；无规则时冻结
describe("Slice 4：dayNightCycleSystem", () => {
  it("初始状态：世界从 8 时白天开始", () => {
    const world = createBareWorld();
    expect(world.time.timeOfDay.hour).toBe(8);
    expect(world.time.timeOfDay.phase).toBe(PHASE_DAY);
  });

  it("hour 按 cycleLengthSec 推进；跨 19 时切夜、跨 5 时切昼（支持跨午夜）", () => {
    const world = createBareWorld();
    setDayNightRule(world, { cycleLengthSec: 600, nightStartHour: 19, nightEndHour: 5 });

    // 18.99 + 100 秒（≈4 小时）→ 22.99 → 夜
    world.time.timeOfDay.hour = 18.99;
    world.time.dtMs = 100_000;
    dayNightCycleSystem(world);
    expect(world.time.timeOfDay.phase).toBe(PHASE_NIGHT);
    expect(world.time.timeOfDay.hour).toBeCloseTo(22.99, 5);

    // 3.99 + 100 秒 → 7.99（跨过 5 时）→ 昼
    world.time.timeOfDay.hour = 3.99;
    dayNightCycleSystem(world);
    expect(world.time.timeOfDay.phase).toBe(PHASE_DAY);

    // 小时跨日取模：22 + 4 → 2（仍在夜晚区间）
    world.time.timeOfDay.hour = 22;
    dayNightCycleSystem(world);
    expect(world.time.timeOfDay.hour).toBeCloseTo(2, 5);
    expect(world.time.timeOfDay.phase).toBe(PHASE_NIGHT);
  });

  it("无 daynight 规则 → no-op（时间冻结）", () => {
    const world = createBareWorld();
    world.time.timeOfDay.hour = 12;
    world.time.dtMs = 100_000;
    dayNightCycleSystem(world);
    expect(world.time.timeOfDay.hour).toBe(12);
    expect(world.time.timeOfDay.phase).toBe(PHASE_DAY);
  });
});

// 条件刷怪：condition 按 world 状态判定（isNight 等），不满足不刷、满足时刷到 max 为止；未注册的条件抛错
describe("Slice 4：spawn condition（条件刷怪）", () => {
  it("isNight 条件按相位判定", () => {
    const world = createBareWorld();
    const cond = getSpawnCondition("isNight");
    world.time.timeOfDay.phase = PHASE_DAY;
    expect(cond(world)).toBe(false);
    world.time.timeOfDay.phase = PHASE_NIGHT;
    expect(cond(world)).toBe(true);
  });

  it("spawningSystem 已退役：条件刷怪规则注入也不产出实体（条件语义归演化引擎）", () => {
    const world = createBareWorld();
    attachTestMap(world);
    ensureArchetype(world, { kind: "sw1", components: {} });
    world.gameDef.resolvedSpawns = [
      { kind: "sw1", zoneId: 1, max: 2, respawnMs: 0, condition: "isNight" },
    ];

    const countWolves = () => query(world, [Transform]).filter((e) => Kind[e] === "sw1").length;

    world.time.timeOfDay.phase = PHASE_NIGHT;
    spawningSystem(world);
    spawningSystem(world);
    expect(countWolves()).toBe(0);
  });

  it("未注册的 condition → 演化引擎求值时抛错（条件校验随引擎走）", () => {
    const world = createBareWorld();
    attachTestMap(world);
    ensureArchetype(world, { kind: "sw2", components: {} });
    expect(() => getSpawnCondition("nope")).toThrow(/not registered|unknown/i);
  });
});

// BT 通用节点：IsNight 判相位、Sleep 清速度、IsInLight 按光源半径与燃料判定（燃料耗尽不发光）
describe("Slice 4：BT 通用节点 IsNight / Sleep / IsInLight", () => {
  function makeInstance(world: GameWorld, node: unknown) {
    const inst = createNpcTree({ type: "root", child: node }, world.actions);
    const bb = createBlackboard(-1);
    return { inst, bb };
  }

  it("IsNight：夜 true / 昼 false", () => {
    const world = createBareWorld();
    const { inst, bb } = makeInstance(world, { type: "condition", call: "IsNight" });
    world.time.timeOfDay.phase = PHASE_NIGHT;
    stepBehaviourTree(inst, { world, self: 1, bb });
    expect(inst.tree.getState()).toBe(State.SUCCEEDED);
    world.time.timeOfDay.phase = PHASE_DAY;
    inst.tree.reset();
    stepBehaviourTree(inst, { world, self: 1, bb });
    expect(inst.tree.getState()).toBe(State.FAILED);
  });

  it("Sleep：清零速度并完成一帧（SUCCEEDED，树每 tick 重置 → 条件变化即时改判）", () => {
    const world = createBareWorld();
    const self = addEntity(world);
    addComponent(world, self, Velocity);
    Velocity.vx[self] = 100;
    Velocity.vy[self] = 50;
    const { inst, bb } = makeInstance(world, { type: "action", call: "Sleep" });
    stepBehaviourTree(inst, { world, self, bb });
    expect(inst.tree.getState()).toBe(State.SUCCEEDED);
    expect(Velocity.vx[self]).toBe(0);
    expect(Velocity.vy[self]).toBe(0);
  });

  it("IsInLight：半径内 true / 半径外 false / 燃料耗尽 false", () => {
    const world = createBareWorld();
    spawnTestLight(world, { x: 0, y: 0, radius: 50 });
    const { inst, bb } = makeInstance(world, { type: "condition", call: "IsInLight" });

    const self = addEntity(world);
    addComponent(world, self, Transform);
    Transform.x[self] = 20;
    Transform.y[self] = 0;
    stepBehaviourTree(inst, { world, self, bb });
    expect(inst.tree.getState()).toBe(State.SUCCEEDED);

    Transform.x[self] = 100;
    inst.tree.reset();
    stepBehaviourTree(inst, { world, self, bb });
    expect(inst.tree.getState()).toBe(State.FAILED);

    // 燃料耗尽 → 不发光
    const light = query(world, [LightSource])[0];
    LightSource.fuelRemainingMs[light] = 0;
    Transform.x[self] = 20;
    inst.tree.reset();
    stepBehaviourTree(inst, { world, self, bb });
    expect(inst.tree.getState()).toBe(State.FAILED);
  });
});

// 集成：夜间敌对实体追击光外玩家、天亮中断追击、光内目标不可感知（回避火光）、目标出入视野即醒/眠
describe("Slice 4 集成：夜间敌对 + 火光回避（通用光源机制）", () => {
  /** 跑一帧感知+AI+移动（dt=50ms）。 */
  function stepTick(world: GameWorld): void {
    world.time.tick += 1;
    world.time.dtMs = 50;
    perceptionSystem(world);
    aiSystem(world);
    movementSystem(world);
  }

  it("白天猎手入睡不敌对：玩家在视野内也不攻击", () => {
    const world = createBareWorld();
    registerHunterArchetypeAndBehavior(world);
    const player = spawnTestPlayer(world, { x: 0, y: 0, hp: 100 });
    const hunter = spawnTestHunter(world, { x: 10, y: 0 });

    world.time.timeOfDay.phase = PHASE_DAY;
    for (let i = 0; i < 5; i++) stepTick(world);
    expect(Health.current[player]).toBe(100);
    expect(Velocity.vx[hunter]).toBe(0);
  });

  it("夜晚猎手追击并攻击视野内玩家（不在光内）", () => {
    const world = createBareWorld();
    registerHunterArchetypeAndBehavior(world);
    const player = spawnTestPlayer(world, { x: 0, y: 0, hp: 100 });
    const hunter = spawnTestHunter(world, { x: 10, y: 0 });

    world.time.timeOfDay.phase = PHASE_NIGHT;
    for (let i = 0; i < 5; i++) stepTick(world);
    expect(Health.current[player]).toBeLessThan(100);
  });

  it("昼夜切换：追击中天亮 → while guard 中断追击，狼入睡且速度清零（不再攻击）", () => {
    const world = createBareWorld();
    registerHunterArchetypeAndBehavior(world);
    const player = spawnTestPlayer(world, { x: 0, y: 0, hp: 100 });
    const hunter = spawnTestHunter(world, { x: 10, y: 0 });

    // 夜：追击并攻击
    world.time.timeOfDay.phase = PHASE_NIGHT;
    for (let i = 0; i < 5; i++) stepTick(world);
    expect(Health.current[player]).toBeLessThan(100);

    // 天亮：分支 2 的 while IsNight guard 每 tick 重评估 → 中断追击
    world.time.timeOfDay.phase = PHASE_DAY;
    const hpAfterDawn = Health.current[player];
    for (let i = 0; i < 10; i++) stepTick(world);
    expect(Health.current[player]).toBe(hpAfterDawn);
    expect(Velocity.vx[hunter]).toBe(0);
    expect(Velocity.vy[hunter]).toBe(0);
  });

  it("火光回避：夜晚玩家在火光内 → 猎手不接近也不攻击（感知侧回避）", () => {
    const world = createBareWorld();
    registerHunterArchetypeAndBehavior(world);
    spawnTestLight(world, { x: 0, y: 0, radius: 80 });
    const player = spawnTestPlayer(world, { x: 0, y: 0, hp: 100 });
    const hunter = spawnTestHunter(world, { x: 0, y: 150 });

    world.time.timeOfDay.phase = PHASE_NIGHT;
    for (let i = 0; i < 60; i++) stepTick(world);

    // 玩家未受攻击；猎手从未逼近火光（感知不到光内的玩家，保持入睡）
    expect(Health.current[player]).toBe(100);
    const distToFire = Math.hypot(Transform.x[hunter], Transform.y[hunter]);
    expect(distToFire).toBeGreaterThan(120);
    expect(Math.hypot(Velocity.vx[hunter], Velocity.vy[hunter])).toBe(0);
  });

  it("火光回避（感知侧）：玩家离开火光 → 猎手立即感知并追击", () => {
    const world = createBareWorld();
    registerHunterArchetypeAndBehavior(world);
    spawnTestLight(world, { x: 0, y: 0, radius: 80 });
    const player = spawnTestPlayer(world, { x: 0, y: 0, hp: 100 });
    const hunter = spawnTestHunter(world, { x: 0, y: 150 });

    world.time.timeOfDay.phase = PHASE_NIGHT;
    stepTick(world);
    expect(Math.hypot(Velocity.vx[hunter], Velocity.vy[hunter])).toBe(0); // 光内 → 不入眼

    // 玩家走出火光（(90,60)：距火光 108 > 80，距猎手 127 < 180）→ 被唤醒追击
    Transform.x[player] = 90;
    Transform.y[player] = 60;
    for (let i = 0; i < 3; i++) stepTick(world);
    expect(Velocity.vx[hunter]).not.toBe(0);
    expect(Velocity.vy[hunter]).not.toBe(0);
  });

  it("夜晚无目标时猎手保持入睡；目标进入视野 → guard 见敌即醒（睡眠不卡死）", () => {
    const world = createBareWorld();
    registerHunterArchetypeAndBehavior(world);
    const player = spawnTestPlayer(world, { x: 500, y: 0, hp: 100 }); // 超出感知 180
    const hunter = spawnTestHunter(world, { x: 0, y: 0 });

    world.time.timeOfDay.phase = PHASE_NIGHT;
    for (let i = 0; i < 5; i++) stepTick(world);
    expect(Velocity.vx[hunter]).toBe(0);
    expect(Velocity.vy[hunter]).toBe(0);

    // 玩家进入视野（150 < 180，无光源）→ guard 中断睡眠，树重置后追击
    Transform.x[player] = 150;
    for (let i = 0; i < 3; i++) stepTick(world);
    expect(Velocity.vx[hunter]).not.toBe(0);
  });
});

// 放置原子：合法则入位（GridOccupancy + 资源产出/消耗 + owner）并返回 eid；超距/非法占位/无资产拒
describe("Slice 4：placeEntity 放置原子", () => {
  /** 注册可放置原型 plc（Placeable footprint 20×20）+ 放置物品 k1。 */
  function setupPlaceable(world: GameWorld): void {
    ensureArchetype(world, {
      kind: "plc",
      components: {
        Placeable: { footprintW: 20, footprintH: 20, canCollide: 1 },
        Size: { w: 20, h: 20 },
        Collider: { shape: 1, halfW: 10, halfH: 10 },
      },
    });
    setItemKind(world, { kind: "k1", maxStack: 1, place: { archetype: "plc" } });
  }

  it("成功：范围内放置 → 生成实体 + 消耗物品", () => {
    const world = createBareWorld();
    setupPlaceable(world);
    const player = spawnTestPlayer(world, { x: 0, y: 0 });
    fillInventory(Inventory[player]!, [{ kind: "k1", count: 1 }]);

    expect(placeEntity(world, player, 0, 30, 0)).toBe(true);
    expect(Inventory[player]!.slots[0]).toBeNull();
    const placed = query(world, [Placeable]);
    expect(placed.length).toBe(1);
    expect(Transform.x[placed[0]]).toBe(30);
  });

  it("超距拒绝：零副作用", () => {
    const world = createBareWorld();
    setupPlaceable(world);
    const player = spawnTestPlayer(world, { x: 0, y: 0 });
    fillInventory(Inventory[player]!, [{ kind: "k1", count: 1 }]);

    expect(placeEntity(world, player, 0, 100, 0)).toBe(false);
    expect(Inventory[player]!.slots[0]).toEqual({ kind: "k1", count: 1 });
    expect(query(world, [Placeable]).length).toBe(0);
  });

  it("placeRange 走 rules/place.json 配置", () => {
    const world = createBareWorld();
    setupPlaceable(world);
    setPlaceRule(world, { placeRange: 20 });
    const player = spawnTestPlayer(world, { x: 0, y: 0 });
    fillInventory(Inventory[player]!, [{ kind: "k1", count: 1 }]);

    expect(placeEntity(world, player, 0, 30, 0)).toBe(false);
    expect(placeEntity(world, player, 0, 15, 0)).toBe(true);
  });

  it("与现有实体重叠拒绝", () => {
    const world = createBareWorld();
    setupPlaceable(world);
    const player = spawnTestPlayer(world, { x: 0, y: 0 });
    fillInventory(Inventory[player]!, [{ kind: "k1", count: 1 }]);
    // 在 (40,0) 放一个带 Collider 的实体
    const blocker = addEntity(world);
    addComponent(world, blocker, Transform);
    addComponent(world, blocker, NetworkId);
    addComponent(world, blocker, Placeable);
    addComponent(world, blocker, Collider);
    Transform.x[blocker] = 40;
    Collider.shape[blocker] = 1;
    Collider.halfW[blocker] = 10;
    Collider.halfH[blocker] = 10;
    Placeable.footprintW[blocker] = 20;
    Placeable.footprintH[blocker] = 20;
    Placeable.canCollide[blocker] = 1;

    expect(placeEntity(world, player, 0, 40, 0)).toBe(false);
    expect(Inventory[player]!.slots[0]).toEqual({ kind: "k1", count: 1 });
  });

  it("压地图阻挡格拒绝", () => {
    const world = createBareWorld();
    world.maps["test"] = makeTestGeometry({
      key: "test",
      width: 8,
      height: 8,
      blocked: (tx, ty) => tx === 1 && ty === 1,
    });
    world.activeMaps.add("test");
    world.defaultMapId = "test";
    setupPlaceable(world);
    const player = spawnTestPlayer(world, { x: 0, y: 0 });
    fillInventory(Inventory[player]!, [{ kind: "k1", count: 1 }]);

    // footprint 20 → (24,8) 覆盖 x 格 0.9~2.1 / y 格 -0.1~1.1 → 含 (1,1) → 拒
    expect(placeEntity(world, player, 0, 24, 8)).toBe(false);
    expect(placeEntity(world, player, 0, 40, 0)).toBe(true); // 空旷且范围内（dist 40）成功
  });

  it("不可放置物品 / 未知 archetype / 空槽 → 拒绝且不抛", () => {
    const world = createBareWorld();
    setupPlaceable(world);
    setItemKind(world, { kind: "m1", maxStack: 50 });
    setItemKind(world, { kind: "bad", maxStack: 1, place: { archetype: "nope" } });
    const player = spawnTestPlayer(world, { x: 0, y: 0 });
    fillInventory(Inventory[player]!, [
      { kind: "m1", count: 3 },
      { kind: "bad", count: 1 },
    ]);

    expect(placeEntity(world, player, 0, 30, 0)).toBe(false); // 无 place 声明
    expect(placeEntity(world, player, 1, 30, 0)).toBe(false); // 未知 archetype
    expect(placeEntity(world, player, 2, 30, 0)).toBe(false); // 空槽
  });
});

// GameSimulation 命令路由：place 命令从传输层进入世界并落位；timeOfDay 进入快照可同步给客户端
describe("Slice 4：GameSimulation place 命令 + timeOfDay 快照", () => {
  it("submitCommand place 生效；死亡窗口拒绝", async () => {
    const gameDef = createDefaultGameDefinition();
    const sim = await createGameSimulation(gameDef);
    const world = (sim as unknown as { world: GameWorld }).world;
    ensureArchetype(world, {
      kind: "plc",
      components: { Placeable: { footprintW: 20, footprintH: 20, canCollide: 1 } },
    });
    setItemKind(world, { kind: "k1", maxStack: 1, place: { archetype: "plc" } });

    sim.addPlayer("s1");
    const playerEid = query(world, [Player])[0];
    Inventory[playerEid]!.slots[0] = { kind: "k1", count: 1 };

    expect(sim.submitCommand("s1", { type: "place", slot: 0, x: 30, y: 0 })).toBe(true);
    expect(query(world, [Placeable]).length).toBe(1);

    // 死亡守卫
    Inventory[playerEid]!.slots[0] = { kind: "k1", count: 1 };
    Health.current[playerEid] = 0;
    expect(sim.submitCommand("s1", { type: "place", slot: 0, x: 40, y: 0 })).toBe(false);
  });

  it("tick 快照携带 world 级 timeOfDay", async () => {
    const gameDef = createDefaultGameDefinition();
    const sim = await createGameSimulation(gameDef);
    sim.addPlayer("s1");
    const { snapshot } = sim.tick(50);

    expect(snapshot.timeOfDay).toBeDefined();
    expect(snapshot.timeOfDay!.hour).toBe(8);
    expect(snapshot.timeOfDay!.phase).toBe(PHASE_DAY);
  });
});

// 真实 game 配置集成：昼夜相位、条件刷怪、光源、放置全部走配置数据端到端生效
describe("Slice 4：真实 game 配置（昼夜 + 条件刷怪 + 光源 + 放置）", () => {
  it("validateIntegrity：条件刷怪 / 夜间行为（含 guard）/ 放置引用全部通过", () => {
    const def = loadGameDefinition({ gameJsonPath: "game/game.json" });

    const daynight = def.resolvedRules["daynight"] as { cycleLengthSec: number };
    expect(daynight.cycleLengthSec).toBe(600);

    // 存在引用 isNight 条件的演化规则（真实配置加载即校验通过）
    const conditioned = def.resolvedEntityRules.filter((r) => r.condition === "isNight");
    expect(conditioned.length).toBeGreaterThan(0);

    const kit = def.resolvedItems.find((i) => i.kind === "campfire_kit");
    expect(kit?.place?.archetype).toBe("campfire");
  });

  it("真实原型：campfire 带 LightSource/CraftingStation/Placeable", () => {
    const def = loadGameDefinition({ gameJsonPath: "game/game.json" });
    const world = createGameInstance(def).world;
    const { componentRegistry, archetypeRegistry } = getRegistries();

    const campfire = spawnEntity(world, archetypeRegistry.get("campfire"), componentRegistry, { x: 0, y: 0 });
    expect(LightSource.radius[campfire]).toBe(80);
    expect(CraftingStation.stationType[campfire]).toBe(1);
    expect(Placeable.footprintW[campfire]).toBe(24);
  });

  it("demo 主线：合成火堆套件（通用配方覆写）→ 放置真实 campfire → 站点合成可用", async () => {
    const def = loadGameDefinition({ gameJsonPath: "game/game.json" });
    def.resolvedSpawns = [];
    def.resolvedRules["crafting"] = {
      recipes: [
        { id: "kit", inputs: [{ kind: "m1", count: 3 }, { kind: "m2", count: 2 }], outputs: [{ kind: "k1", count: 1 }] },
        { id: "cook", stationType: 1, inputs: [{ kind: "m3", count: 1 }], outputs: [{ kind: "m4", count: 1 }] },
      ],
      stationRange: 64,
    };
    const sim = await createGameSimulation(def);
    const world = (sim as unknown as { world: GameWorld }).world;
    setItemKind(world, { kind: "m1", maxStack: 50 });
    setItemKind(world, { kind: "m2", maxStack: 50 });
    setItemKind(world, { kind: "k1", maxStack: 1, place: { archetype: "campfire" } });
    setItemKind(world, { kind: "m3", maxStack: 20 });
    setItemKind(world, { kind: "m4", maxStack: 20 });

    sim.addPlayer("s1");
    const playerEid = query(world, [Player])[0];
    const inv = Inventory[playerEid]!;
    fillInventory(inv, [
      { kind: "m1", count: 3 },
      { kind: "m2", count: 2 },
      { kind: "m3", count: 1 },
    ]);

    // 合成火堆套件
    expect(sim.submitCommand("s1", { type: "craft", recipe: "kit" })).toBe(true);
    const kitSlot = inv.slots.findIndex((s) => s?.kind === "k1");
    expect(kitSlot).toBeGreaterThanOrEqual(0);

    // 放置：真实地图阻挡格随机 → 以玩家为原点偏移，命中阻挡则换方向再试
    let placed = false;
    for (const dx of [30, 50, 70, -30, -50]) {
      if (sim.submitCommand("s1", { type: "place", slot: kitSlot, x: Transform.x[playerEid] + dx, y: Transform.y[playerEid] })) {
        placed = true;
        break;
      }
    }
    expect(placed).toBe(true);

    const fires = query(world, [LightSource]);
    expect(fires.length).toBeGreaterThanOrEqual(1);
    // 开机演化可能已铺放远处 campfire——只要求玩家附近存在本次放置的火堆
    const nearFire = fires.some(
      (f) => Math.hypot(Transform.x[f] - Transform.x[playerEid], Transform.y[f] - Transform.y[playerEid]) <= 96,
    );
    expect(nearFire).toBe(true);

    // 放在火堆旁 → 站点合成可用（stationType=1 匹配真实 campfire）
    expect(sim.submitCommand("s1", { type: "craft", recipe: "cook" })).toBe(true);
    expect(inv.slots.some((s) => s?.kind === "m4")).toBe(true);
  });

  it("真实 netSync 接线：LightSource/Placeable 字段与 timeOfDay 进入快照", async () => {
    const def = loadGameDefinition({ gameJsonPath: "game/game.json" });
    def.resolvedSpawns = [];
    const sim = await createGameSimulation(def);
    const world = (sim as unknown as { world: GameWorld }).world;
    const { componentRegistry, archetypeRegistry } = getRegistries();
    spawnEntity(world, archetypeRegistry.get("campfire"), componentRegistry, { x: 10, y: 10 });

    const { snapshot } = sim.tick(50);
    const light = query(world, [LightSource])[0];
    const snap = snapshot.entities.get(NetworkId.value[light]);
    expect(snap).toBeDefined();
    expect(snap!.values["LightSource.radius"]).toBe(80);
    expect(snap!.values["LightSource.fuelRemainingMs"]).toBeGreaterThan(0);
    expect(snap!.values["Placeable.footprintW"]).toBe(24);
    expect(snapshot.timeOfDay).toBeDefined();
    expect(snapshot.timeOfDay!.phase).toBe(PHASE_DAY);
  });
});
