/**
 * 跨层移动 + 按层碰撞 + 单向边缘测试（v2 地图切片 5）。
 *
 * 覆盖（验证清单 ①-⑧）：
 * ① 同层移动零回归：flat 图（level 全 0）墙格阻挡、层号恒 0 不落条目；
 * ② slope 跨层：实体沿坡道格 L0→L1，EntityLevel 同步变化、坐标连续不瞬移；
 *    ±1 过渡必须经 slope 语义格（无坡道标记的同层差不过渡）；
 * ③ cliff 单向：高→低跨崖边界允许（跳下）；低→高被阻挡（层号不变、位置被挡）；
 * ④ 滞回：在坡道格边界反复小幅移动不产生 level 振荡（格中心越过判定）；
 * ⑤ 按层碰撞：异层实体同坐标互不分离；同格崖体在高层视角不存在、低层视角存在
 *    （每层一个碰撞世界；静态体合并语义见 ⑧）；
 * ⑥ 投射物锁单层：异层目标不构成接触（不命中），同层命中回归；
 * ⑦ 确定性：同输入序列重复跑，实体轨迹与层号序列一致（(位置, 地图数据) 纯函数）；
 * ⑧ 静态体行游程合并：覆盖格集合与逐格阻挡完全等价（属性测试）+ 整行并成单 box。
 *
 * 几何全部为手工确定性 MapGeometry（tile 16px），不依赖随机种子；
 * 像素↔格换算按格中心 (k+0.5)·16 手算，断言坐标均为精确推导值。
 */
import { createRequire } from "node:module";
import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { addComponent, addEntity } from "bitecs";

const require = createRequire(import.meta.url);
const check2d = require("check2d") as typeof import("check2d");

import {
  bootstrapFramework,
  createGameInstance,
  createDefaultGameDefinition,
} from "framework/index";
import { Transform } from "framework/components/transform";
import { Velocity, Collider, ColliderShape } from "framework/components/physics";
import { NetworkId } from "framework/components/network";
import { EntityMap } from "framework/components/entityMap";
import { EntityLevel, entityLevelOf } from "framework/components/entityLevel";
import { makeTestGeometry } from "./helpers/mapGeometry";
import type { MapGeometry } from "map/geometry/types";
import { entityLevelSystem, resolveEntityLevel, effectiveTileIndex } from "framework/systems/core/entityLevelSystem";
import { collisionSystem, buildLevelMapBodies } from "framework/systems/core/collisionSystem";
import { movementSystem } from "framework/systems/core/movementSystem";
import { projectileSystem, spawnProjectile } from "framework/systems/gameplay/projectileSystem";
import { drainEvents } from "framework/simulation/events/eventBus";
import { computeInterest } from "framework/simulation/interest";
import { createRng } from "map/generate/rng";
import type { GameWorld } from "framework/world";

/** 提取 check2d 静态体的几何字段（body 携带树/包围盒等内部结构，不可整体比对）。 */
function boxOf(body: unknown): { x: number; y: number; width: number; height: number } {
  const b = body as { x: number; y: number; width: number; height: number };
  return { x: b.x, y: b.y, width: b.width, height: b.height };
}

beforeAll(() => {
  bootstrapFramework();
});

/** AoS 模块级单例清残留（EntityMap/EntityLevel 跨 world 复用 eid，防跨用例串扰）。 */
beforeEach(() => {
  for (let i = 0; i < EntityMap.length; i++) EntityMap[i] = undefined;
  for (let i = 0; i < EntityLevel.length; i++) EntityLevel[i] = undefined;
});

/** 构造一个最小世界（默认配置——系统链含 entity-level）。 */
function createBareWorld(): GameWorld {
  return createGameInstance(createDefaultGameDefinition()).world;
}

/** 手工构造玩家/实体（Transform + Velocity + Box Collider 16×16）。 */
function spawnTestEntity(world: GameWorld, x: number, y: number, mapId: string): number {
  const eid = addEntity(world);
  addComponent(world, eid, Transform);
  addComponent(world, eid, Velocity);
  addComponent(world, eid, Collider);
  addComponent(world, eid, NetworkId);
  Transform.x[eid] = x;
  Transform.y[eid] = y;
  Velocity.vx[eid] = 0;
  Velocity.vy[eid] = 0;
  Collider.shape[eid] = ColliderShape.Box;
  Collider.halfW[eid] = 8;
  Collider.halfH[eid] = 8;
  NetworkId.value[eid] = world.nextNetworkId++;
  EntityMap[eid] = mapId;
  return eid;
}

