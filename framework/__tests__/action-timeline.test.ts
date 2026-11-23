/**
 * CC-03 动作时间轴测试：阶段事件、目标解析、移动锁、打断、同步 key。
 *
 * 用真实 game/actions/actions.json 的数值做集成断言（attack 12/4/7/12、
 * gather 10/3/6/10、throw 8/4/5/8），单位测试则用同一形状的内联配置，
 * 覆盖「无配置回退旧瞬时行为」。
 */
import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { addComponent, addEntity, query } from "bitecs";
import {
  bootstrapFramework,
  createDefaultGameDefinition,
  createGameInstance,
  createGameSimulation,
  loadGameDefinition,
} from "framework/index";
import type { GameWorld, System } from "framework/world";
import { Transform } from "framework/components/transform";
import { Velocity } from "framework/components/physics";
import { Health, Attack } from "framework/components/combat";
import { Cooldown } from "framework/components/timer";
import { NetworkId } from "framework/components/network";
import { Player, Enemy, Resource } from "framework/components/tags";
import { Inventory, type InventoryEntry } from "framework/components/inventory";
import { Equipment } from "framework/components/equipment";
import { ResourceNode, type ResourceNodeState } from "framework/components/resourceNode";
import { Intent } from "framework/components/intent";
import { EntityMap } from "framework/components/entityMap";
import { Projectile } from "framework/components/projectile";
import { createInteractionSystem } from "framework/systems/gameplay/interactionSystem";
import { combatSystem } from "framework/systems/gameplay/combatSystem";
import { startConfiguredAction, startThrowAction, createActionSystem } from "framework/simulation/actions/actionSystem";
import {
  ActionInput,
  ActionState,
} from "framework/simulation/actions/actionState";
import type { ActionDefinition } from "framework/config/schema/ActionSchema";
import type { ItemKindSpec } from "framework/config/schema/ItemKindSchema";

beforeAll(() => {
  bootstrapFramework();
});

beforeEach(() => {
  // AoS 数组是模块级单例：清空动作状态，防跨用例 eid 复用串扰。
  for (let i = 0; i < ActionState.length; i++) ActionState[i] = undefined;
  for (let i = 0; i < ActionInput.length; i++) ActionInput[i] = undefined;
});

/** 与 game/actions/actions.json 同形的最小配置（单位测试可控时间轴）。 */
const TEST_ACTIONS: Record<string, ActionDefinition> = {
  attack: {
    durationTicks: 12,
    phases: [
      { id: "windup", endTick: 4 },
      { id: "active", endTick: 7 },
      { id: "recovery", endTick: 12 },
    ],
    events: [{ phase: "active", type: "hit" }],
    lockMovement: true,
    interruptible: false,
    cooldownTicks: 20,
    cancelOnDamage: false,
  },
  gather: {
    durationTicks: 10,
    phases: [
      { id: "windup", endTick: 3 },
      { id: "swing", endTick: 6 },
      { id: "recovery", endTick: 10 },
    ],
    events: [{ phase: "swing", type: "harvest" }],
    lockMovement: true,
    interruptible: false,
    cooldownTicks: 14,
    cancelOnDamage: false,
  },
  throw: {
    durationTicks: 8,
    phases: [
      { id: "windup", endTick: 4 },
      { id: "release", endTick: 5 },
      { id: "recovery", endTick: 8 },
    ],
    events: [{ phase: "release", type: "spawn-projectile" }],
    lockMovement: true,
    interruptible: false,
    cooldownTicks: 20,
    cancelOnDamage: false,
  },
};

const TEST_CONFIG = {
  actions: TEST_ACTIONS,
  intentActions: { attack: "attack", interact: "gather", throw: "throw" },
};

function createBareWorld(): GameWorld {
  return createGameInstance(createDefaultGameDefinition()).world;
}

interface PlayerOptions {
  x?: number;
  y?: number;
  hp?: number;
  attack?: { value: number; range?: number };
}

