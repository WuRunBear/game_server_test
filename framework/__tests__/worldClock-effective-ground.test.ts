/**
 * 派生地面视图（framework/simulation/worldClock/effectiveGround）测试。
 *
 * 断言：
 * ① 无规则 / 无覆盖时有效语义 = 底板语义，底板 tiles 不被改写；
 * ② 相位驱动：冬季草→雪、春季融雪，同一坐标结果随相位变化；
 * ③ 雪线随进度移动：层号阈值 + 进度窗口组合（高海拔先积雪、后融化）；
 * ④ 斑驳覆盖：coverage + hash 阈值，同相位内不闪烁、跨相位可不同；
 * ⑤ 区域过滤、像素换算、越界安全；
 * ⑥ 纯函数确定性（同 tick/坐标恒同值，可重复求值）。
 */
import { beforeAll, describe, expect, it } from "vitest";
import {
  bootstrapFramework,
  createDefaultGameDefinition,
  createGameInstance,
  deriveEffectiveGround,
  effectiveGroundAt,
  effectiveGroundAtPixel,
  effectiveGroundViewAt,
  EnvironmentRuleSchema,
  type EnvironmentRule,
  type GameWorld,
} from "framework/index";
import type { MapGeometry } from "framework/map/geometry/types";

beforeAll(() => {
  bootstrapFramework();
});

/** 构造 8×8 测试图：地面语义可配、层号按行递增、两个区域。 */
function createGeometry(options: {
  ground?: number;
  levelOf?: (x: number, y: number) => number;
  regionOf?: (x: number, y: number) => number;
}): MapGeometry {
  const width = 8;
  const height = 8;
  const size = width * height;
  const geometry: MapGeometry = {
    key: "test",
    grid: { width, height, tileWidth: 16, tileHeight: 16 },
    tiles: new Uint8Array(size).fill(options.ground ?? 3),
    walkable: new Uint8Array(size).fill(1),
    level: new Int8Array(size),
    regions: new Map([
      ["meadow", { name: "meadow", meta: {} }],
      ["peak", { name: "peak", meta: {} }],
    ]),
    regionOfTile: new Uint16Array(size),
    version: "test-version",
  };
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const index = y * width + x;
      geometry.level[index] = options.levelOf ? options.levelOf(x, y) : 0;
      geometry.regionOfTile[index] = options.regionOf ? options.regionOf(x, y) : 0;
    }
  }
  return geometry;
}

function createWorld(
  geometry: MapGeometry,
  rule: EnvironmentRule | undefined,
): GameWorld {
  const world = createGameInstance(createDefaultGameDefinition()).world;
  world.maps["test"] = geometry;
  world.defaultMapId = "test";
  if (rule) world.gameDef.resolvedRules["environment"] = rule;
  return world;
}

/** 两相位规则：cold[0,100) / warm[100,200)。 */
const RULE = EnvironmentRuleSchema.parse({
  seed: 7,
  weatherSlotTicks: 50,
  phases: [
    { id: "cold", durationTicks: 100 },
    { id: "warm", durationTicks: 100 },
  ],
  groundOverrides: [
    // 高海拔先积雪（cold 进度 0.5 / 0.8 两道雪线下降）
    { phaseId: "cold", fromSemantic: 3, toSemantic: 10, minLevel: 2 },
    { phaseId: "cold", fromSemantic: 3, toSemantic: 10, minLevel: 1, minProgress: 0.5 },
    { phaseId: "cold", fromSemantic: 3, toSemantic: 10, minLevel: 0, minProgress: 0.8 },
    // warm：雪线随进度上移（低处先化）
    { phaseId: "warm", fromSemantic: 3, toSemantic: 10, minLevel: 2 },
    { phaseId: "warm", fromSemantic: 3, toSemantic: 10, minLevel: 1, maxProgress: 0.6 },
    { phaseId: "warm", fromSemantic: 3, toSemantic: 10, minLevel: 0, maxProgress: 0.3 },
    // 斑驳：cold 后半段林地 3 成覆盖（恒定 coverage，验证不闪烁）
    {
      phaseId: "cold",
      fromSemantic: 4,
      toSemantic: 11,
      minProgress: 0.5,
      coverage: 0.3,
    },
  ],
});

