/**
 * 玩法切片 D1：A* 寻路 + Chase/Flee 接线测试。
 *
 * 覆盖：绕行（L 形墙）、不可达回退直线、确定性、重算节流/目标格缓存、
 * 路径不穿墙（地形 + 建造墙）、同层 + built 楼板、跨层 slope、192×192
 * 节点上限与性能上界，以及配置 fail-fast。
 */
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { addComponent, addEntity } from "bitecs";
import { State } from "mistreevous";

import {
  bootstrapFramework,
  createActionRegistry,
  createDefaultGameDefinition,
  createGameInstance,
} from "framework/index";
import { Transform } from "framework/components/transform";
import { Velocity } from "framework/components/physics";
import { EntityMap } from "framework/components/entityMap";
import { EntityLevel } from "framework/components/entityLevel";
import {
  createBlackboard,
  bbSet,
  BB_PERCEPTION_TARGET,
} from "framework/ai/blackboard";
import { createBehaviourTree } from "framework/ai/btFactory";
import { stepBehaviourTree } from "framework/ai/btRunner";
import { registerBuiltinActions } from "framework/ai/registerBuiltinActions";
import { createChaseAction } from "framework/ai/nodes/actions/chase";
import {
  findPath,
  findPathWithStats,
  lineOfSightClear,
  type PathfindingBlockers,
} from "framework/ai/pathfinding/astar";
import {
  BB_NAV_CHASE,
  BB_NAV_FLEE,
  getNavigationRuntime,
} from "framework/ai/pathfinding/navigate";
import { walkableAtLevel } from "map/geometry/query";
import type { GameWorld } from "framework/world";
import { makeTestGeometry } from "./helpers/mapGeometry";

beforeAll(() => {
  bootstrapFramework();
});

beforeEach(() => {
  // AoS 模块级单例按 eid 索引，跨 world 复用——清残留防串扰
  for (let i = 0; i < EntityMap.length; i++) EntityMap[i] = undefined;
  for (let i = 0; i < EntityLevel.length; i++) EntityLevel[i] = undefined;
});

function createBareWorld(): GameWorld {
  return createGameInstance(createDefaultGameDefinition()).world;
}

function attachMap(world: GameWorld, key: string, geometry: ReturnType<typeof makeTestGeometry>): void {
  world.maps[key] = geometry;
  world.defaultMapId = key;
}

function spawnActor(
  world: GameWorld,
  mapId: string,
  x: number,
  y: number,
  level = 0,
): number {
  const eid = addEntity(world);
  addComponent(world, eid, Transform);
  addComponent(world, eid, Velocity);
  Transform.x[eid] = x;
  Transform.y[eid] = y;
  Velocity.vx[eid] = 0;
  Velocity.vy[eid] = 0;
  EntityMap[eid] = mapId;
  EntityLevel[eid] = level;
  return eid;
}

function makeTree(definition: Parameters<typeof createBehaviourTree>[0]) {
  const registry = createActionRegistry();
  registerBuiltinActions(registry);
  return createBehaviourTree(definition, registry);
}

/** L 形墙：竖墙 x=3,y≤3 + 横墙 y=3,x∈[3,7]（起点 (1,1) → 终点 (5,1) 必须绕行）。 */
function lWallGeometry() {
  return makeTestGeometry({
    width: 10,
    height: 10,
    blocked: (x, y) => (x === 3 && y <= 3) || (y === 3 && x >= 3 && x <= 7),
  });
}

