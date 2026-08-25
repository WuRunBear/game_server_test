/**
 * 统一地图校验器测试（framework/__tests__/map-validate.test.ts）。
 *
 * 覆盖 validateMapRuntime 的校验语义（计划假设 D1）：
 * - 硬错误（errors，buildRuntime 据此抛错）：出生点落在阻挡格 / 越界 / player 为 null；
 * - 软告警（warnings，只记日志不抛错）：最大 4 向连通域占比低于阈值；
 * - 负例（无错误无告警）：合法地图正常通过。
 *
 * 校验器形状：`validateMapRuntime(runtime) → { errors: string[], warnings: string[] }`
 * —— 校验器本身纯函数（不抛错、不记日志），由 buildRuntime 在出口处
 * 依据 errors 抛错、并对 warnings 逐条 logger.warn。因此本文件直接断言
 * report，不依赖全局 logger（软告警路径可无噪音触发）。
 */
import { beforeAll, describe, expect, it } from "vitest";

import { bootstrapFramework, registerGenerator } from "framework/index";
import { buildMapRuntime, validateMapRuntime, MIN_WALKABLE_COMPONENT_FRACTION } from "map";
import type { GeneratedMapSource, MapRuntime, Vec2 } from "map";

/**
 * 构造最小 MapRuntime 字面量（手构，不经过任何生成器）。
 *
 * 默认 4×4、16px/tile，全可走；调用方可覆盖 blocked / player / npcs / id 等。
 * 出生点坐标为世界（像素）坐标，校验器内部换算为 tile 坐标。
 */
function makeRuntime(opts: {
  id?: string;
  width?: number;
  height?: number;
  blocked: Array<number>;
  player: Vec2 | null;
  npcs?: Array<{ kind: string; pos: Vec2; zoneId?: number }>;
}): MapRuntime {
  const width = opts.width ?? 4;
  const height = opts.height ?? 4;
  return {
    id: opts.id ?? "test-map",
    name: "test map",
    grid: { width, height, tileWidth: 16, tileHeight: 16 },
    blocked: Uint8Array.from(opts.blocked),
    spawns: { player: opts.player, npcs: opts.npcs ?? [] },
    zones: [],
  };
}

/** 全可走 4×4 网格（16 格，全 0 可走）。 */
const ALL_FLOOR = Array<number>(16).fill(0);

describe("validateMapRuntime: 出生点可用性（硬错误）", () => {
  it("POSITIVE：player 出生点落在阻挡格 → errors 含 'is blocked'", () => {
    const blocked = [...ALL_FLOOR];
    // tile (1,1)（行 1 列 1）标记为阻挡：blocked[1*4 + 1] = 1
    blocked[1 * 4 + 1] = 1;
    // player 像素 (16,16) → tile (1,1) → 阻挡
    const rt = makeRuntime({ blocked, player: { x: 16, y: 16 } });

    const report = validateMapRuntime(rt);

    expect(report.errors.length).toBeGreaterThan(0);
    expect(report.errors).toEqual(
      expect.arrayContaining([expect.stringContaining("player spawn at (1, 1) is blocked")]),
    );
  });

  it("POSITIVE：player 出生点为 null → errors 含 'player spawn is missing'", () => {
    const rt = makeRuntime({ blocked: ALL_FLOOR, player: null });

    const report = validateMapRuntime(rt);

    expect(report.errors).toEqual(
      expect.arrayContaining([expect.stringContaining("player spawn is missing")]),
    );
  });

  it("POSITIVE：player 出生点越界 → errors 含 'out of grid bounds'", () => {
    // 像素 (64,16) → tile (4,1)，width=4 → tileX=4 越界
    const rt = makeRuntime({ blocked: ALL_FLOOR, player: { x: 64, y: 16 } });

    const report = validateMapRuntime(rt);

    expect(report.errors).toEqual(
      expect.arrayContaining([expect.stringContaining("player spawn at (4, 1) is out of grid bounds")]),
    );
  });

  it("POSITIVE：NPC 出生点落在阻挡格 → errors 含 'npc spawn ... is blocked'", () => {
    const blocked = [...ALL_FLOOR];
    // tile (2,1)：blocked[1*4 + 2] = 1
    blocked[1 * 4 + 2] = 1;
    const rt = makeRuntime({
      blocked,
      player: { x: 16, y: 16 },
      npcs: [{ kind: "villager", pos: { x: 32, y: 16 } }],
    });

    const report = validateMapRuntime(rt);

    expect(report.errors).toEqual(
      expect.arrayContaining([
        expect.stringContaining("npc spawn \"villager\" at (2, 1) is blocked"),
      ]),
    );
  });
});