describe("① 无规则 / 无覆盖", () => {
  it("无 environment 规则时有效语义 = 底板语义（越界为 0）", () => {
    const world = createWorld(createGeometry({ ground: 5 }), undefined);
    expect(effectiveGroundAt(world, 0, 0)).toBe(5);
    expect(effectiveGroundAt(world, -1, 0)).toBe(0);
    expect(effectiveGroundViewAt(world, 0, 0)).toMatchObject({ semantic: 5, baseSemantic: 5 });
  });

  it("有规则但当前相位无覆盖：语义不变，底板 tiles 不被改写", () => {
    const geometry = createGeometry({ ground: 3 });
    const world = createWorld(geometry, RULE);
    world.time.tick = 170; // warm, progress 0.7：level 0 已融雪
    const before = geometry.tiles[0];
    expect(effectiveGroundAt(world, 0, 0)).toBe(3);
    expect(geometry.tiles[0]).toBe(before);
    expect([...geometry.tiles]).toEqual(new Array(64).fill(3));
  });
});

describe("② 相位驱动：冬季草→雪 / 春季融雪", () => {
  it("同坐标在 cold 与 warm 相位结果不同（同相位内恒定）", () => {
    const world = createWorld(createGeometry({ ground: 3 }), RULE);
    world.time.tick = 90; // cold, progress 0.9 → layer 0 亦覆盖
    expect(effectiveGroundAt(world, 0, 0)).toBe(10);

    world.time.tick = 150; // warm, progress 0.5 → 仅 layer ≥ 2 保留
    expect(effectiveGroundAt(world, 0, 0)).toBe(3);
  });
});

describe("③ 雪线随进度移动", () => {
  const geometry = createGeometry({
    ground: 3,
    levelOf: (_x, y) => y, // 行 0..7 = 层 0..7
  });

  it("cold：进度推进 → 雪线下降（越来越多低层结雪）", () => {
    const world = createWorld(geometry, RULE);

    world.time.tick = 10; // progress 0.1：仅 level ≥ 2
    expect(effectiveGroundAt(world, 0, 0)).toBe(3);
    expect(effectiveGroundAt(world, 0, 1)).toBe(3);
    expect(effectiveGroundAt(world, 0, 2)).toBe(10);

    world.time.tick = 60; // progress 0.6：level ≥ 1
    expect(effectiveGroundAt(world, 0, 0)).toBe(3);
    expect(effectiveGroundAt(world, 0, 1)).toBe(10);

    world.time.tick = 90; // progress 0.9：全部层
    expect(effectiveGroundAt(world, 0, 0)).toBe(10);
  });

  it("warm：进度推进 → 雪线上升（低处先化、山顶最后化）", () => {
    const world = createWorld(geometry, RULE);

    world.time.tick = 110; // progress 0.1：尚早，level ≤ 1 仍积雪
    expect(effectiveGroundAt(world, 0, 0)).toBe(10);
    expect(effectiveGroundAt(world, 0, 1)).toBe(10);
    expect(effectiveGroundAt(world, 0, 2)).toBe(10);

    world.time.tick = 170; // progress 0.7：level 1 及以下已化，只剩 level ≥ 2
    expect(effectiveGroundAt(world, 0, 0)).toBe(3);
    expect(effectiveGroundAt(world, 0, 1)).toBe(3);
    expect(effectiveGroundAt(world, 0, 2)).toBe(10);

    world.time.tick = 195; // progress 0.95：低处全化，山顶（level ≥ 2）最后化
    expect(effectiveGroundAt(world, 0, 0)).toBe(3);
    expect(effectiveGroundAt(world, 0, 7)).toBe(10);
  });
});

