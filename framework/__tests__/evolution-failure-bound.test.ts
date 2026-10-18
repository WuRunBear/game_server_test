/**
 * 生态切片 E1-b（F-11）：离线补差的失败槽上限 + exact 告警去重。
 *
 * 覆盖验收矩阵：
 * - 不可落位规则 + 24h 离线跨度 → canPlace 调用次数有界（≠ 槽数 × 尝试数）；
 * - 连续失败未达上限时仍会恢复产出（第 64 槽可落位仍产出；第 65 槽才可落位
 *   则在第 64 槽早退，槽语义边界精确）；
 * - 正常可落位规则产出与"无上限"旧行为逐点一致；
 * - spawnExact 同一失效落点重复失败只告警一次（跨 evolve 调用亦然）；
 * - deps.failureSlotLimit 可覆盖默认上限。
 *
 * 探针全部是确定性计数器（canPlace/countByKind 调用数），不用时间断言。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { createGameWorld, type GameWorld } from "framework/world";
import { walkableAt } from "map/geometry/query";
import { EVOLUTION_MAX_CONSECUTIVE_FAILURE_SLOTS, evolve, type EvolutionDeps } from "map/evolution/engine";
import { PLACEMENT_MAX_ATTEMPTS } from "map/evolution/placement";
import type { EntityRule } from "map/evolution/schema";
import { makeTestGeometry } from "./helpers/mapGeometry";
import type { MapGeometry } from "map/geometry/types";

const loggerCalls = vi.hoisted(() => [] as Array<{ message: string; extra?: Record<string, unknown> }>);
vi.mock("framework/utils/logger", () => ({
  createLogger: () => ({
    info: () => {},
    warn: (message: string, extra?: Record<string, unknown>) => {
      loggerCalls.push({ message, extra });
    },
    error: () => {},
  }),
}));

const KEY = "efb-map";

/** 全可走 8×8 单区域图。 */
function walkableGeometry(): MapGeometry {
  return makeTestGeometry({ key: KEY, width: 8, height: 8, regions: ["den"] });
}

/** 单格阻挡图（(1,1) 不可走；exact 告警用例）。 */
function blockedSpotGeometry(): MapGeometry {
  return makeTestGeometry({
    key: "efb-exact",
    width: 8,
    height: 8,
    regions: ["den"],
    blocked: (tx, ty) => tx === 1 && ty === 1,
  });
}

/** 全不可走图（任何落位都失败）。 */
function blockedGeometry(): MapGeometry {
  return makeTestGeometry({ key: KEY, width: 8, height: 8, regions: ["den"], blocked: () => true });
}

function makeWorld(): GameWorld {
  return createGameWorld(50);
}

interface HarnessOptions {
  /** 前 N 次 canPlace 调用返回 false，之后按地形判定（模拟"失败一段时间后可落位"）。 */
  failBudget?: number;
}

function makeHarness(geometry: MapGeometry, options: HarnessOptions = {}) {
  const spawns: Array<{ kind: string; x: number; y: number }> = [];
  const state = { canPlaceCalls: 0, countByKindCalls: 0 };
  const deps: EvolutionDeps = {
    seed: 42,
    countByKind: () => {
      state.countByKindCalls += 1;
      return spawns.length;
    },
    canPlace: (_mapKey, _kind, x, y) => {
      state.canPlaceCalls += 1;
      if (options.failBudget !== undefined && state.canPlaceCalls <= options.failBudget) return false;
      return walkableAt(geometry, x, y);
    },
    spawn: (kind, _mapKey, x, y) => {
      spawns.push({ kind, x, y });
    },
  };
  return { deps, spawns, state };
}

function densityRule(max: number, every = 20): EntityRule {
  return { map: KEY, region: "den", kind: "efb-kind", max, every, mode: "density" };
}

beforeEach(() => {
  loggerCalls.length = 0;
});

