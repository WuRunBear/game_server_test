/**
 * 通用状态机（slice 2）测试：配置迁移 / 即时信号 / 定时迁移 / 离线快进等价 /
 * 持久化往返 / 采集联动 / 非法配置 fail-fast / regenMs 未回归。
 *
 * 核心断言（任务②）：**逐 tick 推进到 tickT 与快进到 tickT 的最终状态一致**——
 * 定时迁移用绝对 `enteredTick + afterTicks` 派生，两条路径的状态、剩余计时与
 * 效果结果逐位一致。
 */
import { describe, it, expect, beforeAll, afterEach, vi } from "vitest";
import { addComponent, addEntity, query } from "bitecs";
import {
  bootstrapFramework,
  createDefaultGameDefinition,
  createGameInstance,
  createGameSimulation,
  getRegistries,
  spawnEntity,
  serializeWorld,
  restoreWorld,
} from "framework/index";
import { Transform } from "framework/components/transform";
import { NetworkId } from "framework/components/network";
import { Player, Resource } from "framework/components/tags";
import { Health, Team } from "framework/components/combat";
import { Inventory } from "framework/components/inventory";
import { Needs } from "framework/components/needs";
import { ResourceNode } from "framework/components/resourceNode";
import { Kind } from "framework/components/kind";
import {
  StateMachine,
  attachStateMachine,
  compileStateMachine,
} from "framework/simulation/stateMachine/stateMachine";
import {
  stateMachineSystem,
  signalStateMachine,
  fastForwardStateMachines,
} from "framework/simulation/stateMachine/stateMachineSystem";
import { harvest, gatheringSystem } from "framework/systems/gameplay/gatheringSystem";
import { memoryRepository } from "./helpers/persistence";
import type { GameWorld } from "framework/world";
import type { LoadedGameDefinition } from "framework/config/schema/GameDefinitionSchema";
import type { SimulationPort } from "simulation";
import type { ItemKindSpec } from "framework/config/schema/ItemKindSchema";

beforeAll(() => {
  bootstrapFramework();
});

afterEach(() => {
  vi.useRealTimers();
});

/** 最小世界（默认配置，无具体 game 内容依赖）。 */
function createBareWorld(): GameWorld {
  return createGameInstance(createDefaultGameDefinition()).world;
}

function setItemKind(world: GameWorld, spec: ItemKindSpec): void {
  world.gameDef.itemsByKind!.set(spec.kind, spec);
}

/** 线性定时链：s0 --kick--> s1 --3--> s2 --4--(回满)--> s3 --5--> s4（终态）。 */
const CHAIN = {
  initial: "s0",
  states: {
    s0: { transitions: [{ on: "kick", to: "s1" }] },
    s1: { transitions: [{ afterTicks: 3, to: "s2" }] },
    s2: { transitions: [{ afterTicks: 4, to: "s3", effects: [{ name: "restore-resource" }] }] },
    s3: { transitions: [{ afterTicks: 5, to: "s4" }] },
    s4: { transitions: [] },
  },
};

function spawnResourceNode(world: GameWorld, remaining: number, max: number): number {
  const eid = addEntity(world);
  addComponent(world, eid, Resource);
  ResourceNode[eid] = {
    remaining,
    max,
    amountPerHit: 1,
    regenMs: 0,
    yieldsKind: "smk",
    directConsume: false,
    depletedSinceMs: null,
  };
  return eid;
}

/** 手工玩家（Transform/NetworkId/Player/Health/Team/Inventory/Needs）。 */
function spawnTestPlayer(world: GameWorld): number {
  const eid = addEntity(world);
  addComponent(world, eid, Transform);
  addComponent(world, eid, NetworkId);
  addComponent(world, eid, Player);
  addComponent(world, eid, Health);
  addComponent(world, eid, Team);
  Health.current[eid] = 100;
  Health.max[eid] = 100;
  Inventory[eid] = { capacity: 4, slots: [null, null, null, null] };
  Needs[eid] = [];
  NetworkId.value[eid] = world.nextNetworkId++;
  return eid;
}

