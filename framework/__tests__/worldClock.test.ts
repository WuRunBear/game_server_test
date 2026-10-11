/**
 * WorldClock 相位/环境派生单元测试（framework/simulation/worldClock）。
 *
 * 核心断言：
 * ① 相位槽绝对对齐——tick 落在边界前后归属正确、跨相位不漂移；
 * ② 天气确定性——同 (seed, slot) 恒同结果，异 slot 序列可不同；
 * ③ 离线等价性——逐 tick 推进到 tickT 与直接求值结果一致（无累积状态）；
 * ④ 新增带参条件 inPhase / isWeather 的求值；
 * ⑤ 相位修饰值随进度线性变化。
 */
import { beforeAll, describe, expect, it } from "vitest";
import {
  bootstrapFramework,
  createDefaultGameDefinition,
  createGameInstance,
  EnvironmentRuleSchema,
  environmentAt,
  environmentSystem,
  getSpawnCondition,
  hasSpawnCondition,
  phaseAt,
  resolveModifiers,
  weatherAt,
  weatherSlotAt,
  type EnvironmentRule,
  type GameWorld,
} from "framework/index";

beforeAll(() => {
  bootstrapFramework();
});

/** 测试相位程序（一周期 50 tick；alpha[0,20) / beta[20,50)）。 */
const RULE: EnvironmentRule = EnvironmentRuleSchema.parse({
  seed: 12345,
  weatherSlotTicks: 10,
  phases: [
    {
      id: "alpha",
      durationTicks: 20,
      modifiers: { temperatureOffset: 0, growthScale: { from: 1, to: 2 } },
      weather: [
        { id: "w1", weight: 1 },
        { id: "w2", weight: 1 },
      ],
    },
    {
      id: "beta",
      durationTicks: 30,
      modifiers: { temperatureOffset: { from: 10, to: 0 } },
      weather: [{ id: "w3", weight: 1 }],
    },
  ],
});

/** 构造挂了测试 environment 规则的最小世界。 */
function createWorldWithRule(rule: EnvironmentRule = RULE): GameWorld {
  const world = createGameInstance(createDefaultGameDefinition()).world;
  world.gameDef.resolvedRules["environment"] = rule;
  return world;
}

describe("① 相位槽绝对对齐", () => {
  it("边界前后归属正确（tick 20 归 beta，tick 19 归 alpha）", () => {
    expect(phaseAt(0, RULE).phaseId).toBe("alpha");
    expect(phaseAt(19, RULE).phaseId).toBe("alpha");
    expect(phaseAt(20, RULE).phaseId).toBe("beta");
    expect(phaseAt(20, RULE).progress).toBeCloseTo(0, 10);
    expect(phaseAt(49, RULE).phaseId).toBe("beta");
    expect(phaseAt(49, RULE).progress).toBeCloseTo(29 / 30, 10);
  });

  it("跨周期不漂移（k × cycle 处恒回相位 0，进度 0）", () => {
    for (let k = 0; k < 4; k++) {
      const base = k * 50;
      expect(phaseAt(base, RULE)).toMatchObject({ phaseIndex: 0, phaseId: "alpha", progress: 0 });
      expect(phaseAt(base + 19, RULE)).toMatchObject({ phaseIndex: 0, phaseId: "alpha" });
      expect(phaseAt(base + 20, RULE)).toMatchObject({ phaseIndex: 1, phaseId: "beta", progress: 0 });
      expect(phaseAt(base + 49, RULE)).toMatchObject({ phaseIndex: 1, phaseId: "beta" });
    }
  });

  it("日索引 = floor(tick / cycle)", () => {
    expect(phaseAt(49, RULE).dayIndex).toBe(0);
    expect(phaseAt(50, RULE).dayIndex).toBe(1);
    expect(phaseAt(149, RULE).dayIndex).toBe(2);
  });
});

describe("② 天气确定性", () => {
  it("同 (seed, slot) 恒同结果", () => {
    expect(weatherAt(3, RULE)).toEqual(weatherAt(9, RULE)); // 同槽 0
    expect(weatherSlotAt(3, RULE)).toBe(0);
    expect(weatherSlotAt(9, RULE)).toBe(0);
    expect(weatherAt(10, RULE).weatherSlot).toBe(1);
  });

  it("天气恒取自该槽所属相位的候选表", () => {
    for (let s = 0; s < 12; s++) {
      const tick = s * RULE.weatherSlotTicks + 1;
      const owner = phaseAt(s * RULE.weatherSlotTicks, RULE);
      const ids = (RULE.phases[owner.phaseIndex].weather ?? []).map((o) => o.id);
      expect(ids).toContain(weatherAt(tick, RULE).weatherId);
    }
  });

  it("异 seed 序列可不同（固定 seed 域，确定性非漂移）", () => {
    const other: EnvironmentRule = { ...RULE, seed: 999 };
    const seqA: string[] = [];
    const seqB: string[] = [];
    for (let s = 0; s < 12; s++) {
      const tick = s * RULE.weatherSlotTicks + 1;
      seqA.push(weatherAt(tick, RULE).weatherId);
      seqB.push(weatherAt(tick, other).weatherId);
    }
    expect(seqA.some((id, i) => id !== seqB[i])).toBe(true);
  });
});