describe("连续失败槽上限：离线成本有界", () => {
  it("不可落位规则 + 24h 离线跨度：每槽 32 次尝试被 64 槽上限截断", () => {
    const geometry = blockedGeometry();
    const { deps, spawns, state } = makeHarness(geometry);

    // 1,728,000 ticks ≈ 24h@20tps；every=20 → 86,400 槽
    evolve(makeWorld(), geometry, [densityRule(4)], 0, 1_728_000, deps);

    expect(spawns).toEqual([]);
    // 每槽候选耗尽即放弃本轮补足（spawnDensity break）→ 64 槽 × 32 候选 =
    // 2,048 次判定（旧行为 86,400 槽 × 32 ≈ 2.76M；need 更多时按槽内 break 计）
    const expected = EVOLUTION_MAX_CONSECUTIVE_FAILURE_SLOTS * PLACEMENT_MAX_ATTEMPTS;
    expect(state.canPlaceCalls).toBe(expected);
    expect(state.canPlaceCalls).toBeLessThan(1_728_000);
    // 计数仍只惰性查询一次
    expect(state.countByKindCalls).toBe(1);
  });

  it("deps.failureSlotLimit 可覆盖默认上限（测试/特殊场景）", () => {
    const geometry = blockedGeometry();
    const { deps, spawns, state } = makeHarness(geometry);
    deps.failureSlotLimit = 3;

    evolve(makeWorld(), geometry, [densityRule(1, 10)], 0, 1_728_000, deps);

    expect(spawns).toEqual([]);
    expect(state.canPlaceCalls).toBe(3 * 1 * PLACEMENT_MAX_ATTEMPTS);
  });
});

describe("失败槽上限不改变有产出时的槽语义", () => {
  it("前 63 槽失败、第 64 槽可落位 → 仍然产出（未达上限）", () => {
    const geometry = walkableGeometry();
    const failBudget = 63 * PLACEMENT_MAX_ATTEMPTS; // 2016
    const { deps, spawns, state } = makeHarness(geometry, { failBudget });

    evolve(makeWorld(), geometry, [densityRule(1, 10)], 0, 10_000, deps);

    expect(spawns).toHaveLength(1);
    expect(state.canPlaceCalls).toBe(failBudget + 1); // 第 64 槽首个候选即可落位
  });

  it("前 64 槽失败、之后可落位 → 已跳至区间末尾，不再尝试", () => {
    const geometry = walkableGeometry();
    const failBudget = 64 * PLACEMENT_MAX_ATTEMPTS; // 2048
    const { deps, spawns, state } = makeHarness(geometry, { failBudget });

    evolve(makeWorld(), geometry, [densityRule(1, 10)], 0, 10_000, deps);

    expect(spawns).toEqual([]);
    expect(state.canPlaceCalls).toBe(failBudget);
  });

  it("正常可落位规则：默认上限与无限上限产出逐点一致（旧行为）", () => {
    const geometry = walkableGeometry();
    const rule = densityRule(3, 10);

    const bounded = makeHarness(geometry);
    evolve(makeWorld(), geometry, [rule], 0, 10_000, bounded.deps);

    const unbounded = makeHarness(geometry);
    unbounded.deps.failureSlotLimit = 1_000_000_000;
    evolve(makeWorld(), geometry, [rule], 0, 10_000, unbounded.deps);

    expect(bounded.spawns).toHaveLength(3);
    expect(bounded.spawns).toEqual(unbounded.spawns);
  });
});

describe("spawnExact 告警去重", () => {
  it("同一失效落点跨槽、跨 evolve 调用只告警一次；尝试次数仍有界", () => {
    const geometry = blockedSpotGeometry();
    const rule: EntityRule = {
      map: "efb-exact",
      region: "den",
      kind: "efb-portal",
      max: 1,
      every: 10,
      mode: "exact",
      at: { x: 1, y: 1 },
    };
    const { deps, spawns, state } = makeHarness(geometry);

    evolve(makeWorld(), geometry, [rule], 0, 10_000, deps);
    evolve(makeWorld(), geometry, [rule], 10_000, 20_000, deps);

    expect(spawns).toEqual([]);
    expect(loggerCalls.filter((c) => c.message.includes("exact landing illegal"))).toHaveLength(1);
    expect(state.canPlaceCalls).toBe(EVOLUTION_MAX_CONSECUTIVE_FAILURE_SLOTS * 2);
  });
});
