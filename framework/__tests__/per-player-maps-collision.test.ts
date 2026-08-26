/**
 * 分图（per-player maps）碰撞系统测试（per-player-maps 计划 todo 6）。
 *
 * 覆盖：
 * - 两地图各一道墙 + 一个玩家：每个玩家只被本图墙阻挡（不同图墙位置不同）。
 * - 同图碰撞回归：两个玩家同一张地图仍正常分离。
 * - 跨图隔离核心断言：同一坐标、不同地图的两个实体绝不互撞（位置不变 / 无人被推）。
 * - prewarm：新激活地图的碰撞运行时当 tick 即存在，且碰撞体当 tick 生效。
 *
 * 测试地图为手工构建的确定性 MapRuntime（blocked 网格显式声明墙 tile），
 * 与 maplifecycle 的生成图 helper 互补：本测试聚焦碰撞分区正确性，不依赖随机种子。
 */
import { describe, it, expect, beforeAll } from "vitest";
import { addComponent, addEntity } from "bitecs";
import {
  bootstrapFramework,
  createGameInstance,
  createDefaultGameDefinition,
  movePlayerToMap,
} from "framework/index";
import { Transform } from "framework/components/transform";
import { Velocity, Collider, ColliderShape } from "framework/components/physics";
import { EntityMap } from "framework/components/entityMap";
import { collisionSystem, prewarmCollisionRuntime } from "framework/systems/core/collisionSystem";
import { movementSystem } from "framework/systems/core/movementSystem";
import type { MapRuntime } from "framework/map/types";
import type { GameWorld } from "framework/world";

beforeAll(() => {
  // 全局引导一次：注册表是幂等单例，所有用例共享同一套内置实现
  bootstrapFramework();
});

/** 构造一个最小世界（默认配置，无地图配置兜底路径）。 */
function createBareWorld(): GameWorld {
  return createGameInstance(createDefaultGameDefinition()).world;
}

/** 清空 EntityMap 模块级单例残留（AoS 数组跨 world 复用 eid，防跨用例串扰）。 */
function clearEntityMap(): void {
  for (let i = 0; i < EntityMap.length; i++) EntityMap[i] = undefined;
}

/**
 * 手工构建并注册一张确定性地图（8×8 tile，tile 16px；blocked 网格显式声明墙）。
 * 只写入 world.maps 缓存，不修改 activeMaps / defaultMapId / resolvedMapSources——
 * 地图激活由测试显式控制（setupTwoMapWorld 或 movePlayerToMap）。
 */
function buildMap(id: string, wallTiles: Array<{ x: number; y: number }>): MapRuntime {
  const blocked = new Uint8Array(64);
  for (const t of wallTiles) {
    blocked[t.y * 8 + t.x] = 1;
  }
  return {
    id,
    name: id,
    grid: { width: 8, height: 8, tileWidth: 16, tileHeight: 16 },
    blocked,
    spawns: { player: { x: 64, y: 64 }, npcs: [] },
    zones: [],
  };
}

/**
 * 建立两张确定性地图（a/b）的环境：
 * - a 激活 + 默认图，墙在 tile (2,4) → 体中心 x=40；
 * - b 未激活（仅缓存），墙在 tile (5,4) → 体中心 x=88。
 * resolvedMapSources 填好，保证 movePlayerToMap 的 ensureMapActive 可用。
 */
function setupTwoMapWorld(world: GameWorld): void {
  world.defaultMapId = "a";
  world.maps = {};
  world.activeMaps = new Set<string>(["a"]);
  world.gameDef.resolvedMapSources = {
    a: {
      kind: "generated", generatorId: "simple", id: "a", name: "a",
      seed: 1, width: 8, height: 8, tileWidth: 16, tileHeight: 16,
    },
    b: {
      kind: "generated", generatorId: "simple", id: "b", name: "b",
      seed: 2, width: 8, height: 8, tileWidth: 16, tileHeight: 16,
    },
  };
  world.maps["a"] = buildMap("a", [{ x: 2, y: 4 }]);
  world.maps["b"] = buildMap("b", [{ x: 5, y: 4 }]);
}

/** 手工构造玩家实体（Transform + Velocity + Box Collider，需挂齐全组件方可被碰撞系统处理）。 */
function spawnTestPlayer(world: GameWorld, x: number, y: number): number {
  const eid = addEntity(world);
  addComponent(world, eid, Transform);
  addComponent(world, eid, Velocity);
  addComponent(world, eid, Collider);
  Transform.x[eid] = x;
  Transform.y[eid] = y;
  Velocity.vx[eid] = 0;
  Velocity.vy[eid] = 0;
  Collider.shape[eid] = ColliderShape.Box;
  Collider.halfW[eid] = 8;
  Collider.halfH[eid] = 8;
  return eid;
}

/** 读碰撞运行时表（world.systemRuntimes["collision"] 存 Map<mapId, CollisionRuntime>）。 */
function collisionRuntimes(world: GameWorld): Map<string, unknown> | undefined {
  return world.systemRuntimes.get("collision") as Map<string, unknown> | undefined;
}