function spawnPlayer(world: GameWorld, options: PlayerOptions = {}): number {
  const eid = addEntity(world);
  addComponent(world, eid, Transform);
  addComponent(world, eid, NetworkId);
  addComponent(world, eid, Player);
  addComponent(world, eid, Health);
  addComponent(world, eid, Cooldown);
  addComponent(world, eid, Velocity);
  addComponent(world, eid, Attack);
  Transform.x[eid] = options.x ?? 0;
  Transform.y[eid] = options.y ?? 0;
  Health.current[eid] = options.hp ?? 100;
  Health.max[eid] = 100;
  Attack.value[eid] = options.attack?.value ?? 50;
  Attack.range[eid] = options.attack?.range ?? 0;
  Cooldown.remainingMs[eid] = 0;
  Inventory[eid] = {
    capacity: 8,
    slots: Array.from({ length: 8 }, () => null),
  };
  addComponent(world, eid, Equipment);
  Equipment.weaponSlot[eid] = -1;
  Equipment.toolSlot[eid] = -1;
  Equipment.armorSlot[eid] = -1;
  NetworkId.value[eid] = world.nextNetworkId++;
  return eid;
}

function spawnEnemy(world: GameWorld, x: number, y: number, hp = 100): number {
  const eid = addEntity(world);
  addComponent(world, eid, Transform);
  addComponent(world, eid, NetworkId);
  addComponent(world, eid, Health);
  addComponent(world, eid, Enemy);
  Transform.x[eid] = x;
  Transform.y[eid] = y;
  Health.current[eid] = hp;
  Health.max[eid] = hp;
  NetworkId.value[eid] = world.nextNetworkId++;
  return eid;
}

function spawnResource(
  world: GameWorld,
  x: number,
  y: number,
  state: Partial<ResourceNodeState> = {},
): number {
  const eid = addEntity(world);
  addComponent(world, eid, Transform);
  addComponent(world, eid, NetworkId);
  addComponent(world, eid, Resource);
  Transform.x[eid] = x;
  Transform.y[eid] = y;
  const remaining = state.remaining ?? 5;
  ResourceNode[eid] = {
    remaining,
    max: state.max ?? remaining,
    amountPerHit: state.amountPerHit ?? 1,
    regenMs: state.regenMs ?? 0,
    yieldsKind: state.yieldsKind ?? "test_wood",
    infinite: state.infinite ?? false,
    depletedSinceMs: null,
    lootTable: state.lootTable,
    requiredToolType: state.requiredToolType,
    directConsume: state.directConsume ?? false,
    xpValue: state.xpValue,
    xpSkill: state.xpSkill,
  } as ResourceNodeState;
  NetworkId.value[eid] = world.nextNetworkId++;
  return eid;
}

function registerItem(world: GameWorld, spec: Record<string, unknown>): void {
  world.gameDef.itemsByKind!.set(spec.kind as string, spec as unknown as ItemKindSpec);
}

/** 手动推进 tick 并依次运行系统（与 GameInstance.step 的 tick 语义一致）。 */
function advance(world: GameWorld, systems: System[], ticks: number, beforeEachTick?: () => void): void {
  for (let i = 0; i < ticks; i++) {
    world.time.tick += 1;
    world.time.dtMs = world.time.fixedDtMs;
    beforeEachTick?.();
    for (const system of systems) system(world);
  }
}

function createActionRig(world: GameWorld): {
  interaction: System;
  action: System;
  systems: System[];
} {
  const interaction: System = createInteractionSystem({ range: 24 });
  const action = createActionSystem(world, TEST_CONFIG);
  return { interaction, action, systems: [combatSystem, interaction, action] };
}

