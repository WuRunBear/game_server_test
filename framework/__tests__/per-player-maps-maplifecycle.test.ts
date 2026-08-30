/**
 * 分图（per-player maps）地图切换测试（核心切换后语义）。
 *
 * 覆盖：
 * - movePlayerToMap：移动玩家（EntityMap + Transform），dest 缺省用目标图
 *   几何中心，同图移动也传送。
 * - 未知 mapId：movePlayerToMap 返回 false，世界状态不变。
 * - registry key = 运行时规范化键（旧惰性构建/初始布置
 *   已随核心切换消亡：地图由 bootMaps 全量构建并常驻激活）。
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
import { Health, Team } from "framework/components/combat";
import { NetworkId } from "framework/components/network";
import { Player } from "framework/components/tags";
import { Inventory } from "framework/components/inventory";
import { Size } from "framework/components/size";
import { EntityMap } from "framework/components/entityMap";
import { setEntityKind } from "framework/systems/gameplay/aiSystem";
import { makeTestGeometry } from "./helpers/mapGeometry";
import type { GameWorld } from "framework/world";

beforeAll(() => {
  // 全局引导一次：注册表是幂等单例，所有用例共享同一套内置实现
  bootstrapFramework();
});

/** 构造一个最小世界（默认配置，无地图配置兜底路径）。 */
function createBareWorld(): GameWorld {
  return createGameInstance(createDefaultGameDefinition()).world;
}

/** 手工构造玩家实体（不经 spawnEntity——非本切片职责）。 */
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

/** 清空 EntityMap 模块级单例残留（AoS 数组跨 world 复用 eid，防跨用例串扰）。 */
function clearEntityMap(): void {
  for (let i = 0; i < EntityMap.length; i++) EntityMap[i] = undefined;
}

/** 挂两张已构建图（a/b，全部常驻激活——核心切换后无惰性构建）。 */
function attachTwoMaps(world: GameWorld): void {
  world.defaultMapId = "a";
  world.maps = {
    a: makeTestGeometry({ key: "a", width: 8, height: 8 }),
    b: makeTestGeometry({ key: "b", width: 8, height: 8 }),
  };
  world.activeMaps = new Set(["a", "b"]);
}

describe("map switch (movePlayerToMap)", () => {
  it("movePlayerToMap：换图+传送；dest 缺省用目标图几何中心；同图移动也传送", () => {
    const world = createBareWorld();
    clearEntityMap();
    attachTwoMaps(world);
    const player = spawnTestPlayer(world, { x: 10, y: 10 });
    EntityMap[player] = "a";

    expect(movePlayerToMap(world, player, "b", { x: 99, y: 77 })).toBe(true);
    expect(EntityMap[player]).toBe("b");
    expect(Transform.x[player]).toBe(99);
    expect(Transform.y[player]).toBe(77);

    // dest 缺省 → 目标图几何中心（8×8 tile × 16px）
    expect(movePlayerToMap(world, player, "b")).toBe(true);
    expect(Transform.x[player]).toBe(64);
    expect(Transform.y[player]).toBe(64);

    // 同图移动也传送（不是 no-op）
    expect(movePlayerToMap(world, player, "b", { x: 5, y: 6 })).toBe(true);
    expect(Transform.x[player]).toBe(5);
    expect(Transform.y[player]).toBe(6);
  });

  it("未知 mapId：movePlayerToMap 返回 false，世界状态不变", () => {
    const world = createBareWorld();
    clearEntityMap();
    attachTwoMaps(world);
    const player = spawnTestPlayer(world, { x: 3, y: 4 });
    EntityMap[player] = "a";

    expect(movePlayerToMap(world, player, "nope")).toBe(false);
    // 玩家未被移动/改图
    expect(EntityMap[player]).toBe("a");
    expect(Transform.x[player]).toBe(3);
    expect(Transform.y[player]).toBe(4);
    expect(Object.keys(world.maps).sort()).toEqual(["a", "b"]);
    expect(world.activeMaps).toEqual(new Set(["a", "b"]));
  });
});

/**
 * registry key = 运行时规范化键回归：world.maps 存储、activeMaps 成员、
 * EntityMap 归属、movePlayerToMap 的运行时访问一律以 registry key 为键。
 */
describe("map-id 归一（registry key = 运行时规范化键）", () => {
  it("movePlayerToMap 以 registry key 为键；缺键图不可作为目标", () => {
    const world = createBareWorld();
    clearEntityMap();
    world.maps = { mk: makeTestGeometry({ key: "mk", width: 8, height: 8 }) };
    world.activeMaps = new Set(["mk"]);
    world.defaultMapId = "mk";

    const player = spawnTestPlayer(world, { x: 0, y: 0 });
    EntityMap[player] = "mk";

    expect(movePlayerToMap(world, player, "mk", { x: 33, y: 44 })).toBe(true);
    expect(EntityMap[player]).toBe("mk");
    expect(Transform.x[player]).toBe(33);
    expect(Transform.y[player]).toBe(44);

    // 显式 id 风格的别名键不存在 → 拒绝移动（不抛错、不改归属）
    expect(movePlayerToMap(world, player, "mk-canon")).toBe(false);
    expect(EntityMap[player]).toBe("mk");
  });
});