/**
 * 坡道图（12×8，tile 16）：行 0-3 为 L0、行 4-7 为 L1；行 3/4 标 slope 语义 7
 * （可走）。quantize-terrain 的边界带两侧同标形态。
 */
function makeSlopeMap(): MapGeometry {
  return makeTestGeometry({
    key: "lvl-slope",
    width: 12,
    height: 8,
    tiles: (_tx, ty) => (ty === 3 || ty === 4 ? 7 : 0),
    levels: (_tx, ty) => (ty >= 4 ? 1 : 0),
    levelSemantics: { slope: 7, cliff: 8 },
  });
}

/**
 * 崖图（12×8，tile 16）：列 0-4 为 L2 高台、列 5（L2）/列 6（L0）为 cliff 带
 * （语义 8、不可走）、列 7-11 为 L0 地面。quantize-terrain 的 |Δ|≥2 边界形态。
 */
function makeCliffMap(): MapGeometry {
  return makeTestGeometry({
    key: "lvl-cliff",
    width: 12,
    height: 8,
    tiles: (tx) => (tx === 5 || tx === 6 ? 8 : 0),
    levels: (tx) => (tx <= 5 ? 2 : 0),
    blocked: (tx) => tx === 5 || tx === 6,
    levelSemantics: { slope: 7, cliff: 8 },
  });
}

/** 跑一帧「移动 → 层号 → 碰撞」核心链（dt=50ms）。 */
function stepCore(world: GameWorld): void {
  world.time.tick += 1;
  world.time.dtMs = 50;
  movementSystem(world);
  entityLevelSystem(world);
  collisionSystem(world);
}

// —— ① 同层移动零回归 ————————————————————————————————
describe("① flat 图同层移动零回归", () => {
  it("墙格阻挡照旧；层号恒 0（确立条目为 0，无跨层行为）", () => {
    const world = createBareWorld();
    world.maps["flat"] = makeTestGeometry({
      key: "flat",
      width: 8,
      height: 8,
      blocked: (tx) => tx === 5, // 墙列 x=5（[80,96) 像素）
    });
    world.activeMaps.add("flat");
    world.defaultMapId = "flat";

    const player = spawnTestEntity(world, 16, 72, "flat");
    Velocity.vx[player] = 300;
    for (let i = 0; i < 12; i++) stepCore(world);

    // 被墙挡住（box 右缘贴墙左缘 80 → 中心 ≈72.01），且从未升层
    expect(Transform.x[player]).toBeLessThanOrEqual(72.01);
    expect(Transform.x[player]).toBeGreaterThan(40);
    expect(entityLevelOf(player)).toBe(0);
    expect(EntityLevel[player]).toBe(0); // 确立条目（0 层是普通取值，EntityMap 同款语义）
  });
});

