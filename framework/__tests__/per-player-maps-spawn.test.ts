/**
 * spawn 链 EntityMap 写入测试（per-player-maps 计划 todo 4）。
 *
 * 覆盖：
 * - spawnEntity 显式 overrides.mapId → 实体 EntityMap 写入该地图 id
 * - spawnEntity 无 mapId → 回退 world.defaultMapId
 * - dropSlot → 掉落 item 实体的 EntityMap = 丢弃者的地图
 * - deathSystem 掉落 → item 实体的 EntityMap = 死亡实体的地图
 *
 * 注：EntityMap 是模块单例 AoS，spawn 链为每个新实体无条件写入，
 * 用例间无残留（eid 自每个 world 从 1 复用，写入即覆盖）。
 */
import { describe, it, expect, beforeAll } from "vitest";
import { query } from "bitecs";
import {
  bootstrapFramework,
  createGameInstance,
  createDefaultGameDefinition,
  spawnEntity,
  getRegistries,
} from "framework/index";
import { EntityMap } from "framework/components/entityMap";
import { Transform } from "framework/components/transform";
import { Health } from "framework/components/combat";
import { Inventory } from "framework/components/inventory";
import { LootTable } from "framework/components/loot";
import { Item } from "framework/components/tags";
import { dropSlot } from "framework/systems/gameplay/inventoryOps";
import { deathSystem } from "framework/systems/gameplay/deathSystem";
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

/** 取 [Item] 结果中最后一个（index 参数）——drop 前 world 中无 item 时即 [0]。 */
function lastItem(world: GameWorld, index: number): number {
  return query(world, [Item])[index];
}

describe("spawn map", () => {
  it("spawnEntity 显式 overrides.mapId → EntityMap[eid] 写入该地图 id", () => {
    const world = createBareWorld();
    ensureTestArchetype(world);
    world.defaultMapId = "default-map";

    const eid = spawnEntity(world, world.archetypes.get("w1"), getRegistries().componentRegistry, {
      x: 0,
      y: 0,
      mapId: "custom-map",
    });

    expect(EntityMap[eid]).toBe("custom-map");
  });

  it("spawnEntity 无 mapId → EntityMap[eid] 回退 world.defaultMapId", () => {
    const world = createBareWorld();
    ensureTestArchetype(world);
    world.defaultMapId = "default-map";

    const eid = spawnEntity(world, world.archetypes.get("w1"), getRegistries().componentRegistry, {
      x: 0,
      y: 0,
    });

    expect(EntityMap[eid]).toBe("default-map");
  });

  it("dropSlot → 掉落 item 实体的 EntityMap = 丢弃者的地图（entityMapOf 级联）", () => {
    const world = createBareWorld();
    ensureTestArchetype(world);
    const player = spawnEntity(world, world.archetypes.get("w1"), getRegistries().componentRegistry, {
      x: 100,
      y: 100,
      mapId: "custom-map",
    });
    Inventory[player] = { capacity: 4, slots: [{ kind: "k1", count: 2 }, null, null, null] };

    const before = query(world, [Item]).length;
    expect(dropSlot(world, player, 0)).toBe(true);
    expect(Inventory[player]!.slots[0]).toBe(null);
    const dropped = lastItem(world, before);

    expect(EntityMap[dropped]).toBe("custom-map");
  });

  it("deathSystem 掉落 → item 实体的 EntityMap = 死亡实体的地图", () => {
    const world = createBareWorld();
    ensureTestArchetype(world);
    const dead = spawnEntity(world, world.archetypes.get("w1"), getRegistries().componentRegistry, {
      x: 0,
      y: 0,
      mapId: "dead-map",
    });
    Health.current[dead] = 0;
    LootTable[dead] = [{ kind: "k1", qty: 1, chance: 1 }];

    const before = query(world, [Item]).length;
    deathSystem(world);
    const dropped = lastItem(world, before);

    expect(EntityMap[dropped]).toBe("dead-map");
  });
});