describe("③ 离线等价性（核心断言）", () => {
  it("逐 tick 推进到 tickT 与直接求值一致", () => {
    const T = 137; // 跨多个相位与天气槽
    const stepped = createWorldWithRule();
    for (let t = 0; t <= T; t++) {
      stepped.time.tick = t;
      environmentSystem(stepped);
    }

    const direct = createWorldWithRule();
    direct.time.tick = T;

    expect(stepped.time.environment).toEqual(environmentAt(direct));

    const expectedPhase = phaseAt(T, RULE);
    expect(stepped.time.environment).toEqual({
      ...expectedPhase,
      weatherId: weatherAt(T, RULE).weatherId,
      weatherSlot: weatherAt(T, RULE).weatherSlot,
      modifiers: resolveModifiers(RULE.phases[expectedPhase.phaseIndex], expectedPhase.progress),
    });
  });

  it("单步长跳到 tickT 与逐 tick 推进一致", () => {
    const T = 88;
    const stepped = createWorldWithRule();
    for (let t = 0; t <= T; t++) {
      stepped.time.tick = t;
      environmentSystem(stepped);
    }

    const jumped = createWorldWithRule();
    jumped.time.tick = T;
    environmentSystem(jumped);

    expect(jumped.time.environment).toEqual(stepped.time.environment);
  });

  it("重算不依赖（污染的）缓存——纯函数", () => {
    const world = createWorldWithRule();
    world.time.tick = 77;
    world.time.environment = {
      phaseIndex: 1,
      phaseId: "STALE",
      progress: 0.9,
      dayIndex: 42,
      weatherId: "STALE",
      weatherSlot: 99,
      modifiers: { bogus: 1 },
    };
    environmentSystem(world);
    expect(world.time.environment.phaseId).toBe(phaseAt(77, RULE).phaseId);
    expect(world.time.environment).toEqual(environmentAt(world));
  });
});

describe("④ 新增条件 inPhase / isWeather", () => {
  it("inPhase：按相位 id 判定", () => {
    const world = createWorldWithRule();
    world.time.tick = 5;
    expect(getSpawnCondition("inPhase:alpha")(world)).toBe(true);
    expect(getSpawnCondition("inPhase:beta")(world)).toBe(false);

    world.time.tick = 25;
    expect(getSpawnCondition("inPhase:beta")(world)).toBe(true);
    expect(getSpawnCondition("inPhase:alpha")(world)).toBe(false);
  });

  it("isWeather：按当前天气 id 判定", () => {
    const world = createWorldWithRule();
    world.time.tick = 25; // beta 相位，唯一候选 w3
    expect(getSpawnCondition("isWeather:w3")(world)).toBe(true);
    expect(getSpawnCondition("isWeather:__none__")(world)).toBe(false);
  });

  it("注册表：带参名可解析，裸基名未注册", () => {
    expect(hasSpawnCondition("inPhase:alpha")).toBe(true);
    expect(hasSpawnCondition("isWeather:w1")).toBe(true);
    expect(hasSpawnCondition("inPhase")).toBe(false); // 带参条件必带参数
  });
});

describe("⑤ 相位修饰值随进度线性变化", () => {
  it("alpha.growthScale {1→2} 随进度线性", () => {
    const world = createWorldWithRule();
    world.time.tick = 0;
    expect(environmentAt(world).modifiers.growthScale).toBeCloseTo(1, 10);
    world.time.tick = 10;
    expect(environmentAt(world).modifiers.growthScale).toBeCloseTo(1.5, 10);
  });

  it("beta.temperatureOffset {10→0} 随进度线性", () => {
    const world = createWorldWithRule();
    world.time.tick = 20;
    expect(environmentAt(world).modifiers.temperatureOffset).toBeCloseTo(10, 10);
    world.time.tick = 35;
    expect(environmentAt(world).modifiers.temperatureOffset).toBeCloseTo(5, 10);
  });

  it("常量修饰不随进度变化", () => {
    const world = createWorldWithRule();
    world.time.tick = 2;
    expect(environmentAt(world).modifiers.temperatureOffset).toBe(0);
    world.time.tick = 18;
    expect(environmentAt(world).modifiers.temperatureOffset).toBe(0);
  });
});

describe("schema 校验", () => {
  it("重名相位 id 拒绝", () => {
    expect(() =>
      EnvironmentRuleSchema.parse({
        weatherSlotTicks: 10,
        phases: [
          { id: "dup", durationTicks: 5 },
          { id: "dup", durationTicks: 5 },
        ],
      }),
    ).toThrow(/duplicate phase id/);
  });
});