// —— ② slope 跨层 ——————————————————————————————————
describe("② slope 跨层（±1 过渡须经坡道格）", () => {
  it("纯函数：格中心越过才切换层号；无坡道标记的 ±1 层差拒绝过渡", () => {
    const slope = makeSlopeMap();
    // 行 3 中心 y=56、行 4 中心 y=72：上行在越过行 4 中心（y=72）时 0→1
    expect(resolveEntityLevel(slope, 88, 71.9, 0)).toBe(0);
    expect(resolveEntityLevel(slope, 88, 72.1, 0)).toBe(1);
    // 下行在越过行 4 中心（y=72）时 1→0
    expect(resolveEntityLevel(slope, 88, 71.9, 1)).toBe(0);
    expect(resolveEntityLevel(slope, 88, 80, 1)).toBe(1);

    // 同几何去掉坡道标记：±1 层差无 slope 语义格 → 拒绝过渡（保持当前层）
    const bare = makeTestGeometry({
      key: "lvl-bare",
      width: 12,
      height: 8,
      levels: (_tx, ty) => (ty >= 4 ? 1 : 0),
      levelSemantics: { slope: 7, cliff: 8 },
    });
    expect(resolveEntityLevel(bare, 88, 72.1, 0)).toBe(0);
    expect(resolveEntityLevel(bare, 88, 96, 0)).toBe(0);
    // levelSemantics 缺失（flat 图）同理拒绝
    const noSem = makeTestGeometry({ key: "lvl-nosem", width: 4, height: 4, levels: (tx) => (tx >= 2 ? 1 : 0) });
    expect(resolveEntityLevel(noSem, 40, 8, 0)).toBe(0);
  });

  it("集成：实体沿坡道行走 L0→L1，EntityLevel 同步变化且坐标连续（不瞬移）", () => {
    const world = createBareWorld();
    world.maps["lvl-slope"] = makeSlopeMap();
    world.activeMaps.add("lvl-slope");
    world.defaultMapId = "lvl-slope";

    const player = spawnTestEntity(world, 84, 40, "lvl-slope"); // 行 2（L0）
    Velocity.vy[player] = 64; // 3.2 px/tick 下行
    const levels: number[] = [];
    const ys: number[] = [];
    for (let i = 0; i < 18; i++) {
      stepCore(world);
      levels.push(entityLevelOf(player));
      ys.push(Transform.y[player]);
    }

    // 恰好一次 0→1 转移（越过行 4 中心 y=72 之后）
    const firstOne = levels.indexOf(1);
    expect(firstOne).toBeGreaterThan(0);
    expect(levels.slice(0, firstOne).every((l) => l === 0)).toBe(true);
    expect(levels.slice(firstOne).every((l) => l === 1)).toBe(true);
    // 转移瞬间不瞬移：y 单调递增且每帧步进恒 3.2（64 px/s × 50ms；Float32 累积误差放宽到 1e-4）
    for (let i = 1; i < ys.length; i++) {
      expect(ys[i] - ys[i - 1]).toBeCloseTo(3.2, 4);
    }
    expect(ys[ys.length - 1]).toBeGreaterThan(72); // 已越过切换点
  });
});

// —— ③ cliff 单向 ——————————————————————————————————
describe("③ cliff 单向（高→低跳下允许、低→高禁止）", () => {
  it("高台实体向低地行走：越过崖带（高层视角崖格可越）落到 L0", () => {
    const world = createBareWorld();
    world.maps["lvl-cliff"] = makeCliffMap();
    world.activeMaps.add("lvl-cliff");
    world.defaultMapId = "lvl-cliff";

    const player = spawnTestEntity(world, 72, 64, "lvl-cliff"); // 列 4（L2 高台）
    stepCore(world);
    expect(entityLevelOf(player)).toBe(2); // 高台起步即 L2

    Velocity.vx[player] = 40; // 2 px/tick 向右（跨列 5/6 崖带）
    for (let i = 0; i < 30; i++) stepCore(world);

    expect(Transform.x[player]).toBeGreaterThan(112); // 已越过崖带落到低地
    expect(entityLevelOf(player)).toBe(0); // 跳下生效：L2 → L0
  });

  it("低地实体推向高台：位置被高层崖格挡住、层号保持 L0", () => {
    const world = createBareWorld();
    world.maps["lvl-cliff"] = makeCliffMap();
    world.activeMaps.add("lvl-cliff");
    world.defaultMapId = "lvl-cliff";

    const player = spawnTestEntity(world, 136, 64, "lvl-cliff"); // 列 8（L0 地面）
    stepCore(world);
    expect(entityLevelOf(player)).toBe(0);

    Velocity.vx[player] = -40; // 向左推向崖带
    for (let i = 0; i < 40; i++) stepCore(world);

    // 被列 5（L2 崖格）的静态体挡在低地一侧（中心 ≈104，box 贴 [80,96) 崖体右缘）
    expect(Transform.x[player]).toBeGreaterThanOrEqual(103.5);
    expect(Transform.x[player]).toBeLessThan(112);
    expect(entityLevelOf(player)).toBe(0); // 低→高禁止：层号不变
  });
});

