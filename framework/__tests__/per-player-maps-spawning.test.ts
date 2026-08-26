/**
 * 分图（per-player maps）刷怪测试（per-player-maps 计划 todo 7）。
 *
 * 覆盖：
 * - 激活未激活地图：其规则开始按计时刷出，实体归属（EntityMap）该图。
 * - 常驻规则不依赖玩家在场：玩家离图后，已激活的空图仍按 respawnMs 持续刷。
 * - 无 mapId 的规则对所有激活地图各自生效（每 (mapId, rule) 独立计时）。
 * - countInZone 只统计同图实体：他图同 kind 实体不占本图 max 上限。
 *
 * 规则经 world.gameDef.resolvedSpawns 注入（与 slice4 刷怪用例同款路径）；
 * 地图经 attachTwoMaps + ensureMapActive 激活（simple 生成器内置 zone 1，
 * 两张图多边形同坐标——为「他图同 kind 计入」的回归提供等价区域）。
 */
import { describe, it, expect, beforeAll } from "vitest";
import { addComponent, addEntity, query } from "bitecs";
import {
  bootstrapFramework,
  createGameInstance,
  createDefaultGameDefinition,
  ensureMapActive,
  movePlayerToMap,
  getRegistries,
} from "framework/index";
import { Transform } from "framework/components/transform";
import { Velocity, Collider, ColliderShape } from "framework/components/physics";
import { Health, Team } from "framework/components/combat";
import { NetworkId } from "framework/components/network";
import { Player } from "framework/components/tags";
import { Inventory } from "framework/components/inventory";
import { Size } from "framework/components/size";
import { EntityMap } from "framework/components/entityMap";
import { Kind } from "framework/components/kind";
import { spawnEntity } from "framework/entities/spawn";
import { spawningSystem } from "framework/systems/gameplay/spawningSystem";
import { setEntityKind } from "framework/systems/gameplay/aiSystem";
import type { GameWorld } from "framework/world";

beforeAll(() => {
  // 全局引导一次：注册表是幂等单例，所有用例共享同一套内置实现
  bootstrapFramework();
});

/** 构造一个最小世界（默认配置，无地图配置兜底路径）。 */
function createBareWorld(): GameWorld {
  return createGameInstance(createDefaultGameDefinition()).world;
}

/** 注册测试原型（全局注册表单例，跨用例重复注册会抛错 → 已存在则跳过）。 */
function ensureArchetype(world: GameWorld, spec: Parameters<typeof world.archetypes.register>[0]): void {
  if (!world.archetypes.has(spec.kind)) {
    world.archetypes.register(spec);
  }
}

/** 挂两张生成图（a/b，各含 simple 生成器内置 zone 1）——与 slice6/maplifecycle 同款模式。 */
function attachTwoMaps(world: GameWorld): void {
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
}

/** 手工构造玩家实体（与 maplifecycle 同款；EntityMap 归属由用例显式写入）。 */
function spawnTestPlayer(world: GameWorld, opts: { x?: number; y?: number } = {}): number {
  const eid = addEntity(world);
  addComponent(world, eid, Transform);
  addComponent(world, eid, NetworkId);
  addComponent(world, eid, Player);
  addComponent(world, eid, Health);
  addComponent(world, eid, Team);
  addComponent(world, eid, Velocity);
  addComponent(world, eid, Collider);
  addComponent(world, eid, Size);
  Transform.x[eid] = opts.x ?? 0;
  Transform.y[eid] = opts.y ?? 0;
  Health.current[eid] = 100;
  Health.max[eid] = 100;
  Team.id[eid] = 1;
  Collider.shape[eid] = ColliderShape.Box;
  Collider.halfW[eid] = 8;
  Collider.halfH[eid] = 8;
  Size.w[eid] = 16;
  Size.h[eid] = 16;
  Inventory[eid] = {
    capacity: 4,
    slots: Array.from({ length: 4 }, () => null),
  };
  NetworkId.value[eid] = world.nextNetworkId++;
  setEntityKind(world, eid, "test-player");
  return eid;
}

/** 统计某图某 kind 实体数（EntityMap 归属过滤）。 */
function countInMap(world: GameWorld, kind: string, mapId: string): number {
  return query(world, [Transform]).filter((e) => Kind[e] === kind && EntityMap[e] === mapId).length;
}

/** 清空 EntityMap 模块级单例残留（AoS 数组跨 world 复用 eid，防跨用例串扰）。 */
function clearEntityMap(): void {
  for (let i = 0; i < EntityMap.length; i++) EntityMap[i] = undefined;
}