describe("StateMachine：配置迁移", () => {
  it("初始状态来自配置，进入 tick = 生成时刻", () => {
    const world = createBareWorld();
    world.time.tick = 100;
    const eid = addEntity(world);
    attachStateMachine(world, eid, CHAIN, 100);
    expect(StateMachine[eid]).toEqual({ state: "s0", enteredTick: 100 });
  });

  it("即时信号：命中迁移立即换状态（进入 tick = 当前 tick），未命中为 no-op", () => {
    const world = createBareWorld();
    world.time.tick = 100;
    const eid = addEntity(world);
    attachStateMachine(world, eid, CHAIN, 100);

    expect(signalStateMachine(world, eid, "nope")).toBe(false);
    expect(StateMachine[eid]).toEqual({ state: "s0", enteredTick: 100 });

    expect(signalStateMachine(world, eid, "kick")).toBe(true);
    expect(StateMachine[eid]).toEqual({ state: "s1", enteredTick: 100 });
  });

  it("定时迁移按 enteredTick + afterTicks 到点推进（含效果执行）", () => {
    const world = createBareWorld();
    world.time.tick = 0;
    const eid = spawnResourceNode(world, 0, 4);
    attachStateMachine(world, eid, CHAIN, 0);
    signalStateMachine(world, eid, "kick"); // s1 @ 0

    world.time.tick = 3;
    stateMachineSystem(world);
    expect(StateMachine[eid]).toEqual({ state: "s2", enteredTick: 3 });

    world.time.tick = 7; // s2 --4--> s3：进入 s3 时执行 restore-resource
    stateMachineSystem(world);
    expect(StateMachine[eid]).toEqual({ state: "s3", enteredTick: 7 });
    expect(ResourceNode[eid]!.remaining).toBe(4);

    world.time.tick = 12;
    stateMachineSystem(world);
    expect(StateMachine[eid]).toEqual({ state: "s4", enteredTick: 12 });

    world.time.tick = 999;
    stateMachineSystem(world);
    expect(StateMachine[eid]).toEqual({ state: "s4", enteredTick: 12 }); // 终态不再推进
  });
});

describe("StateMachine：离线快进等价性（核心断言）", () => {
  function runFastForward(config: unknown, targetTick: number) {
    const world = createBareWorld();
    world.time.tick = 1000;
    const eid = spawnResourceNode(world, 0, 4);
    attachStateMachine(world, eid, config, 1000);
    signalStateMachine(world, eid, "kick"); // s1 @ 1000
    fastForwardStateMachines(world, targetTick);
    return { state: StateMachine[eid], remaining: ResourceNode[eid]!.remaining };
  }

  function runTickByTick(config: unknown, ticks: number) {
    const world = createBareWorld();
    world.time.tick = 1000;
    const eid = spawnResourceNode(world, 0, 4);
    attachStateMachine(world, eid, config, 1000);
    signalStateMachine(world, eid, "kick"); // s1 @ 1000
    for (let i = 1; i <= ticks; i++) {
      world.time.tick = 1000 + i;
      stateMachineSystem(world);
    }
    return { state: StateMachine[eid], remaining: ResourceNode[eid]!.remaining };
  }

  it("中途（tick 1005）：快进 ≡ 逐 tick", () => {
    expect(runFastForward(CHAIN, 1005)).toEqual(runTickByTick(CHAIN, 5));
    expect(runFastForward(CHAIN, 1005)).toEqual({ state: { state: "s2", enteredTick: 1003 }, remaining: 0 });
  });

  it("越过全部链路（tick 1030）：快进 ≡ 逐 tick（含效果结果）", () => {
    const ff = runFastForward(CHAIN, 1030);
    const tb = runTickByTick(CHAIN, 30);
    expect(ff).toEqual(tb);
    expect(ff).toEqual({ state: { state: "s4", enteredTick: 1012 }, remaining: 4 });
  });

  it("长跨度（tick 20000）不逐 tick：与逐 tick 一致且立即返回", () => {
    const ff = runFastForward(CHAIN, 20000);
    expect(ff).toEqual({ state: { state: "s4", enteredTick: 1012 }, remaining: 4 });
  });
});