// —— ④ 滞回 ————————————————————————————————————
describe("④ 滞回（格中心越过判定，边界抖动不振荡）", () => {
  it("在坡道格边界（行 3/4 交界 y=64）反复小幅移动，层号恒定不翻转", () => {
    const world = createBareWorld();
    world.maps["lvl-slope"] = makeSlopeMap();
    world.activeMaps.add("lvl-slope");
    world.defaultMapId = "lvl-slope";

    // 从 L0 一侧停在边界附近（y=60：有效格 3 → L0），来回抖动 ±4px 不越过任何格中心
    const player = spawnTestEntity(world, 84, 60, "lvl-slope");
    stepCore(world);
    expect(entityLevelOf(player)).toBe(0);

    const seen: number[] = [];
    for (let i = 0; i < 24; i++) {
      Velocity.vy[player] = i % 2 === 0 ? 160 : -160; // 每帧 ±8px 沿边界抖动
      stepCore(world);
      seen.push(entityLevelOf(player));
    }
    expect(new Set(seen)).toEqual(new Set([0])); // 全程 L0，无振荡

    // 对偶：从 L1 一侧停在边界上方（y=68：有效格 3 → 仍 L0；再进入行 4 前半格不动层号）
    const upper = spawnTestEntity(world, 100, 76, "lvl-slope"); // 行 4 中心附近（L1）
    stepCore(world);
    expect(entityLevelOf(upper)).toBe(1);
    for (let i = 0; i < 24; i++) {
      Velocity.vy[upper] = i % 2 === 0 ? -160 : 160; // 沿 y=72 中心附近抖动 ±8px
      stepCore(world);
    }
    // 抖动跨过行 4 中心（y=72）会按判定切换——但幅度受限时不越过相邻中心（56/88），
    // 层号只可能在 {0,1} 内且逐帧确定；断言不产生 2 层以上的错误跳变
    expect(entityLevelOf(upper)).toBeLessThanOrEqual(1);
  });

  it("有效格查找（滞回基元）：边界两侧±半格内不切换有效格", () => {
    // 行 3（[48,64)）与行 4（[64,80)）交界 y=64：有效格在两侧半格内恒为 3
    expect(effectiveTileIndex(60, 16, 8)).toBe(3);
    expect(effectiveTileIndex(64, 16, 8)).toBe(3);
    expect(effectiveTileIndex(68, 16, 8)).toBe(3);
    // 越过行 4 中心（y=72）才切到 4
    expect(effectiveTileIndex(71.9, 16, 8)).toBe(3);
    expect(effectiveTileIndex(72.1, 16, 8)).toBe(4);
    // 地图边缘半格退回包含格（有效格恒有定义）
    expect(effectiveTileIndex(0, 16, 8)).toBe(0);
    expect(effectiveTileIndex(4, 16, 8)).toBe(0);
  });
});

// —— ⑤ 按层碰撞 ——————————————————————————————————
describe("⑤ 按层碰撞（每层一个碰撞世界）", () => {
  it("异层实体同坐标互不分离；同层实体照常分离（回归）", () => {
    const world = createBareWorld();
    world.maps["lvl-cliff"] = makeCliffMap();
    world.activeMaps.add("lvl-cliff");
    world.defaultMapId = "lvl-cliff";

    // 高层（L2）与低层（L0）实体完全同坐标：不同碰撞世界 → 互不干扰
    const high = spawnTestEntity(world, 136, 64, "lvl-cliff");
    const low = spawnTestEntity(world, 136, 64, "lvl-cliff");
    EntityLevel[high] = 2;
    collisionSystem(world);
    collisionSystem(world);
    expect(Transform.x[high]).toBe(136);
    expect(Transform.y[high]).toBe(64);
    expect(Transform.x[low]).toBe(136);
    expect(Transform.y[low]).toBe(64);

    // 同层（同 L0）对照：同坐标必然被分离
    const a = spawnTestEntity(world, 136, 120, "lvl-cliff");
    const b = spawnTestEntity(world, 136, 120, "lvl-cliff");
    collisionSystem(world);
    expect(Math.hypot(Transform.x[a] - Transform.x[b], Transform.y[a] - Transform.y[b])).toBeGreaterThanOrEqual(15.9);
  });

  it("高层崖格的静态体只存在于低层世界：L2 视角无崖体、L0 视角有", () => {
    const world = createBareWorld();
    world.maps["lvl-cliff"] = makeCliffMap();
    world.activeMaps.add("lvl-cliff");

    collisionSystem(world); // 触发各层运行时构建

    const byMap = world.systemRuntimes.get("collision") as Map<string, Map<number, { mapBodies: Array<{ x: number; width: number; y: number }> }>>;
    const byLevel = byMap.get("lvl-cliff")!;
    // L2 世界：崖带（列 5/6）在 L2 视角下单向可越 → 无任何静态体
    expect(byLevel.get(2)!.mapBodies).toEqual([]);
    // L0 世界：列 5（L2 崩格，高于 L0）每行一个 16×16 体；列 6（L0 崖格）可越无体
    const l0Bodies = byLevel.get(0)!.mapBodies;
    expect(l0Bodies.length).toBe(8); // 8 行 × 单格游程
    for (const body of l0Bodies) {
      expect(body.x).toBe(80); // 列 5 左缘
      expect(body.width).toBe(16);
    }
    // 运行时表按 (mapId, level) 两级键分区
    expect([...byLevel.keys()].sort()).toEqual([0, 2]);
  });
});