describe("动作时间轴：attack 阶段结算", () => {
  it("active 前不扣血、active 帧扣一次、总时长后清空", () => {
    const world = createBareWorld();
    registerItem(world, { kind: "test_wood", maxStack: 20 });
    const { interaction, action } = createActionRig(world);
    const player = spawnPlayer(world, { x: 0, y: 0 });
    const enemy = spawnEnemy(world, 10, 0, 100);
    const systems = [interaction, action];

    Intent[player] = "attack";
    advance(world, systems, 4); // elapsed 3：仍在 windup
    expect(Health.current[enemy]).toBe(100);
    expect(ActionState[player]?.phase).toBe("windup");
    expect(ActionState[player]?.targetEid).toBe(enemy);

    advance(world, systems, 1); // elapsed 4：进入 active，hit 一次
    expect(Health.current[enemy]).toBe(50);
    expect(ActionState[player]?.phase).toBe("active");

    advance(world, systems, 7); // elapsed 11：recovery 内，不再结算
    expect(Health.current[enemy]).toBe(50);
    expect(ActionState[player]?.phase).toBe("recovery");

    advance(world, systems, 1); // elapsed 12：动作结束清空
    expect(ActionState[player]).toBeUndefined();
  });

  it("windup 内目标离开射程 → 事件阶段原子复核失败，不结算（动作仍走完）", () => {
    const world = createBareWorld();
    const { interaction, action } = createActionRig(world);
    const player = spawnPlayer(world, { x: 0, y: 0 });
    const enemy = spawnEnemy(world, 10, 0, 100);
    const systems = [interaction, action];

    Intent[player] = "attack";
    advance(world, systems, 2);
    Transform.x[enemy] = 10_000; // 离开攻击距离
    advance(world, systems, 3); // 到 active 事件
    expect(Health.current[enemy]).toBe(100);
    expect(ActionState[player]?.phase).toBe("active");

    advance(world, systems, 8);
    expect(ActionState[player]).toBeUndefined();
  });

  it("windup 内目标死亡 → 事件阶段原子复核失败，不结算", () => {
    const world = createBareWorld();
    const { interaction, action } = createActionRig(world);
    const player = spawnPlayer(world, { x: 0, y: 0 });
    const enemy = spawnEnemy(world, 10, 0, 100);
    const systems = [interaction, action];

    Intent[player] = "attack";
    advance(world, systems, 2);
    Health.current[enemy] = 0; // 目标在 windup 内死亡
    advance(world, systems, 3); // 到 active 事件
    expect(Health.current[enemy]).toBe(0);
    expect(ActionState[player]?.phase).toBe("active");
  });

  it("显式目标 networkId 优先；解析失败回退最近目标", () => {
    const world = createBareWorld();
    const { interaction, action } = createActionRig(world);
    const player = spawnPlayer(world, { x: 0, y: 0 });
    const near = spawnEnemy(world, 8, 0, 100);
    const far = spawnEnemy(world, 20, 0, 100);
    NetworkId.value[far] = 9002;
    const systems = [interaction, action];

    Intent[player] = "attack";
    ActionInput[player] = { target: 9002 };
    advance(world, systems, 1);
    expect(ActionState[player]?.targetEid).toBe(far);

    // 清空动作/冷却，再给一个不存在的 networkId → 回退最近
    for (let i = 0; i < ActionState.length; i++) ActionState[i] = undefined;
    Cooldown.remainingMs[player] = 0;
    Intent[player] = "attack";
    ActionInput[player] = { target: 123456 };
    advance(world, systems, 1);
    expect(ActionState[player]?.targetEid).toBe(near);
  });
});