describe("StateMachine：持久化往返 + 快进一致", () => {
  const ARCH_KIND = "sm_arch_bush";

  it("状态机状态入档；恢复后与快进结果一致", () => {
    const { componentRegistry, archetypeRegistry } = getRegistries();
    archetypeRegistry.register({
      kind: ARCH_KIND,
      tags: ["Resource"],
      components: {
        Transform: {},
        ResourceNode: { remaining: 5, max: 5, amountPerHit: 1, regenMs: 0, yieldsKind: "stone" },
        StateMachine: CHAIN,
      },
    });

    // 世界 1：推进到 s2 @ 503 后序列化
    const world1 = createBareWorld();
    world1.time.tick = 500;
    const eid = spawnEntity(world1, archetypeRegistry.get(ARCH_KIND), componentRegistry);
    signalStateMachine(world1, eid, "kick"); // s1 @ 500
    world1.time.tick = 503;
    stateMachineSystem(world1);
    expect(StateMachine[eid]).toEqual({ state: "s2", enteredTick: 503 });

    const record = serializeWorld(world1, "sm");
    const saved = record.entities.find((e) => e.kind === ARCH_KIND)!;
    expect(saved.components.StateMachine).toEqual({ state: "s2", enteredTick: 503 });

    const findEid = (world: GameWorld): number =>
      query(world, [NetworkId]).find((e) => Kind[e] === ARCH_KIND)!;

    // 世界 2：恢复后逐 tick 推进 8 → 目标 tick 511
    const world2 = createBareWorld();
    restoreWorld(world2, record);
    const eid2 = findEid(world2);
    expect(StateMachine[eid2]).toEqual({ state: "s2", enteredTick: 503 });
    for (let t = 504; t <= 511; t++) {
      world2.time.tick = t;
      stateMachineSystem(world2);
    }

    // 世界 3：恢复后一次快进到 511
    const world3 = createBareWorld();
    restoreWorld(world3, record);
    const eid3 = findEid(world3);
    fastForwardStateMachines(world3, 511);

    expect(StateMachine[eid3]).toEqual(StateMachine[eid2]);
    expect(ResourceNode[eid3]!.remaining).toBe(ResourceNode[eid2]!.remaining);
    expect(StateMachine[eid3]).toEqual({ state: "s3", enteredTick: 507 });
  });
});

describe("StateMachine：接入资源采集（harvest 联动）", () => {
  it("采集至枯竭 → 即时转再生态 → 定时回满（restore-resource）", () => {
    const world = createBareWorld();
    world.time.tick = 0;
    setItemKind(world, { kind: "smk", maxStack: 20 });
    const player = spawnTestPlayer(world);
    const node = spawnResourceNode(world, 2, 2);
    attachStateMachine(world, node, {
      initial: "ready",
      states: {
        ready: { transitions: [{ on: "depleted", to: "regrowing" }] },
        regrowing: {
          transitions: [{ afterTicks: 1200, to: "ready", effects: [{ name: "restore-resource" }] }],
        },
      },
    });

    expect(harvest(world, player, node)).toBe(true); // 2 → 1
    expect(StateMachine[node]!.state).toBe("ready");
    expect(harvest(world, player, node)).toBe(true); // 1 → 0 → 枯竭信号
    expect(ResourceNode[node]!.remaining).toBe(0);
    expect(StateMachine[node]!.state).toBe("regrowing");

    world.time.tick += 1200;
    stateMachineSystem(world);
    expect(StateMachine[node]!.state).toBe("ready");
    expect(ResourceNode[node]!.remaining).toBe(2);
  });
});

describe("StateMachine：regenMs 旧机制未回归", () => {
  it("regenMs > 0 的节点仍由 gatheringSystem 按时间回满", () => {
    const world = createBareWorld();
    const eid = addEntity(world);
    addComponent(world, eid, Resource);
    ResourceNode[eid] = {
      remaining: 0,
      max: 5,
      amountPerHit: 1,
      regenMs: 1000,
      yieldsKind: "x",
      directConsume: false,
      depletedSinceMs: 0,
    };
    world.time.tick = 20; // now = 20 × 50ms = 1000ms ≥ regenMs
    gatheringSystem(world);
    expect(ResourceNode[eid]!.remaining).toBe(5);
    expect(ResourceNode[eid]!.depletedSinceMs).toBeNull();
  });

  it("regenMs = 0 的节点不被 gatheringSystem 回满（由状态机驱动）", () => {
    const world = createBareWorld();
    const eid = spawnResourceNode(world, 0, 5);
    world.time.tick = 999;
    gatheringSystem(world);
    expect(ResourceNode[eid]!.remaining).toBe(0);
  });
});

