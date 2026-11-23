/**
 * CC-12 Weather / Season View 测试。
 *
 * 覆盖：
 * ① `seasonAt`：数组顺序循环、绝对 tick 边界、跨周期不漂移、未配置空季；
 * ② `weatherAt` 的 intensity：随被选中天气透传，旧配置（无 intensity）为 0；
 * ③ `dayNightDayIndex`：daynight 24 小时日计数边界（tick 0/午夜前后/次日同刻/
 *    无 daynight 规则），并明确它不等于 `phaseAt().dayIndex` 的相位周期索引；
 * ④ 快照 → RoomState 的 dayIndex/seasonId/weatherIntensity 写入与 schema 末尾顺序；
 * ⑤ `season-change` 只在季节 id 变化时发一次（world 受众），`weather-change`
 *    载荷带 intensity；
 * ⑥ 旧环境配置（无 seasons/intensity）默认空串/0，不崩。
 */
import { existsSync, readFileSync } from "node:fs";

import { Decoder, Encoder } from "@colyseus/schema";
import { beforeAll, describe, expect, it } from "vitest";

import {
  bootstrapFramework,
  createDefaultGameDefinition,
  createGameSimulation,
  DayNightRuleSchema,
  EnvironmentRuleSchema,
  loadGameDefinition,
  phaseAt,
  type EnvironmentRule,
  type GameWorld,
  type SimulationPort,
} from "framework/index";
import { GameRoom } from "network/colyseus/rooms/GameRoom";
import { RoomState } from "network/colyseus/state/RoomState";
import type { ClientEvent } from "framework/simulation/clientEvents";
import type { DayNightRule } from "framework/config/schema/RuleSchema";
import {
  dayNightDayIndex,
  dayTicks,
  getDayNightRule,
  NO_SEASON,
  seasonAt,
  tickRateOf,
  weatherAt,
} from "framework/simulation/worldClock";

beforeAll(() => {
  bootstrapFramework();
});

function simWorld(sim: SimulationPort): GameWorld {
  return (sim as unknown as { world: GameWorld }).world;
}

function eventsOf(
  result: ReturnType<SimulationPort["tick"]>,
  sessionId: string,
  type?: string,
): ClientEvent[] {
  const events = result.clientEvents?.get(sessionId) ?? [];
  return type ? events.filter((event) => event.type === type) : events;
}

/** 最小相位程序（无 weather 时用于季节/相位断言）。 */
const PHASE_STUB = [{ id: "p", durationTicks: 60 }];