describe("动作时间轴：gather 阶段与冷却", () => {
  it("只在 swing 结算；按住 interact 不会每 tick 采集", () => {
    const world = createBareWorld();
    registerItem(world, { kind: "test_wood", maxStack: 20 });
    const player = spawnPlayer(world, { x: 0, y: 0 });
    const node = spawnResource(world, 10, 0, { remaining: 5, yieldsKind: "test_wood" });
    const { systems } = createActionRig(world);

    // 每 tick 重放 interact（模拟按住）
    advance(world, systems, 3, () => {
      Intent[player] = "interact";
    });
    expect(ResourceNode[node]!.remaining).toBe(5);
    expect(ActionState[player]?.phase).toBe("windup");

    advance(world, systems, 1, () => {
      Intent[player] = "interact";
    }); // elapsed 3：swing 事件
    expect(ResourceNode[node]!.remaining).toBe(4);
    expect(Inventory[player]!.slots[0]).toEqual({ kind: "test_wood", count: 1 });

    // 动作剩余 6 tick + 冷却剩余 4 tick：到第 14 tick 之前不会再次采集
    advance(world, systems, 9, () => {
      Intent[player] = "interact";
    });
    expect(ResourceNode[node]!.remaining).toBe(4);

    // 冷却结束（startedTick+cooldownTicks）后按住可再次启动 → 第二次 swing
    advance(world, systems, 6, () => {
      Intent[player] = "interact";
    });
    expect(ResourceNode[node]!.remaining).toBe(3);
  });

  it("显式资源目标解析失败 → 回退最近可采节点", () => {
    const world = createBareWorld();
    registerItem(world, { kind: "test_wood", maxStack: 20 });
    const { interaction, action } = createActionRig(world);
    const player = spawnPlayer(world, { x: 0, y: 0 });
    const near = spawnResource(world, 10, 0, { remaining: 5, yieldsKind: "test_wood" });
    spawnResource(world, 20, 0, { remaining: 5, yieldsKind: "test_wood" });
    const systems = [interaction, action];

    Intent[player] = "interact";
    ActionInput[player] = { target: 999999 };
    advance(world, systems, 1);
    expect(ActionState[player]?.targetEid).toBe(near);
  });
});

describe("动作时间轴：throw release", () => {
  it("release 事件阶段才生成投射物", () => {
    const world = createBareWorld();
    registerItem(world, {
      kind: "test_spear",
      maxStack: 1,
      maxDurability: 10,
      wearPerUse: 1,
      equip: { slot: "weapon", attackBonus: 4 },
      throw: { speed: 320, lifeMs: 1000, radius: 5, damage: 16, cooldownMs: 900 },
    });
    const player = spawnPlayer(world, { x: 0, y: 0 });
    Inventory[player]!.slots[0] = { kind: "test_spear", count: 1 };
    Equipment.weaponSlot[player] = 0;
    const action = createActionSystem(world, TEST_CONFIG);
    const systems = [action];

    expect(startThrowAction(world, player, "throw", 100, 0)).toBe(true);
    expect(ActionState[player]?.phaseIndex).toBe(0);
    expect(ActionState[player]?.phase).toBe("windup");

    advance(world, systems, 3); // 第 3 tick：仍 windup（elapsed 3 未到）
    expect(query(world, [Projectile]).length).toBe(0);
    expect(ActionState[player]?.phase).toBe("windup");

    advance(world, systems, 1); // elapsed 4：进入 release，spawn-projectile
    expect(query(world, [Projectile]).length).toBe(1);
    expect(ActionState[player]?.phase).toBe("release");

    advance(world, systems, 3); // elapsed 7
    expect(query(world, [Projectile]).length).toBe(1);
    advance(world, systems, 1); // elapsed 8：清空
    expect(ActionState[player]).toBeUndefined();
  });
});