describe("StateMachine：非法配置 fail-fast", () => {
  it("缺 initial / 缺 states / 初始状态未声明", () => {
    expect(() => compileStateMachine({ states: { a: {} } })).toThrow(/initial/);
    expect(() => compileStateMachine({ initial: "a" })).toThrow(/states/);
    expect(() => compileStateMachine({ initial: "zzz", states: { a: {} } })).toThrow(/initial state "zzz"/);
  });

  it("未知目标状态", () => {
    expect(() =>
      compileStateMachine({ initial: "a", states: { a: { transitions: [{ on: "x", to: "zzz" }] } } }),
    ).toThrow(/unknown state "zzz"/);
  });

  it("环状自动迁移", () => {
    expect(() =>
      compileStateMachine({
        initial: "a",
        states: {
          a: { transitions: [{ afterTicks: 1, to: "b" }] },
          b: { transitions: [{ afterTicks: 1, to: "a" }] },
        },
      }),
    ).toThrow(/cycle/);
  });

  it("一条迁移声明多种触发方式", () => {
    expect(() =>
      compileStateMachine({ initial: "a", states: { a: { transitions: [{ afterTicks: 1, on: "x", to: "a" }] } } }),
    ).toThrow(/exactly one/);
  });

  it("未知条件名", () => {
    expect(() =>
      compileStateMachine({ initial: "a", states: { a: { transitions: [{ condition: "nope", to: "a" }] } } }),
    ).toThrow(/unknown condition "nope"/);
  });

  it("合法最小配置通过", () => {
    expect(() => compileStateMachine({ initial: "a", states: { a: {} } })).not.toThrow();
  });
});

describe("StateMachine：GameSimulation 离线补差接线（fastForward 挂载点）", () => {
  const DT_MS = 50;
  const SAVE_TICK = 100;
  const OFFLINE_TICKS = 10;

  function buildSimDef(): LoadedGameDefinition {
    const def = createDefaultGameDefinition();
    def.systems = [{ id: "stateMachine" }];
    def.resolvedEntities = [
      {
        kind: "sm_sim_node",
        tags: ["Resource"],
        components: {
          ResourceNode: { remaining: 0, max: 4, amountPerHit: 1, regenMs: 0, yieldsKind: "stone" },
          StateMachine: CHAIN,
        },
      },
    ];
    return def;
  }

  function simWorld(sim: SimulationPort): GameWorld {
    return (sim as unknown as { world: GameWorld }).world;
  }

  function nodeOf(world: GameWorld): number {
    return query(world, [NetworkId]).find((e) => Kind[e] === "sm_sim_node")!;
  }

  async function loadSim(def: LoadedGameDefinition, record: unknown, offlineTicks: number): Promise<SimulationPort> {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime((record as { savedAt: number }).savedAt + offlineTicks * DT_MS);
    const sim = await createGameSimulation(def, {
      repository: memoryRepository(record as never),
      saveId: "sm-offline",
    });
    vi.useRealTimers();
    return sim;
  }

  it("读档 + 离线快进 ≡ 读档 + 连续运行同跨度（状态与效果结果一致）", async () => {
    const def = buildSimDef();

    // 世界 1：spawn 节点 → kick 到 s1 @ 100 → 存档
    const sim1 = await createGameSimulation(def);
    const world1 = simWorld(sim1);
    const node1 = spawnEntity(world1, world1.archetypes.get("sm_sim_node"), world1.components_registry);
    world1.time.tick = SAVE_TICK;
    signalStateMachine(world1, node1, "kick");
    expect(StateMachine[node1]).toEqual({ state: "s1", enteredTick: SAVE_TICK });
    const record = serializeWorld(world1, "sm-offline");

    // 路径 A：读档 + 离线补差（fastForward 到 100+10）
    const simOffline = await loadSim(def, record, OFFLINE_TICKS);
    const worldOffline = simWorld(simOffline);
    expect(worldOffline.time.tick).toBe(SAVE_TICK + OFFLINE_TICKS);

    // 路径 B：零补差读档 + 连续 10 个运行 tick
    const simContinuous = await loadSim(def, record, 0);
    const worldContinuous = simWorld(simContinuous);
    for (let i = 0; i < OFFLINE_TICKS; i++) simContinuous.tick(DT_MS);

    const a = StateMachine[nodeOf(worldOffline)];
    const b = StateMachine[nodeOf(worldContinuous)];
    expect(a).toEqual(b);
    expect(a).toEqual({ state: "s3", enteredTick: 107 }); // s1@100 → s2@103 → s3@107（restore 效果）
    expect(ResourceNode[nodeOf(worldOffline)]!.remaining).toBe(4);
    expect(ResourceNode[nodeOf(worldContinuous)]!.remaining).toBe(4);
  });
});
