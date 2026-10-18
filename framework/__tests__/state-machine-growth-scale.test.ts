/**
 * 状态机定时迁移的环境倍率缩放（F-15 growthScale 接线）测试。
 *
 * 断言：
 * ① 同一状态机在不同相位（growthScale 快/慢）下迁移时间不同；
 * ② 区间积分：线性修饰值 {from,to} 按积分求到期，非简单按目标 tick 采样；
 * ③ 离线快进（一次 advance）与逐 tick 推进的最终状态/计时一致；
 * ④ 未声明 scale 的旧配置零回归；规则缺该修饰键时按中性 1 处理；
 * ⑤ 配置校验：scale 只能挂在定时迁移上。
 */
import { beforeAll, describe, expect, it } from "vitest";
import { addEntity } from "bitecs";
import {
  bootstrapFramework,
  createDefaultGameDefinition,
  createGameInstance,
  EnvironmentRuleSchema,
  type EnvironmentRule,
  type GameWorld,
} from "framework/index";
import {
  StateMachine,
  attachStateMachine,
  compileStateMachine,
} from "framework/simulation/stateMachine/stateMachine";
import {
  fastForwardStateMachines,
  stateMachineSystem,
} from "framework/simulation/stateMachine/stateMachineSystem";
import { effectiveScaleAt, scaledDueTick } from "framework/simulation/stateMachine/scaledDue";

beforeAll(() => {
  bootstrapFramework();
});

/** 三相位：fast[0,100) ×2 / slow[100,200) ×0.5 / neutral[200,300) 无修饰。 */
const RULE: EnvironmentRule = EnvironmentRuleSchema.parse({
  seed: 42,
  weatherSlotTicks: 50,
  phases: [
    { id: "fast", durationTicks: 100, modifiers: { growthScale: 2 } },
    { id: "slow", durationTicks: 100, modifiers: { growthScale: 0.5 } },
    { id: "neutral", durationTicks: 100, modifiers: {} },
  ],
});

/** 线性相位规则：ramp[0,100) growthScale 1→2。 */
const RAMP: EnvironmentRule = EnvironmentRuleSchema.parse({
  seed: 42,
  weatherSlotTicks: 50,
  phases: [
    { id: "ramp", durationTicks: 100, modifiers: { growthScale: { from: 1, to: 2 } } },
  ],
});

function createWorld(rule: EnvironmentRule = RULE): GameWorld {
  const world = createGameInstance(createDefaultGameDefinition()).world;
  world.gameDef.resolvedRules["environment"] = rule;
  return world;
}

/** 单条定时迁移：grow --afterTicks--> ready。 */
function growConfig(afterTicks: number, scale?: string): unknown {
  return {
    initial: "grow",
    states: {
      grow: {
        transitions: [
          scale === undefined ? { afterTicks, to: "ready" } : { afterTicks, to: "ready", scale },
        ],
      },
      ready: {},
    },
  };
}

function spawnWith(world: GameWorld, config: unknown, enteredTick: number): number {
  const eid = addEntity(world);
  attachStateMachine(world, eid, config, enteredTick);
  return eid;
}

describe("① 相位决定迁移时间", () => {
  it("growthScale=2 时 100 tick 的等待缩短为 50 tick", () => {
    const world = createWorld();
    world.time.tick = 0;
    const eid = spawnWith(world, growConfig(100, "growthScale"), 0);

    world.time.tick = 49;
    stateMachineSystem(world);
    expect(StateMachine[eid]!.state).toBe("grow");

    world.time.tick = 50;
    stateMachineSystem(world);
    expect(StateMachine[eid]).toEqual({ state: "ready", enteredTick: 50 });
  });

  it("growthScale=0.5 时 100 tick 的等待延长为 200 tick（跨相位后加速）", () => {
    const world = createWorld();
    const eid = spawnWith(world, growConfig(100, "growthScale"), 100); // slow 相位起点

    // slow[100,200) 贡献 100×0.5=50 work；剩余 50 在 neutral 以 1/tick → 200+50
    world.time.tick = 249;
    stateMachineSystem(world);
    expect(StateMachine[eid]!.state).toBe("grow");

    world.time.tick = 250;
    stateMachineSystem(world);
    expect(StateMachine[eid]).toEqual({ state: "ready", enteredTick: 250 });
  });

  it("同一配置在不同相位进入 → 迁移时间不同", () => {
    const world = createWorld();
    const fastEid = spawnWith(world, growConfig(100, "growthScale"), 0);
    const slowEid = spawnWith(world, growConfig(100, "growthScale"), 100);

    world.time.tick = 250;
    stateMachineSystem(world);
    expect(StateMachine[fastEid]!.state).toBe("ready");
    expect(StateMachine[slowEid]!.state).toBe("ready");
    // 两者到期 tick 不同（50 vs 250）
    expect(StateMachine[fastEid]!.enteredTick).toBe(50);
    expect(StateMachine[slowEid]!.enteredTick).toBe(250);
  });
});

