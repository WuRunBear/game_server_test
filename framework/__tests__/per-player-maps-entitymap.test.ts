/**
 * EntityMap AoS 组件测试（per-player-maps 计划 todo 1）。
 *
 * 覆盖：
 * - destroyEntity 经 registry.all() 自动清理 EntityMap 条目（防 eid 复用污染存档）
 * - serializeWorld → restoreWorld 环回保持实体 EntityMap 字符串（AoS 自动入档路径）
 * - entityMapOf 回退语义：无条目时返回 world.defaultMapId；默认图为空串时返回 ""
 *
 * 注：world.defaultMapId 由 per-player-maps todo 2 引入；该字段未落地前本文件的
 * 类型检查会报错，属计划内并行依赖，由编排器在 todo 2 落地后复跑编译验收。
 */
import { describe, it, expect, beforeAll } from "vitest";
import { query } from "bitecs";
import {
  bootstrapFramework,
  createGameInstance,
  createDefaultGameDefinition,
  spawnEntity,
  getRegistries,
  serializeWorld,
  restoreWorld,
} from "framework/index";
import { destroyEntity } from "framework/entities/destroyEntity";
import { EntityMap, entityMapOf } from "framework/components/entityMap";
import { NetworkId } from "framework/components/network";
import type { GameWorld } from "framework/world";

beforeAll(() => {
  bootstrapFramework();
});

/** 构造一个最小世界（默认配置，与既有持久化用例同款）。 */
function createBareWorld(): GameWorld {
  return createGameInstance(createDefaultGameDefinition()).world;
}

/** 注册测试原型（全局注册表单例，跨用例重复注册会抛错 → 已存在则跳过）。 */
function ensureArchetype(world: GameWorld, spec: Parameters<typeof world.archetypes.register>[0]): void {
  if (!world.archetypes.has(spec.kind)) {
    world.archetypes.register(spec);
  }
}

function ensureTestArchetype(world: GameWorld): void {
  ensureArchetype(world, {
    kind: "w1",
    tags: ["Player"],
    components: {
      Size: { w: 16, h: 16 },
      Velocity: {},
      Collider: { shape: 1, halfW: 8, halfH: 8 },
      Health: { current: 100, max: 100 },
    },
    team: 1,
  });
}

describe("EntityMap", () => {
  it("destroyEntity：自动清理 EntityMap 条目（registry.all() AoS 路径），防 eid 复用污染存档", () => {
    const world = createBareWorld();
    ensureTestArchetype(world);
    const eid = spawnEntity(world, world.archetypes.get("w1"), getRegistries().componentRegistry, { x: 0, y: 0 });
    EntityMap[eid] = "m1";
    expect(EntityMap[eid]).toBe("m1");

    destroyEntity(world, eid);

    expect(EntityMap[eid]).toBeUndefined();
    expect(query(world, [NetworkId])).not.toContain(eid);
  });

  it("serializeWorld → restoreWorld：实体 EntityMap 字符串环回一致（AoS 自动入档）", () => {
    const world1 = createBareWorld();
    ensureTestArchetype(world1);
    const eid = spawnEntity(world1, world1.archetypes.get("w1"), getRegistries().componentRegistry, { x: 0, y: 0 });
    EntityMap[eid] = "m1";

    const record = serializeWorld(world1, "s1");
    const saved = record.entities.find((e) => e.kind === "w1")!;
    expect(saved.components["EntityMap"]).toBe("m1");

    const world2 = createBareWorld();
    const orphan = restoreWorld(world2, record);
    expect(orphan.length).toBe(1);
    expect(EntityMap[orphan[0]]).toBe("m1");
  });

  it("entityMapOf：无 EntityMap 条目时回退 world.defaultMapId", () => {
    const world = createBareWorld();
    ensureTestArchetype(world);
    world.defaultMapId = "default-map";
    const eid = spawnEntity(world, world.archetypes.get("w1"), getRegistries().componentRegistry, { x: 0, y: 0 });
    // EntityMap 无 AoS 初始化钩子（spawn 不写入），显式清掉跨用例残留保持用例独立
    EntityMap[eid] = undefined;

    expect(entityMapOf(world, eid)).toBe("default-map");
  });

  it("entityMapOf：世界默认图为空串时返回空串", () => {
    const world = createBareWorld();
    ensureTestArchetype(world);
    const eid = spawnEntity(world, world.archetypes.get("w1"), getRegistries().componentRegistry, { x: 0, y: 0 });
    EntityMap[eid] = undefined;

    expect(entityMapOf(world, eid)).toBe("");
  });
});