// —— ⑥ 投射物锁单层 —————————————————————————————————
describe("⑥ 投射物锁单层", () => {
  it("异层目标不构成接触（穿越不命中）；同层目标命中（回归）", () => {
    // 异层：主人 L0 在低地发射，目标位于弹道上但层号 L1 → 不命中
    const world = createBareWorld();
    world.maps["lvl-slope"] = makeSlopeMap();
    world.activeMaps.add("lvl-slope");
    world.defaultMapId = "lvl-slope";

    const owner = spawnTestEntity(world, 84, 40, "lvl-slope");
    const target = spawnTestEntity(world, 84, 120, "lvl-slope");
    EntityLevel[target] = 1; // 目标在高层（弹道同列）

    const proj = spawnProjectile(world, owner, 84, 40, 0, 200, 5000, 4);
    expect(entityLevelOf(proj)).toBe(0); // 生成时锁定主人层号
    for (let i = 0; i < 12; i++) projectileSystem(world);

    const cross = drainEvents(world).filter((e) => e.name === "on-contact");
    expect(cross).toEqual([]); // 异层不命中
    expect(EntityLevel[target]).toBe(1);
    expect(Transform.x[target]).toBe(84);

    // 同层对照：目标 L0 → 命中发事件并销毁投射物
    for (let i = 0; i < EntityLevel.length; i++) EntityLevel[i] = undefined;
    const world2 = createBareWorld();
    world2.maps["lvl-slope"] = makeSlopeMap();
    world2.activeMaps.add("lvl-slope");
    world2.defaultMapId = "lvl-slope";
    const owner2 = spawnTestEntity(world2, 84, 40, "lvl-slope");
    const target2 = spawnTestEntity(world2, 84, 120, "lvl-slope");
    const proj2 = spawnProjectile(world2, owner2, 84, 40, 0, 200, 5000, 4);
    for (let i = 0; i < 12; i++) projectileSystem(world2);
    const hits = drainEvents(world2).filter((e) => e.name === "on-contact");
    expect(hits.length).toBe(1);
    expect((hits[0].payload as { target: number }).target).toBe(target2);
    expect(entityLevelOf(proj2)).toBe(0);
  });
});

// —— ⑦ 确定性 ————————————————————————————————————
describe("⑦ 确定性（同输入序列 → 同轨迹同层号序列）", () => {
  it("重复跑两遍，位置与层号轨迹完全一致", () => {
    const run = (): Array<{ x: number; y: number; level: number }> => {
      const world = createBareWorld();
      world.maps["lvl-slope"] = makeSlopeMap();
      world.activeMaps.add("lvl-slope");
      world.defaultMapId = "lvl-slope";
      const player = spawnTestEntity(world, 84, 40, "lvl-slope");
      const trace: Array<{ x: number; y: number; level: number }> = [];
      for (let i = 0; i < 48; i++) {
        // 确定性输入序列（无随机源）：净漂移下行穿越坡道带（y 峰值 >72 切换点），
        // 后段净漂移折返（回穿到 L0）
        Velocity.vx[player] = ((i % 4) - 1.5) * 40;
        Velocity.vy[player] = i < 20 ? (i % 2 === 0 ? 160 : -80) : i % 2 === 0 ? -160 : 80;
        stepCore(world);
        trace.push({
          x: Transform.x[player],
          y: Transform.y[player],
          level: entityLevelOf(player),
        });
      }
      return trace;
    };

    const a = run();
    const b = run();
    expect(a).toEqual(b);
    // 路径确实发生过跨层（否则断言无意义）
    expect(new Set(a.map((t) => t.level)).size).toBeGreaterThan(1);
  });
});