describe("spawning", () => {
  it("激活未激活地图：其规则开始计时刷出，实体归属该图", () => {
    const world = createBareWorld();
    clearEntityMap();
    attachTwoMaps(world);
    ensureArchetype(world, { kind: "sp1", components: {} });
    world.gameDef.resolvedSpawns = [
      { kind: "sp1", zoneId: 1, max: 5, respawnMs: 0, mapId: "b" },
    ];

    // 仅 a 激活：b 的规则不生效（不刷、不计时）
    ensureMapActive(world, "a");
    world.time.tick = 1;
    spawningSystem(world);
    expect(countInMap(world, "sp1", "b")).toBe(0);
    expect(countInMap(world, "sp1", "a")).toBe(0);

    // 激活 b：规则开始刷，实体全部归属该图
    ensureMapActive(world, "b");
    spawningSystem(world);
    expect(countInMap(world, "sp1", "b")).toBeGreaterThan(0);
    for (const eid of query(world, [Transform])) {
      if (Kind[eid] !== "sp1") continue;
      expect(EntityMap[eid]).toBe("b");
    }
  });

  it("常驻规则：玩家离图后，已激活空图仍按 respawnMs 持续刷", () => {
    const world = createBareWorld();
    clearEntityMap();
    attachTwoMaps(world);
    ensureArchetype(world, { kind: "sp2", components: {} });
    world.gameDef.resolvedSpawns = [
      { kind: "sp2", zoneId: 1, max: 10, respawnMs: 1000, mapId: "a" },
    ];
    ensureMapActive(world, "a");
    ensureMapActive(world, "b");

    const player = spawnTestPlayer(world, { x: 0, y: 0 });
    EntityMap[player] = "a";

    // t=50ms：首波立即刷（计时初始化为 -Infinity）
    world.time.tick = 1;
    spawningSystem(world);
    expect(countInMap(world, "sp2", "a")).toBe(1);

    // 唯一玩家离图 → a 图无玩家，但规则独立计时，仍然继续刷
    movePlayerToMap(world, player, "b");
    expect(EntityMap[player]).toBe("b");

    // t=1250ms：距上次刷 1200ms >= 1000ms → 再刷 1 只
    world.time.tick = 25;
    spawningSystem(world);
    expect(countInMap(world, "sp2", "a")).toBe(2);
  });

  it("无 mapId 规则对所有激活地图生效（每图独立刷出）", () => {
    const world = createBareWorld();
    clearEntityMap();
    attachTwoMaps(world);
    ensureArchetype(world, { kind: "sp3", components: {} });
    world.gameDef.resolvedSpawns = [
      { kind: "sp3", zoneId: 1, max: 10, respawnMs: 0 },
    ];
    ensureMapActive(world, "a");
    ensureMapActive(world, "b");

    // respawnMs 0：每 tick 每（图, 规则）刷 1 只——两 tick 后每图 2 只
    spawningSystem(world);
    spawningSystem(world);
    expect(countInMap(world, "sp3", "a")).toBe(2);
    expect(countInMap(world, "sp3", "b")).toBe(2);
  });

  it("countInZone 不统计他图同 kind 实体：max 上限按图独立", () => {
    const world = createBareWorld();
    clearEntityMap();
    attachTwoMaps(world);
    ensureArchetype(world, { kind: "sp4", components: {} });
    world.gameDef.resolvedSpawns = [
      { kind: "sp4", zoneId: 1, max: 2, respawnMs: 500, mapId: "a" },
    ];
    ensureMapActive(world, "a");
    ensureMapActive(world, "b");

    // b 图 zone 1（与 a 图 zone 多边形完全同坐标）内放 2 只同 kind 实体——b 图无该规则
    const { componentRegistry, archetypeRegistry } = getRegistries();
    for (let i = 0; i < 2; i++) {
      spawnEntity(world, archetypeRegistry.get("sp4"), componentRegistry, {
        x: 40,
        y: 40,
        mapId: "b",
      });
    }

    // a 图计数器只看 a 图实体：不被他图 2 只撑满，按 a 图 max=2 刷满
    world.time.tick = 1; // now=50ms → 首波立即刷
    spawningSystem(world);
    world.time.tick = 12; // now=600ms → 距上次 550ms >= 500ms → 第 2 只
    spawningSystem(world);
    world.time.tick = 23; // now=1150ms → 到窗口但 count=2 >= max → 不再刷
    spawningSystem(world);
    expect(countInMap(world, "sp4", "a")).toBe(2);
    // b 图的两只原地不动（未被计入、未被移动）
    expect(countInMap(world, "sp4", "b")).toBe(2);
  });
});