describe("动作时间轴：打断与清理", () => {
  it("死亡清空 / 换图清空 / 非打断动作拒绝新动作", () => {
    const world = createBareWorld();
    const { interaction, action } = createActionRig(world);
    const player = spawnPlayer(world, { x: 0, y: 0 });
    const enemy = spawnEnemy(world, 10, 0, 100);
    const systems = [interaction, action];

    Intent[player] = "attack";
    advance(world, systems, 1);
    expect(ActionState[player]).toBeDefined();
    // 非 interruptible：新动作启动被拒绝
    expect(startConfiguredAction(world, player, "gather", { targetEid: enemy })).toBe(false);

    // 换图清空
    EntityMap[player] = "another-map";
    advance(world, systems, 1);
    expect(ActionState[player]).toBeUndefined();

    // 重新开始动作后死亡清空
    EntityMap[player] = world.defaultMapId;
    Cooldown.remainingMs[player] = 0;
    Intent[player] = "attack";
    advance(world, systems, 1);
    expect(ActionState[player]).toBeDefined();
    Health.current[player] = 0;
    advance(world, systems, 1);
    expect(ActionState[player]).toBeUndefined();
  });
  it("interruptible=true 的动作可被新动作替换", () => {
    const world = createBareWorld();
    const player = spawnPlayer(world, { x: 0, y: 0 });
    const enemy = spawnEnemy(world, 10, 0, 100);

    const action = createActionSystem(world, {
      actions: {
        attack: { ...TEST_ACTIONS.attack!, interruptible: true, cooldownTicks: 0 },
        gather: { ...TEST_ACTIONS.gather!, cooldownTicks: 0 },
      },
      intentActions: { attack: "attack", interact: "gather" },
    });
    expect(startConfiguredAction(world, player, "attack", { targetEid: enemy })).toBe(true);
    expect(startConfiguredAction(world, player, "gather", { targetEid: enemy })).toBe(true);
    expect(ActionState[player]?.actionId).toBe("gather");
    world.time.tick += 1;
    action(world);
    expect(ActionState[player]?.actionId).toBe("gather");
  });
});

describe("动作时间轴：无配置回归", () => {
  it("没有 actions 配置时 attack/gather 仍是旧瞬时行为", () => {
    const world = createBareWorld();
    registerItem(world, { kind: "test_wood", maxStack: 20 });
    const interaction = createInteractionSystem({ range: 24 });
    const player = spawnPlayer(world, { x: 0, y: 0 });
    const enemy = spawnEnemy(world, 10, 0, 100);
    const node = spawnResource(world, 8, 0, { remaining: 5, yieldsKind: "test_wood" });

    Intent[player] = "interact";
    interaction(world);
    expect(ResourceNode[node]!.remaining).toBe(4);
    expect(Inventory[player]!.slots[0]).toEqual({ kind: "test_wood", count: 1 });
    expect(ActionState[player]).toBeUndefined();

    Intent[player] = "attack";
    interaction(world);
    expect(Health.current[enemy]).toBe(50);
    expect(ActionState[player]).toBeUndefined();
  });
});