describe("② 区间积分（线性修饰值）", () => {
  it("growthScale 1→2 时 100 tick 等待 ≈ 73.2 tick（解 t + t²/200 = 100）", () => {
    const world = createWorld(RAMP);
    const eid = spawnWith(world, growConfig(100, "growthScale"), 0);

    const expected = Math.ceil((-1 + Math.sqrt(3)) * 100 - 1e-6);
    expect(expected).toBe(74);
    expect(scaledDueTick(world, 0, 100, "growthScale")).toBe(74);

    world.time.tick = expected - 1;
    stateMachineSystem(world);
    expect(StateMachine[eid]!.state).toBe("grow");

    world.time.tick = expected;
    stateMachineSystem(world);
    expect(StateMachine[eid]).toEqual({ state: "ready", enteredTick: expected });
  });

  it("effectiveScaleAt 与 environment modifiers 同源（相位进度线性）", () => {
    const world = createWorld(RAMP);
    world.time.tick = 0;
    expect(effectiveScaleAt(world, 0, "growthScale")).toBeCloseTo(1, 10);
    world.time.tick = 50;
    expect(effectiveScaleAt(world, 50, "growthScale")).toBeCloseTo(1.5, 10);
  });
});

describe("③ 离线快进等价性", () => {
  it("逐 tick 推进与一次快进到同一 target 的状态/计时一致", () => {
    const TARGET = 260;

    const stepped = createWorld();
    const steppedEid = spawnWith(stepped, growConfig(100, "growthScale"), 0);
    for (let t = 1; t <= TARGET; t++) {
      stepped.time.tick = t;
      stateMachineSystem(stepped);
    }

    const fast = createWorld();
    const fastEid = spawnWith(fast, growConfig(100, "growthScale"), 0);
    fast.time.tick = TARGET;
    fastForwardStateMachines(fast, TARGET);

    expect(StateMachine[steppedEid]).toEqual(StateMachine[fastEid]);
    expect(StateMachine[fastEid]).toEqual({ state: "ready", enteredTick: 50 });
  });

  it("线性相位下两条路径也一致（浮点到期 tick 不漂移）", () => {
    const TARGET = 90;
    const stepped = createWorld(RAMP);
    const steppedEid = spawnWith(stepped, growConfig(40, "growthScale"), 0);
    for (let t = 1; t <= TARGET; t++) {
      stepped.time.tick = t;
      stateMachineSystem(stepped);
    }

    const fast = createWorld(RAMP);
    const fastEid = spawnWith(fast, growConfig(40, "growthScale"), 0);
    fast.time.tick = TARGET;
    fastForwardStateMachines(fast, TARGET);

    expect(StateMachine[steppedEid]).toEqual(StateMachine[fastEid]);
  });
});

describe("④ 零回归与中性回退", () => {
  it("未声明 scale：即使当前相位 growthScale=2，仍按固定 afterTicks", () => {
    const world = createWorld();
    const eid = spawnWith(world, growConfig(100), 0);

    world.time.tick = 99;
    stateMachineSystem(world);
    expect(StateMachine[eid]!.state).toBe("grow");

    world.time.tick = 100;
    stateMachineSystem(world);
    expect(StateMachine[eid]).toEqual({ state: "ready", enteredTick: 100 });
  });

  it("声明了 scale 但规则没有该修饰键：按中性 1 处理", () => {
    const world = createWorld(RULE);
    // neutral 相位 [200,300) 无 modifiers
    expect(scaledDueTick(world, 200, 40, "growthScale")).toBe(240);
  });

  it("无 environment 规则时退化为固定 afterTicks", () => {
    const world = createGameInstance(createDefaultGameDefinition()).world;
    expect(scaledDueTick(world, 10, 30, "growthScale")).toBe(40);
  });

  it("afterTicks = 0 立即到期（不进入积分路径）", () => {
    const world = createWorld();
    expect(scaledDueTick(world, 123, 0, "growthScale")).toBe(123);
  });
});

describe("⑤ 配置校验", () => {
  it("scale 只能声明在定时迁移上", () => {
    expect(() =>
      compileStateMachine({
        initial: "a",
        states: { a: { transitions: [{ on: "sig", to: "a", scale: "growthScale" }] } },
      }),
    ).toThrow(/only allowed on timed transitions/);
  });

  it("scale 必须是非空字符串", () => {
    expect(() =>
      compileStateMachine({
        initial: "a",
        states: { a: { transitions: [{ afterTicks: 1, to: "a", scale: "" }] } },
      }),
    ).toThrow(/non-empty modifier key/);
  });

  it("编译结果保留 scale（供 advance 使用）", () => {
    const compiled = compileStateMachine(growConfig(5, "growthScale"));
    expect(compiled.states.get("grow")!.transitions[0]).toMatchObject({
      kind: "timed",
      afterTicks: 5,
      scale: "growthScale",
    });
  });
});