describe("④ 斑驳覆盖（hash 阈值）", () => {
  /** 64 格林地，cold 后半段覆盖 30%。 */
  function patchWorld(): GameWorld {
    return createWorld(createGeometry({ ground: 4 }), RULE);
  }

  it("覆盖比例接近配置阈值，且同相位内不闪烁（进度变化不改命中集合）", () => {
    const world = patchWorld();
    const collect = (tick: number): Set<string> => {
      world.time.tick = tick;
      const cells = new Set<string>();
      for (let y = 0; y < 8; y++) {
        for (let x = 0; x < 8; x++) {
          if (effectiveGroundAt(world, x, y) === 11) cells.add(`${x},${y}`);
        }
      }
      return cells;
    };

    const at60 = collect(60);
    const at90 = collect(90);
    expect(at60.size).toBeGreaterThan(5);
    expect(at60.size).toBeLessThan(40);
    expect(at90).toEqual(at60); // 恒定 coverage：同相位内集合不变（不闪烁）

    // 前半段（progress < 0.5）不应用
    expect(collect(10).size).toBe(0);
  });

  it("不同相位下同一格可不同（hash 含相位 id），但各自确定", () => {
    const world = createWorld(createGeometry({ ground: 3 }), RULE);
    world.time.tick = 90; // cold: 全格雪
    expect(effectiveGroundAt(world, 3, 3)).toBe(10);
    world.time.tick = 150; // warm: 全格草
    expect(effectiveGroundAt(world, 3, 3)).toBe(3);
    world.time.tick = 90;
    expect(effectiveGroundAt(world, 3, 3)).toBe(10);
  });
});

describe("⑤ 区域过滤 / 像素换算 / 越界", () => {
  it("excludeRegions 内的格子不积雪", () => {
    const rule = EnvironmentRuleSchema.parse({
      seed: 1,
      weatherSlotTicks: 10,
      phases: [{ id: "cold", durationTicks: 100 }],
      groundOverrides: [
        { phaseId: "cold", fromSemantic: 3, toSemantic: 10, excludeRegions: ["peak"] },
      ],
    });
    const geometry = createGeometry({
      ground: 3,
      regionOf: (x) => (x < 4 ? 0 : 1), // 左 meadow / 右 peak
    });
    const world = createWorld(geometry, rule);
    world.time.tick = 10;
    expect(effectiveGroundAt(world, 0, 0)).toBe(10);
    expect(effectiveGroundAt(world, 7, 0)).toBe(3);
  });

  it("regions 白名单只作用于列出的区域", () => {
    const rule = EnvironmentRuleSchema.parse({
      seed: 1,
      weatherSlotTicks: 10,
      phases: [{ id: "cold", durationTicks: 100 }],
      groundOverrides: [
        { phaseId: "cold", fromSemantic: 3, toSemantic: 10, regions: ["peak"] },
      ],
    });
    const geometry = createGeometry({ ground: 3, regionOf: (x) => (x < 4 ? 0 : 1) });
    const world = createWorld(geometry, rule);
    world.time.tick = 10;
    expect(effectiveGroundAt(world, 0, 0)).toBe(3);
    expect(effectiveGroundAt(world, 7, 0)).toBe(10);
  });

  it("像素坐标按 tile 尺寸换算；未知地图/越界返回 0", () => {
    const world = createWorld(createGeometry({ ground: 3 }), RULE);
    world.time.tick = 90; // 全格雪
    expect(effectiveGroundAtPixel(world, 16 * 2 + 5, 16 * 3 + 7)).toBe(10);
    expect(effectiveGroundAt(world, 0, 0, "missing-map")).toBe(0);
    expect(effectiveGroundAtPixel(world, -1, 0)).toBe(0);
  });
});

describe("⑥ 纯函数确定性 / 链式规则", () => {
  it("deriveEffectiveGround 同输入恒同输出（与 world 状态无关）", () => {
    const query = { x: 2, y: 5, baseSemantic: 3, level: 1, region: "meadow" };
    const a = deriveEffectiveGround(RULE, 60, query);
    const b = deriveEffectiveGround(RULE, 60, query);
    expect(a).toEqual(b);
    expect(a).toMatchObject({ baseSemantic: 3, phaseId: "cold" });
    expect(a.semantic).toBe(10);
  });

  it("数组顺序即链式顺序：后一条以前一条输出为输入", () => {
    const rule = EnvironmentRuleSchema.parse({
      seed: 3,
      weatherSlotTicks: 10,
      phases: [{ id: "cold", durationTicks: 100 }],
      groundOverrides: [
        { phaseId: "cold", fromSemantic: 3, toSemantic: 10 },
        { phaseId: "cold", fromSemantic: 10, toSemantic: 11 },
      ],
    });
    const view = deriveEffectiveGround(rule, 0, {
      x: 0,
      y: 0,
      baseSemantic: 3,
      level: 0,
    });
    expect(view.semantic).toBe(11);
    expect(view.applied).toEqual([0, 1]);
  });
});