// —— ⑧ 静态体行游程合并等价性 ——————————————————————————————
describe("⑧ 静态体行游程合并：阻挡语义与逐格等价", () => {
  it("属性测试：合并体的覆盖格集合 == 逐格阻挡集合（随机掩码 × 20）", () => {
    const rng = createRng(20261016);
    for (let trial = 0; trial < 20; trial++) {
      const width = 24;
      const height = 16;
      const mask = new Uint8Array(width * height);
      for (let i = 0; i < mask.length; i++) mask[i] = rng.next() < 0.35 ? 1 : 0;
      const geometry = makeTestGeometry({
        key: `merge-${trial}`,
        width,
        height,
        blocked: (tx, ty) => mask[ty * width + tx] === 1,
      });

      const system = new check2d.System();
      const bodies = buildLevelMapBodies(system, geometry, 0);

      // 重栅格化合并体 → 覆盖格集合，与阻挡格集合全等
      const covered = new Set<number>();
      for (const body of bodies) {
        const box = body as unknown as { x: number; y: number; width: number; height: number };
        const x0 = Math.round(box.x / 16);
        const y0 = Math.round(box.y / 16);
        const x1 = Math.round((box.x + box.width) / 16);
        const y1 = Math.round((box.y + box.height) / 16);
        for (let cy = y0; cy < y1; cy++) {
          for (let cx = x0; cx < x1; cx++) covered.add(cy * width + cx);
        }
      }
      const expected = new Set<number>();
      for (let i = 0; i < mask.length; i++) if (mask[i] === 1) expected.add(i);
      expect([...covered].sort((p, q) => p - q)).toEqual([...expected].sort((p, q) => p - q));
      // 合并只减不增：体数 ≤ 阻挡格数
      expect(bodies.length).toBeLessThanOrEqual(expected.size);
    }
  });

  it("整行连续阻挡格合并为单个 box（128×16）；单格阻挡保持 16×16", () => {
    const row = makeTestGeometry({
      key: "merge-row",
      width: 8,
      height: 2,
      blocked: (tx, ty) => ty === 0, // 首行 8 格全阻挡
    });
    const system = new check2d.System();
    const bodies = buildLevelMapBodies(system, row, 0);
    expect(bodies.length).toBe(1);
    // 只比对几何字段（check2d body 携带树/包围盒等内部结构，不可整体比对）
    expect(boxOf(bodies[0])).toEqual({ x: 0, y: 0, width: 128, height: 16 });

    const single = makeTestGeometry({
      key: "merge-single",
      width: 8,
      height: 2,
      blocked: (tx, ty) => tx === 3 && ty === 1,
    });
    const singleBodies = buildLevelMapBodies(system, single, 0);
    expect(singleBodies.length).toBe(1);
    expect(boxOf(singleBodies[0])).toEqual({ x: 48, y: 16, width: 16, height: 16 });
  });
});

// —— 兴趣裁剪：同层全给（level 维度接线） ————————————————————————
describe("兴趣裁剪：同层全给（异层不可见，level 维度留出）", () => {
  it("同图异层实体不在可见集；同层可见；自身恒可见", () => {
    const world = createBareWorld();
    world.maps["lvl-slope"] = makeSlopeMap();
    world.activeMaps.add("lvl-slope");
    world.defaultMapId = "lvl-slope";

    const player = spawnTestEntity(world, 84, 40, "lvl-slope");
    EntityLevel[player] = 0;

    const sameLevel = spawnTestEntity(world, 100, 40, "lvl-slope");
    EntityLevel[sameLevel] = 0;

    const otherLevel = spawnTestEntity(world, 100, 40, "lvl-slope");
    EntityLevel[otherLevel] = 1;

    // 手工快照（buildSnapshot 的 level 字段同形态）
    const snapshot = {
      tick: 1,
      entities: new Map<number, { values: Record<string, number>; strings: Record<string, string>; mapId: string; level: number }>([
        [NetworkId.value[player], { values: { "Transform.x": 84, "Transform.y": 40 }, strings: {}, mapId: "lvl-slope", level: 0 }],
        [NetworkId.value[sameLevel], { values: { "Transform.x": 100, "Transform.y": 40 }, strings: {}, mapId: "lvl-slope", level: 0 }],
        [NetworkId.value[otherLevel], { values: { "Transform.x": 100, "Transform.y": 40 }, strings: {}, mapId: "lvl-slope", level: 1 }],
      ]),
      playerMaps: new Map<string, string>(),
    };

    const interest = computeInterest(world, new Map([["s1", player]]), snapshot as never);
    const visible = interest.get("s1")!;
    expect(visible).toContain(NetworkId.value[player]); // 自身恒可见
    expect(visible).toContain(NetworkId.value[sameLevel]); // 同层全给
    expect(visible).not.toContain(NetworkId.value[otherLevel]); // 异层不可见
  });
});