describe("collision per-map runtimes", () => {
  it("a) 两地图各一墙一玩家：每个玩家只被本图墙阻挡（同坐标、墙位不同）", () => {
    const world = createBareWorld();
    clearEntityMap();
    setupTwoMapWorld(world);

    // 两玩家同一坐标 (16,72)，归属各自地图；墙：a 在 x≈40、b 在 x≈88。
    const playerA = spawnTestPlayer(world, 16, 72);
    const playerB = spawnTestPlayer(world, 16, 72);
    EntityMap[playerA] = "a";
    EntityMap[playerB] = "b";

    Velocity.vx[playerA] = 300;
    Velocity.vx[playerB] = 300;
    world.time.dtMs = 50;

    for (let i = 0; i < 12; i++) {
      movementSystem(world);
      collisionSystem(world);
    }

    // A 被 a 图墙（中心 x=40，左缘 32）挡住：玩家右缘贴 32 → 中心 ≈24。
    expect(EntityMap[playerA]).toBe("a");
    expect(Transform.x[playerA]).toBeLessThanOrEqual(24.01);
    // B 未被 a 图墙挡住（a 图墙只在 a 的 runtime）——能稳定越过 x=40，被 b 图墙（左缘 80）挡在 72。
    expect(EntityMap[playerB]).toBe("b");
    expect(Transform.x[playerB]).toBeGreaterThan(40);
    expect(Transform.x[playerB]).toBeLessThanOrEqual(72.01);
    expect(Transform.y[playerA]).toBe(72);
    expect(Transform.y[playerB]).toBe(72);
  });

  it("b) 同图碰撞回归：同一张地图的两个玩家仍正常分离", () => {
    const world = createBareWorld();
    clearEntityMap();
    setupTwoMapWorld(world);

    // 同为 a 图、相距 20（半宽 8×2=16，未叠），推进一帧后重叠 → 应被分离到 ≥16。
    const pa = spawnTestPlayer(world, 40, 20);
    const pb = spawnTestPlayer(world, 60, 20);
    EntityMap[pa] = "a";
    EntityMap[pb] = "a";

    Velocity.vx[pa] = 100;
    world.time.dtMs = 50;
    movementSystem(world);
    collisionSystem(world);

    // 动态体互斥分离，坐标互不重叠（墙 tile (2,4) 在 y=72，不干扰 y=20 的玩家）。
    expect(Math.abs(Transform.x[pa] - Transform.x[pb])).toBeGreaterThanOrEqual(16);
  });

  it("c) 跨图隔离核心断言：同一坐标、不同地图的两个实体绝不互撞（位置不变）", () => {
    const world = createBareWorld();
    clearEntityMap();
    setupTwoMapWorld(world);

    // 完全同坐标 (64,64)。若同 runtime 必然重叠分离；分属不同图应完全不动。
    const pa = spawnTestPlayer(world, 64, 64);
    const pb = spawnTestPlayer(world, 64, 64);
    EntityMap[pa] = "a";
    EntityMap[pb] = "b";

    collisionSystem(world);
    collisionSystem(world);

    expect(EntityMap[pa]).toBe("a");
    expect(EntityMap[pb]).toBe("b");
    expect(Transform.x[pa]).toBe(64);
    expect(Transform.y[pa]).toBe(64);
    expect(Transform.x[pb]).toBe(64);
    expect(Transform.y[pb]).toBe(64);
  });

  it("d) prewarm：新激活地图的碰撞运行时当 tick 即存在，且碰撞体当 tick 生效", () => {
    const world = createBareWorld();
    clearEntityMap();
    setupTwoMapWorld(world);

    // b 图此时未激活（world.activeMaps 只含 a），玩家先在 a 图。
    const player = spawnTestPlayer(world, 64, 64);
    EntityMap[player] = "a";

    // movePlayerToMap 激活 b 图并预暖 b 的碰撞运行时（prewarmCollisionRuntime）。
    expect(movePlayerToMap(world, player, "b", { x: 16, y: 72 })).toBe(true);
    expect(EntityMap[player]).toBe("b");
    expect(world.activeMaps.has("b")).toBe(true);

    // 预暖保证：b 图的碰撞运行时在 movePlayerToMap 返回后即存在（无需等碰撞 tick 惰性创建）。
    expect(collisionRuntimes(world)?.has("b")).toBe(true);

    // 同 tick 语义：玩家当 tick 进入 b 图即被 b 图墙（中心 x=88，左缘 80）挡住。
    Velocity.vx[player] = 300;
    world.time.dtMs = 50;
    for (let i = 0; i < 12; i++) {
      movementSystem(world);
      collisionSystem(world);
    }
    expect(Transform.x[player]).toBeGreaterThan(40); // 越过了 a 图墙位置（b 图无此墙）
    expect(Transform.x[player]).toBeLessThanOrEqual(72.01); // 被 b 图墙挡住
    expect(Transform.y[player]).toBe(72);
  });

  it("prewarmCollisionRuntime 幂等：已存在运行时 no-op", () => {
    const world = createBareWorld();
    clearEntityMap();
    setupTwoMapWorld(world);
    prewarmCollisionRuntime(world, "a");
    const first = collisionRuntimes(world)?.get("a");
    // 二次调用不重建（同一运行时对象）。
    prewarmCollisionRuntime(world, "a");
    expect(collisionRuntimes(world)?.get("a")).toBe(first);
  });
});
