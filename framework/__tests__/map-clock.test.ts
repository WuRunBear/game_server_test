/**
 * 时钟适配（framework/map/runtime/clock.ts）单元测试。
 *
 * 覆盖全局游戏时刻（复用 world.time.tick，无新增时钟字段）契约：
 * - advanceTickTo：精确推进到目标且不影响 timeOfDay；target ≤ 当前 tick 不回退。
 * - computeOfflineTicks：按时长与 tickRate 精确折算（向下取整）；now < savedAt
 *   返回 0；超过 maxOfflineTicks 截断到上限并 warn，未超限不告警。
 * - readTick：返回当前 world.time.tick。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createGameWorld, PHASE_DAY } from "framework/world";
import { advanceTickTo, computeOfflineTicks, readTick } from "framework/map/runtime/clock";

const { warnCalls } = vi.hoisted(() => ({
  warnCalls: [] as Array<{ message: string; extra?: Record<string, unknown> }>,
}));

// clock.ts 模块级持有 createLogger("map-clock")——替换为记录调用的假体以断言 warn
vi.mock("framework/utils/logger", () => ({
  createLogger: () => ({
    info: () => {},
    warn: (message: string, extra?: Record<string, unknown>) => {
      warnCalls.push({ message, extra });
    },
    error: () => {},
  }),
}));

describe("advanceTickTo", () => {
  it("精确推进到目标 tick，且不影响 timeOfDay", () => {
    const world = createGameWorld(50);
    world.time.tick = 100;

    advanceTickTo(world, 150);

    expect(readTick(world)).toBe(150);
    expect(world.time.timeOfDay).toEqual({ hour: 8, phase: PHASE_DAY });
  });

  it("target 小于当前 tick 时不回退（单调计数器）", () => {
    const world = createGameWorld(50);
    world.time.tick = 100;

    advanceTickTo(world, 50);

    expect(readTick(world)).toBe(100);
  });

  it("target 等于当前 tick 时保持不变", () => {
    const world = createGameWorld(50);
    world.time.tick = 100;

    advanceTickTo(world, 100);

    expect(readTick(world)).toBe(100);
  });
});

describe("readTick", () => {
  it("返回当前 world.time.tick", () => {
    const world = createGameWorld(50);
    world.time.tick = 7;

    expect(readTick(world)).toBe(7);
  });
});

describe("computeOfflineTicks", () => {
  beforeEach(() => {
    warnCalls.length = 0;
  });

  it("按时长与 tickRate 精确折算：15000ms × 20/s = 300 tick", () => {
    expect(computeOfflineTicks(1000, 16000, 20)).toBe(300);
  });

  it("不足一个 tick 的零头向下取整：1999ms × 20/s → 39", () => {
    expect(computeOfflineTicks(0, 1999, 20)).toBe(39);
  });

  it("now < savedAt（时钟回拨）返回 0", () => {
    expect(computeOfflineTicks(2000, 1000, 20)).toBe(0);
  });

  it("超过 maxOfflineTicks 截断到上限并 warn", () => {
    // 100000ms × 20/s = 2000 tick > 上限 100
    expect(computeOfflineTicks(0, 100_000, 20, 100)).toBe(100);
    expect(warnCalls).toHaveLength(1);
  });

  it("未超上限时不告警，返回精确值", () => {
    expect(computeOfflineTicks(0, 4000, 20, 100)).toBe(80);
    expect(warnCalls).toHaveLength(0);
  });

  it("未提供 maxOfflineTicks 时不封顶", () => {
    expect(computeOfflineTicks(0, 100_000, 20)).toBe(2000);
    expect(warnCalls).toHaveLength(0);
  });
});