describe("A* 寻路核心", () => {
  it("① 直线被 L 形墙挡住 → 绕行路径长度 > 直线且逐格可走", () => {
    const geometry = lWallGeometry();
    const start = { x: 1, y: 1, level: 0 };
    const goal = { x: 5, y: 1, level: 0 };
    const result = findPathWithStats(geometry, undefined, start, goal, { maxNodes: 4096 });

    expect(result.path).not.toBeNull();
    const path = result.path!;
    expect(path[0]).toEqual(start);
    expect(path[path.length - 1]).toEqual(goal);
    // 曼哈顿直线距离 = 4；绕行必然更长
    expect(path.length - 1).toBeGreaterThan(4);

    for (const tile of path) {
      expect(walkableAtLevel(geometry, tile.x, tile.y, tile.level)).toBe(true);
    }
    expect(lineOfSightClear(geometry, undefined, 24, 24, 88, 24, 0)).toBe(false);
  });

  it("③ 确定性：同输入两次路径逐元素相等、展开节点数相等", () => {
    const geometry = lWallGeometry();
    const start = { x: 1, y: 1, level: 0 };
    const goal = { x: 5, y: 1, level: 0 };
    const first = findPathWithStats(geometry, undefined, start, goal, { maxNodes: 4096 });
    const second = findPathWithStats(geometry, undefined, start, goal, { maxNodes: 4096 });

    expect(first.path).toEqual(second.path);
    expect(first.expandedNodes).toBe(second.expandedNodes);
  });

  it("⑤ 路径不穿建造墙（walkable 地形 + Structure wall 按层阻挡）", () => {
    const geometry = makeTestGeometry({ width: 5, height: 5 });
    const wallIndex = 2 * 5 + 2;
    const built: PathfindingBlockers = {
      floors: new Map(),
      walls: new Map([[0, new Set([wallIndex])]]),
      connectors: new Map(),
    };
    const start = { x: 1, y: 2, level: 0 };
    const goal = { x: 3, y: 2, level: 0 };

    const result = findPathWithStats(geometry, built, start, goal, { maxNodes: 256 });
    expect(result.path).not.toBeNull();
    const path = result.path!;
    expect(path.length).toBeGreaterThan(3);
    const wallTiles = built.walls!.get(0)!;
    for (const tile of path) {
      expect(wallTiles.has(tile.y * 5 + tile.x)).toBe(false);
    }
    expect(lineOfSightClear(geometry, built, 24, 40, 56, 40, 0)).toBe(false);
  });

  it("⑥ 同层寻路：built 楼板让不可走格参与通行（无楼板则不可达）", () => {
    const geometry = makeTestGeometry({
      width: 5,
      height: 5,
      blocked: (x) => x === 2,
    });
    const start = { x: 1, y: 2, level: 0 };
    const goal = { x: 3, y: 2, level: 0 };

    expect(findPath(geometry, undefined, start, goal, { maxNodes: 256 })).toBeNull();

    const bridge = 2 * 5 + 2;
    const built: PathfindingBlockers = {
      floors: new Map([[0, new Set([bridge])]]),
      walls: new Map(),
      connectors: new Map(),
    };
    const path = findPath(geometry, built, start, goal, { maxNodes: 256 });
    expect(path).not.toBeNull();
    expect(path).toHaveLength(3);
    expect(path![1]).toEqual({ x: 2, y: 2, level: 0 });
    for (const tile of path!) {
      expect(walkableAtLevel(geometry, tile.x, tile.y, tile.level, built)).toBe(true);
    }
  });

  it("⑥b 跨层：经 slope 语义格 0→1 可达；无 slope 则不可达（接口保留 level 维度）", () => {
    const slope = 7;
    const makeMap = (withSlope: boolean) =>
      makeTestGeometry({
        width: 8,
        height: 3,
        levels: (x) => (x < 4 ? 0 : 1),
        tiles: (x) => (withSlope && x === 4 ? slope : 0),
        levelSemantics: { slope, cliff: 8 },
      });

    const start = { x: 0, y: 1, level: 0 };
    const goal = { x: 6, y: 1, level: 1 };

    const withSlope = findPathWithStats(makeMap(true), undefined, start, goal, { maxNodes: 256 });
    expect(withSlope.path).not.toBeNull();
    expect(withSlope.path![withSlope.path!.length - 1]).toEqual(goal);
    expect(withSlope.path!.some((tile) => tile.level === 1)).toBe(true);

    expect(findPath(makeMap(false), undefined, start, goal, { maxNodes: 256 })).toBeNull();
  });

  it("⑥c 跨层：经上行连接器 0→1 可达（连接器语义与 entityLevelSystem 同源）", () => {
    const geometry = makeTestGeometry({ width: 6, height: 3 });
    const connectorIndex = 2 * 6 + 3;
    const built: PathfindingBlockers = {
      floors: new Map(),
      walls: new Map(),
      connectors: new Map([[connectorIndex, { low: 0, high: 1, dir: 0 }]]),
    };
    const path = findPath(
      geometry,
      built,
      { x: 1, y: 2, level: 0 },
      { x: 5, y: 2, level: 1 },
      { maxNodes: 256 },
    );
    expect(path).not.toBeNull();
    expect(path!.some((tile) => tile.x === 3 && tile.y === 2 && tile.level === 1)).toBe(true);
    expect(path![path!.length - 1]).toEqual({ x: 5, y: 2, level: 1 });
  });

  it("⑦ 192×192：节点上限内绕墙可达；小上限返回 null（可断言访问上界）", () => {
    const size = 192;
    const geometry = makeTestGeometry({
      width: size,
      height: size,
      // 竖墙 x=96 从顶到底（仅底行留缺口），迫使路径绕到底部
      blocked: (x, y) => x === 96 && y <= size - 2,
    });
    const start = { x: 5, y: 96, level: 0 };
    const goal = { x: 187, y: 96, level: 0 };

    const result = findPathWithStats(geometry, undefined, start, goal, { maxNodes: 40000 });
    expect(result.path).not.toBeNull();
    expect(result.expandedNodes).toBeLessThanOrEqual(40000);
    expect(result.path!.length).toBeGreaterThan(180);

    const capped = findPathWithStats(geometry, undefined, start, goal, { maxNodes: 200 });
    expect(capped.path).toBeNull();
    expect(capped.reason).toBe("limit");
    expect(capped.expandedNodes).toBeLessThanOrEqual(200);
  });
});

