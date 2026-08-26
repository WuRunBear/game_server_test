/**
 * 分图（per-player maps）portal 触发测试（per-player-maps 计划 todo 5）。
 *
 * 覆盖：
 * - 同图相交才触发：触发者 EntityMap/Transform 变化，另一玩家 EntityMap/Transform 不变。
 * - 两 portal × 两玩家同 tick 各自触发（无早退——旧房间级实现只触发一次即 return）。
 * - 同图不相交不触发（无移动、无地图激活）。
 * - 目标图无效（movePlayerToMap 返回 false）不移动，他人不受影响。
 * - 同一玩家重叠两个 portal 同 tick 只移动一次（迭代序第一个 portal 胜出）。
 *
 * 手工构造实体（不经 spawnEntity——非本切片职责），helper 与
 * per-player-maps-maplifecycle.test.ts 同款；portal 为 AoS 组件，直接写入
 * Portal[eid]（T3 注：spawn 链归属未落地前须手工设置 EntityMap，测试用
 * 于跨图判定的实体现均已显式设置）。
 */
import { describe, it, expect, beforeAll } from "vitest";
import { addComponent, addEntity } from "bitecs";
import {
  bootstrapFramework,
  createGameInstance,
  createDefaultGameDefinition,
} from "framework/index";
import { Transform } from "framework/components/transform";
import { Velocity, Collider, ColliderShape } from "framework/components/physics";
import { Health, Team } from "framework/components/combat";
import { NetworkId } from "framework/components/network";
import { Player } from "framework/components/tags";
import { Inventory } from "framework/components/inventory";
import { Size } from "framework/components/size";
import { EntityMap } from "framework/components/entityMap";
import { Portal } from "framework/components/portal";
import { setEntityKind } from "framework/systems/gameplay/aiSystem";
import { portalSystem } from "framework/systems/gameplay/portalSystem";
import type { GameWorld } from "framework/world";

beforeAll(() => {
  // 全局引导一次：注册表是幂等单例，所有用例共享同一套内置实现
  bootstrapFramework();
});

/** 构造一个最小世界（默认配置，无地图配置兜底路径）。 */
function createBareWorld(): GameWorld {
  return createGameInstance(createDefaultGameDefinition()).world;
}

/**
 * 挂三张生成图（a/b/c）：a 带 2 个 NPC 出生点（与本切片 helper 同款），b/c 无 NPC。
 * 种子经校验不阻塞出生格（seed 1/2 与 slice6 「挂两张生成图」helper 相同）。
 */
function attachTestMaps(world: GameWorld): void {
  world.gameDef.resolvedMapSources = {
    a: {
      kind: "generated", generatorId: "simple", id: "a", name: "a",
      seed: 1, width: 8, height: 8, tileWidth: 16, tileHeight: 16,
      npcSpawns: [
        { kind: "npc1", offsetTiles: [1, 0] },
        { kind: "npc1", offsetTiles: [0, 1] },
      ],
    },
    b: {
      kind: "generated", generatorId: "simple", id: "b", name: "b",
      seed: 2, width: 8, height: 8, tileWidth: 16, tileHeight: 16,
    },
    c: {
      kind: "generated", generatorId: "simple", id: "c", name: "c",
      seed: 2, width: 8, height: 8, tileWidth: 16, tileHeight: 16,
    },
  };
}

/** 手工构造玩家实体（不经 spawnEntity——非本切片职责，写入组件与 slice6 同款）。 */
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

/** 手工构造 portal 实体（Transform+Size bitecs 组件 + Portal AoS 写入 + 显式 EntityMap）。 */
function spawnTestPortal(
  world: GameWorld,
  opts: { x: number; y: number; targetMap: string; destX: number; destY: number; mapId: string },
): number {
  const eid = addEntity(world);
  addComponent(world, eid, Transform);
  addComponent(world, eid, Size);
  Transform.x[eid] = opts.x;
  Transform.y[eid] = opts.y;
  Size.w[eid] = 32;
  Size.h[eid] = 32;
  Portal[eid] = { targetMap: opts.targetMap, x: opts.destX, y: opts.destY };
  EntityMap[eid] = opts.mapId;
  return eid;
}

/** 清空 EntityMap 模块级单例残留（AoS 数组跨 world 复用 eid，防跨用例串扰）。 */
function clearEntityMap(): void {
  for (let i = 0; i < EntityMap.length; i++) EntityMap[i] = undefined;
}

/** 清空 Portal AoS 残留：旧用例的 portal 槽若无实体销毁清理会残留到新用例
 *  同 eid 上（玩家 eid 命中旧 Portal 条目会被误判为 portal 并自触发）。 */
function clearPortal(): void {
  for (let i = 0; i < Portal.length; i++) Portal[i] = undefined;
}