describe("动作时间轴：GameSimulation 集成与 netSync", () => {
  it("攻击动作同步 Action.* key：target 是 networkId、无 eid；结束后键消失", async () => {
    const def = loadGameDefinition({ gameJsonPath: "game/game.json" });
    const sim = await createGameSimulation(def);
    const world = (sim as unknown as { world: GameWorld }).world;
    const { networkId } = sim.addPlayer("s1");
    const playerEid = [...query(world, [Player])].find(
      (eid) => NetworkId.value[eid] === networkId,
    )!;
    Cooldown.remainingMs[playerEid] = 0;

    const enemy = spawnEnemy(world, Transform.x[playerEid] + 10, Transform.y[playerEid], 100);
    NetworkId.value[enemy] = 9_000_001;

    sim.submitInput("s1", {
      seq: 1,
      moveX: 0,
      moveY: 0,
      attack: true,
      target: 9_000_001,
    });
    const first = sim.tick(50);
    const snap = first.snapshot.entities.get(networkId)!;
    expect(snap.strings["Action.actionId"]).toBe("attack");
    expect(snap.strings["Action.phase"]).toBe("windup");
    expect(snap.values["Action.startedTick"]).toBe(first.tick);
    expect(snap.values["Action.durationTicks"]).toBe(12);
    expect(snap.values["Action.target"]).toBe(9_000_001);
    expect(snap.values["Action.target"]).not.toBe(enemy);
    expect(snap.values["Action.phaseIndex"]).toBe(0);
    expect(typeof snap.values["Action.dirX"]).toBe("number");
    expect(typeof snap.values["Action.dirY"]).toBe("number");
    expect(Health.current[enemy]).toBe(100);

    // 第 4 tick（elapsed 3）仍未到 active；第 5 tick（elapsed 4）扣血一次
    for (let i = 0; i < 3; i++) sim.tick(50);
    expect(Health.current[enemy]).toBe(100);
    const hit = sim.tick(50);
    expect(Health.current[enemy]).toBeLessThan(100);

    // 总时长 12 tick 后动作清空，快照不再含 Action.* key
    let last = hit;
    while (last.tick < first.tick + 12) {
      last = sim.tick(50);
    }
    const cleared = last.snapshot.entities.get(networkId)!;
    for (const key of Object.keys(cleared.values)) {
      expect(key.startsWith("Action.")).toBe(false);
    }
    for (const key of Object.keys(cleared.strings)) {
      expect(key.startsWith("Action.")).toBe(false);
    }
  });

  it("throw 命令只启动动作；release 事件阶段才生成投射物", async () => {
    const def = loadGameDefinition({ gameJsonPath: "game/game.json" });
    const sim = await createGameSimulation(def);
    const world = (sim as unknown as { world: GameWorld }).world;
    const { networkId } = sim.addPlayer("s1");
    const playerEid = [...query(world, [Player])].find(
      (eid) => NetworkId.value[eid] === networkId,
    )!;
    Cooldown.remainingMs[playerEid] = 0;
    Inventory[playerEid]!.slots[0] = { kind: "throwing_spear", count: 1 };
    Equipment.weaponSlot[playerEid] = 0;

    expect(
      sim.submitCommand("s1", {
        type: "throw",
        x: Transform.x[playerEid] + 64,
        y: Transform.y[playerEid],
      }).ok,
    ).toBe(true);
    // 命令只启动动作，不立刻生成投射物
    expect(query(world, [Projectile]).length).toBe(0);
    expect(ActionState[playerEid]?.actionId).toBe("throw");

    for (let i = 0; i < 3; i++) sim.tick(50);
    expect(query(world, [Projectile]).length).toBe(0);
    sim.tick(50); // elapsed 4：release 事件
    expect(query(world, [Projectile]).length).toBe(1);
    expect(ActionState[playerEid]?.phase).toBe("release");

    for (let i = 0; i < 4; i++) sim.tick(50); // elapsed 8：清空
    expect(ActionState[playerEid]).toBeUndefined();
  });

  it("移动锁：动作期间移动输入被清零；动作结束后的下一 tick 恢复", async () => {
    const def = loadGameDefinition({ gameJsonPath: "game/game.json" });
    const sim = await createGameSimulation(def);
    const world = (sim as unknown as { world: GameWorld }).world;
    const { networkId } = sim.addPlayer("s1");
    const playerEid = [...query(world, [Player])].find(
      (eid) => NetworkId.value[eid] === networkId,
    )!;
    Cooldown.remainingMs[playerEid] = 0;
    const node = spawnResource(world, Transform.x[playerEid] + 10, Transform.y[playerEid], {
      remaining: 5,
      yieldsKind: "wood",
    });
    NetworkId.value[node] = 9_100_001;

    sim.submitInput("s1", { seq: 1, moveX: 0, moveY: 0, interact: true, target: 9_100_001 });
    sim.tick(50);
    const lockedX = Transform.x[playerEid];

    // 动作持续 10 tick：期间持续发送移动输入，位置不应变化
    for (let seq = 2; seq <= 10; seq++) {
      sim.submitInput("s1", { seq, moveX: 10, moveY: 0 });
      sim.tick(50);
      expect(Transform.x[playerEid]).toBe(lockedX);
    }
    // 第 11 tick 仍在锁定帧（elapsed 10 在系统阶段才清空），第 12 tick 恢复移动
    sim.submitInput("s1", { seq: 11, moveX: 10, moveY: 0 });
    sim.tick(50);
    expect(Transform.x[playerEid]).toBe(lockedX);
    sim.submitInput("s1", { seq: 12, moveX: 10, moveY: 0 });
    sim.tick(50);
    expect(Transform.x[playerEid]).toBeGreaterThan(lockedX);
  });
});
