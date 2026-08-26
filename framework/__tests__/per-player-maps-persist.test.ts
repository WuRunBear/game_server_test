/**
 * 分图（per-player maps）持久化测试（per-player-maps 计划 todo 15）。
 *
 * 覆盖：
 * - 新档 roundtrip：双图世界中玩家按 EntityMap 归属 cave，序列化 → 恢复后
 *   玩家仍属 cave，且 cave 从实体归属重建激活（world.activeMaps 含 cave）。
 * - 旧档迁移：record.mapId="cave" 且实体无 EntityMap（旧版存档形态）→
 *   恢复后玩家落 cave——record.mapId 仅作旧档回退，新档以实体归属为准。
 * - 畸形存档防御：{id, savedAt, tick, nextNetworkId}（无 entities）不抛错，
 *   恢复出空世界（既有行为保留）。
 *
 * 测试地图为 source.id === registry key 的生成图（与 T2 的派生一致），种子经
 * 校验（buildMapRuntime 的 validateMapRuntime 不会因出生格阻塞而抛错）。
 * 全部沿用 T1 环回测试与 T3 挂双图 helper 的既定模式（见 learnings.md）。
 */
import { describe, it, expect, beforeAll } from "vitest";
import { query } from "bitecs";
import {
  bootstrapFramework,
  createGameInstance,
  createDefaultGameDefinition,
  ensureMapActive,
  getRegistries,
  restoreWorld,
  serializeWorld,
  spawnEntity,
} from "framework/index";
import { EntityMap } from "framework/components/entityMap";
import { NetworkId } from "framework/components/network";
import type { GameWorld } from "framework/world";
import type { WorldRecord } from "framework/repository";

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

/**
 * 挂两张生成图（cave/meadow）：cave 为测试主图，均无 NPC 出生点——
 * 激活只做 activeMaps 标记，不额外 spawn 实体（断言面干净）。
 */
function attachTwoMaps(world: GameWorld): void {
  world.gameDef.resolvedMapSources = {
    cave: {
      kind: "generated", generatorId: "simple", id: "cave", name: "cave",
      seed: 1, width: 8, height: 8, tileWidth: 16, tileHeight: 16,
    },
    meadow: {
      kind: "generated", generatorId: "simple", id: "meadow", name: "meadow",
      seed: 2, width: 8, height: 8, tileWidth: 16, tileHeight: 16,
    },
  };
}

/** 清空 EntityMap 模块级单例残留（AoS 数组跨 world 复用 eid，防跨用例串扰）。 */
function clearEntityMap(): void {
  for (let i = 0; i < EntityMap.length; i++) EntityMap[i] = undefined;
}

describe("persist", () => {
  it("新档 roundtrip：实体 EntityMap 归属恢复，且按归属重建 activeMaps", () => {
    const world1 = createBareWorld();
    clearEntityMap();
    attachTwoMaps(world1);
    ensureTestArchetype(world1);
    // 双图激活（常驻语义：两张图都在 activeMaps）
    expect(ensureMapActive(world1, "cave")).toBe(true);
    expect(ensureMapActive(world1, "meadow")).toBe(true);
    // 玩家经 spawnEntity overrides.mapId 归属 cave
    const eid = spawnEntity(world1, world1.archetypes.get("w1"), getRegistries().componentRegistry, {
      x: 0,
      y: 0,
      mapId: "cave",
    });
    expect(EntityMap[eid]).toBe("cave");

    const record = serializeWorld(world1, "s1");
    const saved = record.entities.find((e) => e.kind === "w1")!;
    // AoS 自动入档：存档含实体级地图归属
    expect(saved.components["EntityMap"]).toBe("cave");

    const world2 = createBareWorld();
    attachTwoMaps(world2);
    const orphan = restoreWorld(world2, record);
    expect(orphan.length).toBe(1);
    // 玩家回到其存档归属图；该图从实体归属重建为激活图
    expect(EntityMap[orphan[0]]).toBe("cave");
    expect(world2.activeMaps.has("cave")).toBe(true);
  });

  it("旧档迁移：实体无 EntityMap 时 record.mapId 回退，玩家落回存档图", () => {
    const world1 = createBareWorld();
    clearEntityMap();
    attachTwoMaps(world1);
    ensureTestArchetype(world1);
    spawnEntity(world1, world1.archetypes.get("w1"), getRegistries().componentRegistry, {
      x: 0,
      y: 0,
    });

    // 模拟旧档形态：删除实体级 EntityMap（旧版本无此组件），只留 record.mapId
    const record = serializeWorld(world1, "s1");
    delete record.entities[0].components["EntityMap"];
    record.mapId = "cave";

    const world2 = createBareWorld();
    attachTwoMaps(world2);
    const orphan = restoreWorld(world2, record);
    expect(orphan.length).toBe(1);
    // record.mapId 回退：实体归属落到存档图并激活
    expect(EntityMap[orphan[0]]).toBe("cave");
    expect(world2.activeMaps.has("cave")).toBe(true);
  });

  it("畸形存档防御：无 entities 字段不抛错，恢复空世界", () => {
    const world = createBareWorld();
    clearEntityMap();
    attachTwoMaps(world);
    const orphan = restoreWorld(world, {
      id: "s",
      savedAt: 1,
      tick: 5,
      nextNetworkId: 9,
    } as unknown as WorldRecord);
    expect(orphan).toEqual([]);
    expect(query(world, [NetworkId]).length).toBe(0);
  });
});