describe("validateMapRuntime: 负例与软告警", () => {
  it("NEGATIVE：合法地图（player 在可走格、全连通）→ 无错误且无告警", () => {
    const rt = makeRuntime({ blocked: ALL_FLOOR, player: { x: 16, y: 16 } });

    const report = validateMapRuntime(rt);

    expect(report.errors).toHaveLength(0);
    expect(report.warnings).toHaveLength(0);
  });

  it("SOFT WARN：最大连通域占比 < 阈值（封闭空腔）→ 无错误但有告警", () => {
    // 4×4 只有 4 个互不 4 邻接的孤立可走格，最大连通域=1，floor=4 → 25% < 40%
    const blocked = [
      1, 0, 1, 1, // row0: 仅 (1,0) 可走
      1, 1, 1, 0, // row1: 仅 (3,1) 可走
      0, 1, 1, 1, // row2: 仅 (0,2) 可走
      1, 1, 0, 1, // row3: 仅 (2,3) 可走
    ];
    // player 像素 (16,0) → tile (1,0) → 可走（在最大连通域内）
    const rt = makeRuntime({ blocked, player: { x: 16, y: 0 } });

    const report = validateMapRuntime(rt);

    // 出生点可用 → 硬错误路径保持干净
    expect(report.errors).toHaveLength(0);
    // 连通性告警路径被触发
    expect(report.warnings.length).toBeGreaterThan(0);
    expect(report.warnings).toEqual(
      expect.arrayContaining([
        expect.stringContaining("largest walkable component"),
        expect.stringContaining(`threshold ${Math.round(MIN_WALKABLE_COMPONENT_FRACTION * 100)}%`),
      ]),
    );
  });
});

describe("buildMapRuntime 出口挂载：依据 errors 抛错 / 依 warnings 仅告警", () => {
  beforeAll(() => {
    bootstrapFramework();
    registerGenerator("test-valid", (opts) =>
      makeRuntime({ id: opts.id as string, blocked: ALL_FLOOR, player: { x: 16, y: 16 } }),
    );
    registerGenerator("test-blocked-spawn", (opts) => {
      const blocked = [...ALL_FLOOR];
      blocked[1 * 4 + 1] = 1; // tile (1,1) 阻挡
      return makeRuntime({ id: opts.id as string, blocked, player: { x: 16, y: 16 } });
    });
  });

  /** 把测试生成器 id 拼成 GeneratedMapSource（尺寸与实际生成器返回值一致）。 */
  function source(generatorId: string, id: string): GeneratedMapSource {
    return {
      kind: "generated",
      generatorId,
      id,
      name: id,
      seed: 1,
      width: 4,
      height: 4,
      tileWidth: 16,
      tileHeight: 16,
    };
  }

  it("errors 非空 → buildMapRuntime 抛错（出生点不可用='必坏图' 尽早暴露）", () => {
    expect(() => buildMapRuntime(source("test-blocked-spawn", "bad"))).toThrow(
      /map bad: player spawn at \(1, 1\) is blocked/,
    );
  });

  it("errors 空 → buildMapRuntime 正常返回（不抛错）", () => {
    const rt = buildMapRuntime(source("test-valid", "good"));
    expect(rt.id).toBe("good");
    expect(rt.grid.width).toBe(4);
  });
});
