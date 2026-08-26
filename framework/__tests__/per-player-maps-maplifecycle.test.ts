/**
 * 分图（per-player maps）地图生命周期测试（per-player-maps 计划 todo 3）。
 *
 * 覆盖：
 * - ensureMapActive：首次激活按 registry key 惰性构建并布置初始 NPC（EntityMap 写入），
 *   二次调用幂等（不重复布置）。
 * - movePlayerToMap：移动玩家（EntityMap + Transform），目标图未激活时自动构建/激活，
 *   dest 缺省用目标图出生点，同图移动也传送。
 * - 未知 mapId：ensureMapActive / movePlayerToMap 返回 false，世界状态不变。
 *
 * 测试地图为 source.id === registry key 的生成图（与 T2 的派生一致），种子经
 * 校验（玩家/NPC 出生格未被阻塞）——buildMapRuntime 的 validateMapRuntime 会抛错。
 */
import { describe, it, expect, beforeAll } from "vitest";
import { addComponent, addEntity, query } from "bitecs";
import {
  bootstrapFramework,
  createGameInstance,
  createDefaultGameDefinition,
  ensureMapActive,
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

/**
 * 挂两张生成图（a/b）：a 带 2 个 NPC 出生点，b 无 NPC——
 * 与 slice6 的「挂两张生成图」helper 同款模式（种子经校验不阻塞出生格）。
 */
function attachTwoMaps(world: GameWorld): void {
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

/** 清空 EntityMap 模块级单例残留（AoS 数组跨 world 复用 eid，防跨用例串扰）。 */
function clearEntityMap(): void {
  for (let i = 0; i < EntityMap.length; i++) EntityMap[i] = undefined;
}

describe("map lifecycle", () => {
  it("ensureMapActive：首次激活布置 NPC 且 NPC EntityMap=该图；二次调用幂等不重复布置", () => {
    const world = createBareWorld();
    clearEntityMap();
    attachTwoMaps(world);
    ensureArchetype(world, { kind: "npc1", components: {} });

    expect(ensureMapActive(world, "a")).toBe(true);
    // 运行时按 registry key 惰性构建入缓存，图被激活
    expect(world.maps["a"]).toBeDefined();
    expect(world.maps["a"].id).toBe("a");
    expect(world.activeMaps.has("a")).toBe(true);

    // 2 个 NPC 出生点 → 2 个实体，全部归属该图
    const npcEids = query(world, [Transform]);
    expect(npcEids.length).toBe(2);
    for (const eid of npcEids) {
      expect(EntityMap[eid]).toBe("a");
    }

    // 二次激活：幂等，不重复 spawn NPC
    expect(ensureMapActive(world, "a")).toBe(true);
    expect(query(world, [Transform]).length).toBe(2);
  });

  it("movePlayerToMap：换图+传送；目标图未激活时自动激活；dest 缺省用该图出生点；同图移动也传送", () => {
    const world = createBareWorld();
    clearEntityMap();
    attachTwoMaps(world);
    const player = spawnTestPlayer(world, { x: 10, y: 10 });
    EntityMap[player] = undefined;

    // 目标图 b 未构建/未激活 → 自动构建并激活，玩家被移动
    expect(movePlayerToMap(world, player, "b", { x: 99, y: 77 })).toBe(true);
    expect(EntityMap[player]).toBe("b");
    expect(Transform.x[player]).toBe(99);
    expect(Transform.y[player]).toBe(77);
    expect(world.maps["b"]).toBeDefined();
    expect(world.activeMaps.has("b")).toBe(true);

    // dest 缺省 → 目标图出生点
    expect(movePlayerToMap(world, player, "b")).toBe(true);
    expect(Transform.x[player]).toBe(world.maps["b"].spawns.player!.x);
    expect(Transform.y[player]).toBe(world.maps["b"].spawns.player!.y);

    // 同图移动也传送（不是 no-op）
    expect(movePlayerToMap(world, player, "b", { x: 5, y: 6 })).toBe(true);
    expect(Transform.x[player]).toBe(5);
    expect(Transform.y[player]).toBe(6);
  });

  it("未知 mapId：ensureMapActive/movePlayerToMap 返回 false，世界状态不变", () => {
    const world = createBareWorld();
    clearEntityMap();
    attachTwoMaps(world);
    const player = spawnTestPlayer(world, { x: 3, y: 4 });
    EntityMap[player] = undefined;

    expect(ensureMapActive(world, "nope")).toBe(false);
    expect(world.maps).toEqual({});
    expect(world.activeMaps.size).toBe(0);

    expect(movePlayerToMap(world, player, "nope")).toBe(false);
    // 玩家未被移动/改图
    expect(EntityMap[player]).toBeUndefined();
    expect(Transform.x[player]).toBe(3);
    expect(Transform.y[player]).toBe(4);
    expect(world.maps).toEqual({});
    expect(world.activeMaps.size).toBe(0);
  });
});

/**
 * 归一分歧回归（todo：F2 残余缺陷——EntityMap 值 = source.id 时与 registry key 错位）。
 *
 * `resolvedMapSources` 以 registry key 为查找键，条目可带显式 `id`（MapSource.id）。
 * **运行时规范化键 = registry key**：`MapSource.id`（显式 id）仅为信息性字段（保留在 schema，
 * 用于 buildMapRuntime 的 runtime.id 与校验错误串）。整条链路——world.maps 存储、
 * activeMaps 成员、EntityMap 归属、movePlayerToMap 的运行时/出生点访问——一律以 registry key
 * 为键；显式 id ≠ registry key 时不得用 source.id 替换键（否则移动抛 TypeError、NPC 不
 * spawn、读档恢复静默跳过）。本用例用显式 id `"mk-canon"` ≠ registry key `"mk"` 钉住该约定。
 */
describe("map-id 归一（registry key = 运行时规范化键；source.id 信息性）", () => {
  it("ensureMapActive/movePlayerToMap 以 registry key 为键；显式 id 不影响运行时命名空间", () => {
    const world = createBareWorld();
    clearEntityMap();
    // registry key "mk"，显式 id "mk-canon"（信息性），带 2 个 NPC 出生点（种子 1 已校验可走）。
    world.gameDef.resolvedMapSources = {
      mk: {
        kind: "generated", generatorId: "simple", id: "mk-canon", name: "mk-canon",
        seed: 1, width: 8, height: 8, tileWidth: 16, tileHeight: 16,
        npcSpawns: [
          { kind: "npc1", offsetTiles: [1, 0] },
          { kind: "npc1", offsetTiles: [0, 1] },
        ],
      },
    };
    ensureArchetype(world, { kind: "npc1", components: {} });

    // ensureMapActive(registry key) 返回 true；运行时按 registry key 构建/激活（非 source.id）
    expect(ensureMapActive(world, "mk")).toBe(true);
    expect(world.maps["mk"]).toBeDefined();
    expect(world.activeMaps.has("mk")).toBe(true);
    expect(world.activeMaps.has("mk-canon")).toBe(false);

    // 初始 NPC 以 registry key 归属，且确实出生（无 id 错位时 2 只全部落同图）
    const npcEids = query(world, [Transform]);
    expect(npcEids.length).toBe(2);
    for (const eid of npcEids) {
      expect(EntityMap[eid]).toBe("mk");
    }

    // movePlayerToMap(registry key) 不再抛 TypeError；玩家按 registry key 移动
    const player = spawnTestPlayer(world, { x: 0, y: 0 });
    EntityMap[player] = undefined;
    let movedExplicit = false;
    expect(() => {
      movedExplicit = movePlayerToMap(world, player, "mk", { x: 33, y: 44 });
    }).not.toThrow();
    expect(movedExplicit).toBe(true);
    expect(EntityMap[player]).toBe("mk");
    expect(Transform.x[player]).toBe(33);
    expect(Transform.y[player]).toBe(44);

    // dest 缺省：按 registry key 取该图出生点（world.maps["mk"].spawns.player）
    expect(movePlayerToMap(world, player, "mk")).toBe(true);
    expect(Transform.x[player]).toBe(world.maps["mk"].spawns.player!.x);
    expect(Transform.y[player]).toBe(world.maps["mk"].spawns.player!.y);
  });
});