// ─────────────────────────────────────────────────────────────────────────────
describe("seasonAt：绝对 tick 对齐的季节循环", () => {
  const RULE: EnvironmentRule = EnvironmentRuleSchema.parse({
    weatherSlotTicks: 10,
    phases: PHASE_STUB,
    seasons: [
      { id: "a", durationTicks: 10 },
      { id: "b", durationTicks: 20 },
      { id: "c", durationTicks: 30 },
    ],
  });

  it("按数组顺序循环，边界 tick 归下一季，进度 [0,1)", () => {
    expect(seasonAt(0, RULE)).toEqual({ seasonId: "a", seasonIndex: 0, progress: 0 });
    expect(seasonAt(9, RULE)).toEqual({ seasonId: "a", seasonIndex: 0, progress: 0.9 });
    expect(seasonAt(10, RULE)).toEqual({ seasonId: "b", seasonIndex: 1, progress: 0 });
    expect(seasonAt(29, RULE).seasonId).toBe("b");
    expect(seasonAt(29, RULE).progress).toBeCloseTo(19 / 20, 10);
    expect(seasonAt(30, RULE)).toEqual({ seasonId: "c", seasonIndex: 2, progress: 0 });
    expect(seasonAt(59, RULE).progress).toBeCloseTo(29 / 30, 10);
  });

  it("跨周期不漂移：k × cycle 恒回第 0 季；同 tick 恒同值", () => {
    for (let k = 0; k < 5; k++) {
      expect(seasonAt(k * 60, RULE)).toEqual({
        seasonId: "a",
        seasonIndex: 0,
        progress: 0,
      });
      expect(seasonAt(k * 60 + 10, RULE).seasonId).toBe("b");
      expect(seasonAt(k * 60 + 30, RULE).seasonId).toBe("c");
    }
    expect(seasonAt(615, RULE)).toEqual(seasonAt(615, RULE));
    expect(seasonAt(615, RULE)).toMatchObject({ seasonId: "b", seasonIndex: 1 });
    expect(seasonAt(615, RULE).progress).toBeCloseTo(5 / 20, 10);
  });

  it("未配置 seasons → 空季节（不抛错）", () => {
    const noSeasons = EnvironmentRuleSchema.parse({
      weatherSlotTicks: 10,
      phases: PHASE_STUB,
    });
    expect(seasonAt(123, undefined)).toEqual(NO_SEASON);
    expect(seasonAt(123, noSeasons)).toEqual(NO_SEASON);
    expect(NO_SEASON).toEqual({ seasonId: "", seasonIndex: 0, progress: 0 });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("weatherAt：intensity 随被选中天气透传", () => {
  const RULE: EnvironmentRule = EnvironmentRuleSchema.parse({
    seed: 3,
    weatherSlotTicks: 10,
    phases: [
      {
        id: "a",
        durationTicks: 10,
        weather: [{ id: "rain", weight: 1, intensity: 0.4 }],
      },
      {
        id: "b",
        durationTicks: 10,
        weather: [
          { id: "storm", weight: 1, intensity: 1 },
          { id: "clear", weight: 1, intensity: 0 },
        ],
      },
    ],
  });

  it("单候选相位：强度与配置一致", () => {
    expect(weatherAt(0, RULE)).toEqual({
      weatherId: "rain",
      weatherSlot: 0,
      intensity: 0.4,
    });
  });

  it("多候选相位：每个槽的强度都对应该槽选中的天气", () => {
    const intensityById = new Map([
      ["rain", 0.4],
      ["storm", 1],
      ["clear", 0],
    ]);
    for (let slot = 0; slot < 40; slot++) {
      const weather = weatherAt(slot * RULE.weatherSlotTicks, RULE);
      expect(weather.weatherSlot).toBe(slot);
      expect(weather.intensity).toBe(intensityById.get(weather.weatherId));
    }
  });

  it("旧配置无 intensity → 0（不崩）", () => {
    const legacy = EnvironmentRuleSchema.parse({
      weatherSlotTicks: 10,
      phases: [
        { id: "p", durationTicks: 10, weather: [{ id: "clear", weight: 1 }] },
      ],
    });
    expect(weatherAt(0, legacy)).toEqual({
      weatherId: "clear",
      weatherSlot: 0,
      intensity: 0,
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("dayNightDayIndex：24 小时日计数（非相位周期索引）", () => {
  const RULE: DayNightRule = DayNightRuleSchema.parse({ cycleLengthSec: 600 });

  it("dayTicks = cycleLengthSec × tickRate（20tps → 12000 tick/天）", () => {
    expect(dayTicks(RULE, 20)).toBe(12000);
  });

  it("tick 0 为第 0 天；午夜前/午夜/次日同刻边界正确", () => {
    // 第 0 天从 hour 8 开始：跨午夜需要 16/24 天 = 8000 tick。
    expect(dayNightDayIndex(0, RULE, 20)).toBe(0);
    expect(dayNightDayIndex(7999, RULE, 20)).toBe(0);
    expect(dayNightDayIndex(8000, RULE, 20)).toBe(1); // 午夜
    expect(dayNightDayIndex(11999, RULE, 20)).toBe(1);
    expect(dayNightDayIndex(12000, RULE, 20)).toBe(1); // 次日 8 时（同一日内）
    expect(dayNightDayIndex(19999, RULE, 20)).toBe(1);
    expect(dayNightDayIndex(20000, RULE, 20)).toBe(2); // 第二个午夜
    expect(dayNightDayIndex(32000, RULE, 20)).toBe(3);
  });

  it("无 daynight 规则 → 0；不同 tickRate 各自按公式换算", () => {
    expect(dayNightDayIndex(999_999, undefined, 20)).toBe(0);
    // 10tps：600s → 6000 tick/天，午夜在 4000 tick。
    expect(dayNightDayIndex(3999, RULE, 10)).toBe(0);
    expect(dayNightDayIndex(4000, RULE, 10)).toBe(1);
    expect(dayNightDayIndex(6000, RULE, 10)).toBe(1);
    expect(dayNightDayIndex(10000, RULE, 10)).toBe(2);
  });

  it("与 phaseAt().dayIndex 语义不同：相位周期索引不是 24h 日计数", () => {
    const env = EnvironmentRuleSchema.parse({
      weatherSlotTicks: 10,
      phases: [{ id: "p", durationTicks: 100 }],
    });
    // 同一 tick：相位周期索引 120（floor(12000/100)），daynight 日计数 1。
    expect(phaseAt(12000, env).dayIndex).toBe(120);
    expect(dayNightDayIndex(12000, RULE, 20)).toBe(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("game/rules/environment.json：季节与天气强度配置", () => {
  it("4 个季节各 60000 tick；天气 intensity 为 0..1", () => {
    const raw = JSON.parse(
      readFileSync(new URL("../../game/rules/environment.json", import.meta.url), "utf8"),
    ) as unknown;
    const rule = EnvironmentRuleSchema.parse(raw);

    expect(rule.seasons).toEqual([
      { id: "spring", durationTicks: 60000 },
      { id: "summer", durationTicks: 60000 },
      { id: "autumn", durationTicks: 60000 },
      { id: "winter", durationTicks: 60000 },
    ]);
    const intensityById = new Map<string, number | undefined>();
    for (const phase of rule.phases) {
      for (const option of phase.weather ?? []) {
        intensityById.set(option.id, option.intensity);
      }
    }
    expect(Object.fromEntries(intensityById)).toEqual({
      clear: 0,
      rain: 0.4,
      fog: 0.2,
      drought: 0.7,
      storm: 1,
    });
    for (const intensity of intensityById.values()) {
      expect(intensity).toBeGreaterThanOrEqual(0);
      expect(intensity).toBeLessThanOrEqual(1);
    }
  });

  it("schema 校验：季节 id 唯一、seasons ≥1、intensity 在 [0,1]", () => {
    const base = { weatherSlotTicks: 10, phases: PHASE_STUB };
    expect(() =>
      EnvironmentRuleSchema.parse({
        ...base,
        seasons: [
          { id: "dup", durationTicks: 5 },
          { id: "dup", durationTicks: 5 },
        ],
      }),
    ).toThrow(/duplicate season id/);
    expect(() => EnvironmentRuleSchema.parse({ ...base, seasons: [] })).toThrow();
    expect(() =>
      EnvironmentRuleSchema.parse({
        ...base,
        phases: [
          {
            id: "p",
            durationTicks: 10,
            weather: [{ id: "rain", weight: 1, intensity: 1.5 }],
          },
        ],
      }),
    ).toThrow();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("快照/RoomState 同步与 schema 末尾顺序", () => {
  it("真实配置：快照填 dayIndex/seasonId/weatherIntensity；applySnapshot 写入 RoomState", async () => {
    const gameDef = loadGameDefinition({ gameJsonPath: "game/game.json" });
    const sim = await createGameSimulation(gameDef);
    const result = sim.tick(50);
    const env = result.snapshot.environment!;
    const world = simWorld(sim);

    expect(env.seasonId).toBe("spring");
    // 真实世界 tick 不一定是 0（boot 初始演化可能推进世界 tick），
    // 断言与 daynight 公式同源，而不是硬编码第 0 天。
    expect(env.dayIndex).toBe(
      dayNightDayIndex(world.time.tick, getDayNightRule(world), tickRateOf(world)),
    );
    expect(env.dayIndex).toBeGreaterThan(0);
    expect(env.weatherIntensity).toBeGreaterThanOrEqual(0);
    expect(env.weatherIntensity).toBeLessThanOrEqual(1);

    const room = new GameRoom();
    room.state = new RoomState();
    const access = room as unknown as {
      sim: SimulationPort;
      applySnapshot: (r: ReturnType<SimulationPort["tick"]>) => void;
    };
    access.sim = sim;
    access.applySnapshot(result);

    expect(room.state.dayIndex).toBe(env.dayIndex);
    expect(room.state.seasonId).toBe(env.seasonId);
    expect(room.state.weatherIntensity).toBe(env.weatherIntensity);
    // 既有字段索引/值不变
    expect(room.state.weatherId).toBe(env.weatherId);
    expect(room.state.phaseId).toBe(env.phaseId);
    expect(room.state.phaseProgress).toBeCloseTo(env.phaseProgress, 10);
  });

  it("RoomState 默认 0/空串/0；编码往返保真；三个字段追加在末尾", () => {
    const state = new RoomState();
    expect(state.dayIndex).toBe(0);
    expect(state.seasonId).toBe("");
    expect(state.weatherIntensity).toBe(0);

    state.tick = 77;
    state.dayIndex = 3;
    state.seasonId = "winter";
    state.weatherIntensity = 0.7;
    const bytes = new Encoder(state).encodeAll();
    const decoded = new RoomState();
    new Decoder(decoded).decode(bytes);
    expect(decoded.tick).toBe(77);
    expect(decoded.dayIndex).toBe(3);
    expect(decoded.seasonId).toBe("winter");
    expect(decoded.weatherIntensity).toBe(0.7);

    const fields = Object.getOwnPropertyNames(RoomState.prototype).filter(
      (name) => name !== "constructor",
    );
    expect(fields.slice(-3)).toEqual(["dayIndex", "seasonId", "weatherIntensity"]);

    const client = readFileSync(
      new URL("../../src/network/colyseus/client-schema/schema.ts", import.meta.url),
      "utf8",
    );
    const roomBlock = client.slice(client.indexOf("export class RoomState"));
    const clientFields = [...roomBlock.matchAll(/public\s+(\w+)\s*[!?:]/g)].map(
      (match) => match[1],
    );
    expect(clientFields.slice(-3)).toEqual(["dayIndex", "seasonId", "weatherIntensity"]);

    const gdPath = new URL("../../../godot-client/generated/schema.gd", import.meta.url);
    if (existsSync(gdPath)) {
      const gd = readFileSync(gdPath, "utf8");
      const gdRoom = gd.slice(gd.indexOf("class RoomState"));
      const gdFields = [...gdRoom.matchAll(/Field\.new\("(\w+)"/g)].map((match) => match[1]);
      expect(gdFields.slice(-3)).toEqual(["dayIndex", "seasonId", "weatherIntensity"]);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("season-change / weather-change 事件", () => {
  const ENV_RULE: EnvironmentRule = EnvironmentRuleSchema.parse({
    seed: 1,
    weatherSlotTicks: 10,
    seasons: [
      { id: "seasonA", durationTicks: 10 },
      { id: "seasonB", durationTicks: 10 },
    ],
    phases: [
      {
        id: "phaseA",
        durationTicks: 10,
        weather: [{ id: "rain", weight: 1, intensity: 0.4 }],
      },
      {
        id: "phaseB",
        durationTicks: 10,
        weather: [{ id: "storm", weight: 1, intensity: 1 }],
      },
    ],
  });
  const DAYNIGHT_RULE: DayNightRule = DayNightRuleSchema.parse({
    // 0.6s/天 @20tps = 12 tick/天；午夜在 tick 8，便于与季节边界（10）区分。
    cycleLengthSec: 0.6,
  });

  async function customSim(): Promise<SimulationPort> {
    const def = createDefaultGameDefinition();
    def.resolvedRules["environment"] = ENV_RULE;
    def.resolvedRules["daynight"] = DAYNIGHT_RULE;
    return createGameSimulation(def);
  }

  it("首帧只记基线；季节/天气变化各发一次 world 事件，载荷完整", async () => {
    const sim = await customSim();
    sim.addPlayer("s1");
    sim.addPlayer("s2");

    const first = sim.tick(50);
    expect(eventsOf(first, "s1", "season-change")).toHaveLength(0);
    expect(eventsOf(first, "s1", "weather-change")).toHaveLength(0);

    // tick 1 → 10：跨第 2 个天气槽与季节边界。
    simWorld(sim).time.tick = 9;
    const changed = sim.tick(50);
    expect(changed.snapshot.tick).toBe(10);

    const seasonA = eventsOf(changed, "s1", "season-change");
    const seasonB = eventsOf(changed, "s2", "season-change");
    expect(seasonA).toHaveLength(1);
    expect(seasonB).toHaveLength(1);
    const expectedDayIndex = dayNightDayIndex(10, DAYNIGHT_RULE, 20);
    expect(seasonA[0]!.data).toEqual({
      seasonId: "seasonB",
      dayIndex: expectedDayIndex,
      tick: 10,
    });
    // world 受众：两个客户端收到同一条（seq 相同）。
    expect(seasonB[0]!.seq).toBe(seasonA[0]!.seq);

    const weatherA = eventsOf(changed, "s1", "weather-change");
    expect(weatherA).toHaveLength(1);
    expect(weatherA[0]!.data).toMatchObject({
      weatherId: "storm",
      phaseId: "phaseB",
      intensity: 1,
      tick: 10,
    });

    // 下一 tick 不再变化 → 不重复发。
    const steady = sim.tick(50);
    expect(eventsOf(steady, "s1", "season-change")).toHaveLength(0);
    expect(eventsOf(steady, "s1", "weather-change")).toHaveLength(0);
  });

  it("旧配置（无 seasons/intensity）：快照空季节/0 强度，且不发 season-change", async () => {
    const def = createDefaultGameDefinition();
    def.resolvedRules["environment"] = EnvironmentRuleSchema.parse({
      weatherSlotTicks: 10,
      phases: [
        { id: "p", durationTicks: 100, weather: [{ id: "clear", weight: 1 }] },
      ],
    });
    const sim = await createGameSimulation(def);
    sim.addPlayer("s1");

    const first = sim.tick(50);
    expect(first.snapshot.environment).toMatchObject({
      seasonId: "",
      weatherIntensity: 0,
    });
    simWorld(sim).time.tick = 49;
    const later = sim.tick(50);
    expect(later.snapshot.environment).toMatchObject({
      seasonId: "",
      weatherIntensity: 0,
    });
    expect(eventsOf(later, "s1", "season-change")).toHaveLength(0);
  });
});