describe("portal", () => {
  it("同图仅相交者触发：触发者 EntityMap/Transform 变化，另一玩家 EntityMap/Transform 不变", () => {
    const world = createBareWorld();
    clearEntityMap();
    clearPortal();
    attachTestMaps(world);
    spawnTestPortal(world, { x: 50, y: 50, targetMap: "b", destX: 150, destY: 160, mapId: "a" });
    const playerA = spawnTestPlayer(world, { x: 50, y: 50 });
    EntityMap[playerA] = "a";
    const playerB = spawnTestPlayer(world, { x: 300, y: 300 });
    EntityMap[playerB] = "a";

    const out = portalSystem(world);

    expect(out).toBe(world);
    // 触发者：换图 + 传送到 portal 声明坐标
    expect(EntityMap[playerA]).toBe("b");
    expect(Transform.x[playerA]).toBe(150);
    expect(Transform.y[playerA]).toBe(160);
    // 另一玩家完全不受影响
    expect(EntityMap[playerB]).toBe("a");
    expect(Transform.x[playerB]).toBe(300);
    expect(Transform.y[playerB]).toBe(300);
    // 目标图被激活
    expect(world.activeMaps.has("b")).toBe(true);
  });

  it("两 portal × 两玩家，同 tick 各自触发各自目标", () => {
    const world = createBareWorld();
    clearEntityMap();
    clearPortal();
    attachTestMaps(world);
    spawnTestPortal(world, { x: 50, y: 50, targetMap: "b", destX: 100, destY: 100, mapId: "a" });
    spawnTestPortal(world, { x: 150, y: 150, targetMap: "c", destX: 200, destY: 200, mapId: "a" });
    const playerA = spawnTestPlayer(world, { x: 50, y: 50 });
    EntityMap[playerA] = "a";
    const playerB = spawnTestPlayer(world, { x: 150, y: 150 });
    EntityMap[playerB] = "a";

    portalSystem(world);

    expect(EntityMap[playerA]).toBe("b");
    expect(Transform.x[playerA]).toBe(100);
    expect(Transform.y[playerA]).toBe(100);
    expect(EntityMap[playerB]).toBe("c");
    expect(Transform.x[playerB]).toBe(200);
    expect(Transform.y[playerB]).toBe(200);
  });

  it("同图不相交不触发：无任何移动，无地图激活", () => {
    const world = createBareWorld();
    clearEntityMap();
    clearPortal();
    attachTestMaps(world);
    spawnTestPortal(world, { x: 50, y: 50, targetMap: "b", destX: 100, destY: 100, mapId: "a" });
    const player = spawnTestPlayer(world, { x: 500, y: 400 });
    EntityMap[player] = "a";

    portalSystem(world);

    expect(EntityMap[player]).toBe("a");
    expect(Transform.x[player]).toBe(500);
    expect(Transform.y[player]).toBe(400);
    expect(world.maps).toEqual({});
    expect(world.activeMaps.size).toBe(0);
  });

  it("目标图无效（targetMap=nope）：不移动，其他玩家不受影响", () => {
    const world = createBareWorld();
    clearEntityMap();
    clearPortal();
    attachTestMaps(world);
    spawnTestPortal(world, { x: 50, y: 50, targetMap: "nope", destX: 90, destY: 90, mapId: "a" });
    const playerA = spawnTestPlayer(world, { x: 50, y: 50 });
    EntityMap[playerA] = "a";
    const playerB = spawnTestPlayer(world, { x: 200, y: 200 });
    EntityMap[playerB] = "a";

    portalSystem(world);

    expect(EntityMap[playerA]).toBe("a");
    expect(Transform.x[playerA]).toBe(50);
    expect(Transform.y[playerA]).toBe(50);
    expect(EntityMap[playerB]).toBe("a");
    expect(Transform.x[playerB]).toBe(200);
    expect(Transform.y[playerB]).toBe(200);
    expect(world.maps).toEqual({});
    expect(world.activeMaps.size).toBe(0);
  });

  it("同一玩家重叠两个 portal 同 tick 只移动一次（迭代序第一个 portal 胜出）", () => {
    const world = createBareWorld();
    clearEntityMap();
    clearPortal();
    attachTestMaps(world);
    // p1 先创建 → eid 更小 → query 迭代序在前
    spawnTestPortal(world, { x: 50, y: 50, targetMap: "b", destX: 200, destY: 200, mapId: "a" });
    spawnTestPortal(world, { x: 50, y: 50, targetMap: "c", destX: 300, destY: 300, mapId: "a" });
    const player = spawnTestPlayer(world, { x: 50, y: 50 });
    EntityMap[player] = "a";

    portalSystem(world);

    // 只移动一次的最终态：落在迭代序第一个 portal 的目标；
    // 若同 tick 处理两次，最终将停在第二个 portal 的 c/(300,300)。
    expect(EntityMap[player]).toBe("b");
    expect(Transform.x[player]).toBe(200);
    expect(Transform.y[player]).toBe(200);
  });
});
