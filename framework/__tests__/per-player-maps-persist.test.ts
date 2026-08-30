/**
 * 分图（per-player maps）持久化测试（核心切换后语义）。
 *
 * 覆盖：
 * - 新档 roundtrip：实体 EntityMap 归属恢复，恢复图按归属补齐 activeMaps。
 * - 旧档迁移：实体无 EntityMap 时 record.mapId 回退（该字段删除归持久化切换 todo）。
 * - 畸形存档防御：无 entities 字段不抛错。
 * - 恢复不重复布置实体：恢复后实体计数与存档前一致（初始布置唯一路径 = 演化引擎，
 *   restoreWorld 只恢复存档实体）。
 * - registry key 命名空间：恢复按 EntityMap 值（registry key）激活，不认显式 id 别名。
 */
import { describe, it, expect, beforeAll } from "vitest";
import { query } from "bitecs";
import {
  bootstrapFramework,
  createGameInstance,
  createDefaultGameDefinition,
  getRegistries,
} from "framework/index";
import { serializeWorld, restoreWorld } from "framework/persistence/worldSerializer";
import { spawnEntity } from "framework/entities/spawn";
import { NetworkId } from "framework/components/network";
import { EntityMap } from "framework/components/entityMap";
import { makeTestGeometry } from "./helpers/mapGeometry";
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

/** 挂两张已构建图（cave/meadow，全部常驻激活——核心切换后无惰性构建）。 */
function attachTwoMaps(world: GameWorld): void {
  world.maps = {
    cave: makeTestGeometry({ key: "cave", width: 8, height: 8 }),
    meadow: makeTestGeometry({ key: "meadow", width: 8, height: 8 }),
  };
  world.activeMaps = new Set(["cave", "meadow"]);
  world.defaultMapId = "cave";
}

/** 清空 EntityMap 模块级单例残留（AoS 数组跨 world 复用 eid，防跨用例串扰）。 */
function clearEntityMap(): void {
  for (let i = 0; i < EntityMap.length; i++) EntityMap[i] = undefined;
}

/** 带完整组件与 Player 标签的测试原型（orphan 判定按 Player tag）。 */
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

describe("persist", () => {
  it("新档 roundtrip：实体 EntityMap 归属恢复，且按归属补齐 activeMaps", () => {
    const world1 = createBareWorld();
    clearEntityMap();
    attachTwoMaps(world1);
    ensureTestArchetype(world1);
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
    // 玩家回到其存档归属图；该图在激活集中
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

/**
 * 恢复不重复布置实体回归：restoreWorld 只恢复存档实体（初始布置唯一路径 =
 * 演化引擎），恢复后实体计数必须等于存档前计数（不翻倍）。
 */
describe("persist 恢复不重复布置实体", () => {
  it("restoreWorld 后实体计数与存档前一致（不翻倍）", () => {
    const world1 = createBareWorld();
    clearEntityMap();
    attachTwoMaps(world1);
    ensureArchetype(world1, { kind: "npc1", components: {} });

    // 手工布置 2 个 NPC（演化引擎职责的替身），归属 hill 图
    world1.maps["hill"] = makeTestGeometry({ key: "hill", width: 8, height: 8 });
    world1.activeMaps.add("hill");
    for (const pos of [{ x: 16, y: 16 }, { x: 32, y: 16 }]) {
      const eid = spawnEntity(world1, world1.archetypes.get("npc1"), getRegistries().componentRegistry, {
        x: pos.x,
        y: pos.y,
        mapId: "hill",
      });
      expect(EntityMap[eid]).toBe("hill");
    }
    const preCount = query(world1, [NetworkId]).length;
    expect(preCount).toBe(2);

    const record = serializeWorld(world1, "s1");

    // 恢复进全新 world2（同两张图）
    const world2 = createBareWorld();
    clearEntityMap();
    attachTwoMaps(world2);
    world2.maps["hill"] = makeTestGeometry({ key: "hill", width: 8, height: 8 });
    ensureArchetype(world2, { kind: "npc1", components: {} });

    const orphan = restoreWorld(world2, record);
    expect(orphan).toEqual([]);
    // hill 从实体归属补齐激活，但不得重复布置实体
    expect(world2.activeMaps.has("hill")).toBe(true);
    const postCount = query(world2, [NetworkId]).length;
    expect(postCount).toBe(preCount);
    // 全部 NPC 归属 hill（无多余实体混入）
    const hillNpcs = query(world2, [NetworkId]).filter((eid) => EntityMap[eid] === "hill");
    expect(hillNpcs.length).toBe(2);
  });
});

/**
 * registry key 命名空间回归：恢复按 EntityMap 值（registry key）激活与缓存，
 * 显式 id 风格的别名键不参与运行时命名空间。
 */
describe("persist 恢复 explicit-id 图（registry key 命名空间）", () => {
  it("explicit-id 图恢复：按 registry key 重建激活与缓存，实体计数与存档前一致", () => {
    const world1 = createBareWorld();
    clearEntityMap();
    attachTwoMaps(world1);
    ensureArchetype(world1, { kind: "npc1", components: {} });

    // registry key "hill"（显式 id 仅为信息性，新模型已无该字段）——布置 2 个归属 hill 的 NPC
    world1.maps["hill"] = makeTestGeometry({ key: "hill", width: 8, height: 8 });
    world1.activeMaps.add("hill");
    for (const pos of [{ x: 16, y: 16 }, { x: 32, y: 16 }]) {
      spawnEntity(world1, world1.archetypes.get("npc1"), getRegistries().componentRegistry, {
        x: pos.x,
        y: pos.y,
        mapId: "hill",
      });
    }
    const preCount = query(world1, [NetworkId]).length;
    expect(preCount).toBe(2);

    const record = serializeWorld(world1, "s1");

    const world2 = createBareWorld();
    clearEntityMap();
    attachTwoMaps(world2);
    world2.maps["hill"] = makeTestGeometry({ key: "hill", width: 8, height: 8 });
    ensureArchetype(world2, { kind: "npc1", components: {} });

    const orphan = restoreWorld(world2, record);
    expect(orphan).toEqual([]);
    // 恢复后按 registry key 补齐激活；别名键不存在
    expect(world2.activeMaps.has("hill")).toBe(true);
    expect(world2.activeMaps.has("hill-canon")).toBe(false);
    expect(world2.maps["hill"]).toBeDefined();
    const postCount = query(world2, [NetworkId]).length;
    expect(postCount).toBe(preCount);
    const hillNpcs = query(world2, [NetworkId]).filter((eid) => EntityMap[eid] === "hill");
    expect(hillNpcs.length).toBe(2);
  });
});