describe("Chase/Flee 寻路接线", () => {
  it("② 不可达目标：A* 失败 → 回退旧直线（保持移动、不卡死）", () => {
    // 目标被墙环完全围住：A* 不可达
    const geometry = makeTestGeometry({
      width: 10,
      height: 10,
      blocked: (x, y) =>
        x >= 4 && x <= 6 && y >= 4 && y <= 6 && !(x === 5 && y === 5),
    });
    const world = createBareWorld();
    attachMap(world, "arena", geometry);
    const self = spawnActor(world, "arena", 24, 24);
    const target = spawnActor(world, "arena", 88, 88);
    const inst = makeTree({ type: "root", child: { type: "action", call: "Chase", args: { speed: 10 } } });
    const bb = createBlackboard(self);
    bbSet(bb, BB_PERCEPTION_TARGET, { eid: target, dist: 90 });

    stepBehaviourTree(inst, { world, self, bb });
    expect(inst.tree.getState()).toBe(State.RUNNING);
    expect(Velocity.vx[self]).toBeGreaterThan(0);
    expect(Velocity.vy[self]).toBeGreaterThan(0);
    expect(Math.hypot(Velocity.vx[self], Velocity.vy[self])).toBeCloseTo(10, 5);

    const runtime = getNavigationRuntime(bb, BB_NAV_CHASE)!;
    expect(runtime.searches).toBe(1);
    expect(runtime.path).toHaveLength(0);
    expect(runtime.lastExpandedNodes).toBeGreaterThan(0);
  });

  it("④ 重算节流：间隔内不重复求路；目标格变化立即重算", () => {
    const geometry = makeTestGeometry({
      width: 14,
      height: 12,
      blocked: (x, y) => x === 6 && y <= 9,
    });
    const world = createBareWorld();
    world.gameDef.systems = [
      { id: "ai", config: { pathfinding: { repathTicks: 5, maxNodes: 2048 } } },
    ];
    attachMap(world, "throttle", geometry);
    const self = spawnActor(world, "throttle", 24, 88);
    const target = spawnActor(world, "throttle", 200, 88);
    const inst = makeTree({ type: "root", child: { type: "action", call: "Chase", args: { speed: 10 } } });
    const bb = createBlackboard(self);
    bbSet(bb, BB_PERCEPTION_TARGET, { eid: target, dist: 176 });

    world.time.tick = 1;
    stepBehaviourTree(inst, { world, self, bb });
    const runtime = getNavigationRuntime(bb, BB_NAV_CHASE)!;
    expect(runtime.searches).toBe(1);
    expect(runtime.nextRepathTick).toBe(6);

    for (const tick of [2, 3, 4, 5]) {
      world.time.tick = tick;
      stepBehaviourTree(inst, { world, self, bb });
      expect(runtime.searches).toBe(1); // 间隔内零 A* 调用
    }

    world.time.tick = 6;
    stepBehaviourTree(inst, { world, self, bb });
    expect(runtime.searches).toBe(2);

    // 目标格变化（即使间隔未到）→ 立即重算
    Transform.x[target] = 216;
    world.time.tick = 7;
    stepBehaviourTree(inst, { world, self, bb });
    expect(runtime.searches).toBe(3);
  });

  it("Flee 接线：背向方向被墙挡时沿 A* 路径绕行", () => {
    const geometry = makeTestGeometry({
      width: 12,
      height: 5,
      blocked: (x, y) => x === 9 && y >= 1 && y <= 3,
    });
    const world = createBareWorld();
    attachMap(world, "flee", geometry);
    const self = spawnActor(world, "flee", 104, 40); // tile (6,2)
    const target = spawnActor(world, "flee", 72, 40); // tile (4,2)
    const inst = makeTree({ type: "root", child: { type: "action", call: "Flee", args: { speed: 20 } } });
    const bb = createBlackboard(self);
    bbSet(bb, BB_PERCEPTION_TARGET, { eid: target, dist: 32 });

    stepBehaviourTree(inst, { world, self, bb });
    expect(inst.tree.getState()).toBe(State.RUNNING);
    expect(Velocity.vx[self]).toBeGreaterThan(0);

    const runtime = getNavigationRuntime(bb, BB_NAV_FLEE)!;
    expect(runtime.searches).toBe(1);
    // 路径确实绕开墙带（存在非 y=2 的 waypoint），而非直线穿过
    expect(runtime.path.some((tile) => tile.y !== 2)).toBe(true);
  });

  it("配置 fail-fast：非法节点参数在工厂创建期抛错；非法全局配置在首次使用抛错", () => {
    expect(() => createChaseAction({ pathfinding: { repathTicks: 0 } })).toThrow(/repathTicks/);
    expect(() => createChaseAction({ pathfinding: { maxNodes: 1.5 } })).toThrow(/maxNodes/);
    expect(() => createChaseAction({ pathfinding: { typo: 1 } })).toThrow(/unknown pathfinding option/);

    const geometry = makeTestGeometry({ width: 6, height: 6 });
    const world = createBareWorld();
    world.gameDef.systems = [
      { id: "ai", config: { pathfinding: { maxNodes: -1 } } },
    ];
    attachMap(world, "cfg", geometry);
    const self = spawnActor(world, "cfg", 16, 16);
    const target = spawnActor(world, "cfg", 80, 80);
    const inst = makeTree({ type: "root", child: { type: "action", call: "Chase" } });
    const bb = createBlackboard(self);
    bbSet(bb, BB_PERCEPTION_TARGET, { eid: target, dist: 90 });
    expect(() => stepBehaviourTree(inst, { world, self, bb })).toThrow(/maxNodes/);
  });
});
