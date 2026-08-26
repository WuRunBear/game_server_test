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

/**
 * 读档恢复不重复布置初始 NPC 回归（todo：restoreWorld 二次 spawn）。
 *
 * restoreWorld 经 ensureMapActive 为每个恢复图重建 activeMaps；若该路径再跑
 * spawnInitialNpcs，会在持久化的 NPC（尚未即已入档）之上再铺一份同名同坐标的第二波，
 * 且会复活存档前已被击杀的 NPC。修复方向：restoreWorld 以 `{ spawnInitialNpcs: false }`
 * 激活恢复图，NPC 仅来自存档实体——每图 NPC 计数必须等于存档前计数（不翻倍）。
 */
describe("persist 恢复不重复布置初始 NPC", () => {
  /**
   * 挂两张生成图：cave 无 NPC 出生点，hill 带 2 个 NPC 出生点（种子经校验格可走）。
   * 两图 seed 独立复用（各图几何互不影响），仅 hill 的 spawns.npcs 会被 spawInitialNpcs 消费。
   */
  function attachTwoMapsWithNpcSpawns(world: GameWorld): void {
    world.gameDef.resolvedMapSources = {
      cave: {
        kind: "generated", generatorId: "simple", id: "cave", name: "cave",
        seed: 2, width: 8, height: 8, tileWidth: 16, tileHeight: 16,
      },
      hill: {
        kind: "generated", generatorId: "simple", id: "hill", name: "hill",
        seed: 1, width: 8, height: 8, tileWidth: 16, tileHeight: 16,
        npcSpawns: [
          { kind: "npc1", offsetTiles: [1, 0] },
          { kind: "npc1", offsetTiles: [0, 1] },
        ],
      },
    };
  }

  it("restoreWorld 激活恢复图时不再 spawn 初始 NPC：hill NPC 计数与存档前一致（不翻倍）", () => {
    const world1 = createBareWorld();
    clearEntityMap();
    attachTwoMapsWithNpcSpawns(world1);
    ensureArchetype(world1, { kind: "npc1", components: {} });

    // 首次激活 hill → spawnInitialNpcs 布置 2 个初始 NPC（存档前置基准）
    expect(ensureMapActive(world1, "hill")).toBe(true);
    const preCount = query(world1, [NetworkId]).length;
    expect(preCount).toBe(2);

    const record = serializeWorld(world1, "s1");

    // 恢复进全新 world2（同两张图；同 npcSpawns）
    const world2 = createBareWorld();
    clearEntityMap();
    attachTwoMapsWithNpcSpawns(world2);
    ensureArchetype(world2, { kind: "npc1", components: {} });

    const orphan = restoreWorld(world2, record);
    expect(orphan).toEqual([]);
    // hill 从实体归属重建激活，但不得重复布置初始 NPC
    expect(world2.activeMaps.has("hill")).toBe(true);
    const postCount = query(world2, [NetworkId]).length;
    expect(postCount).toBe(preCount);
    // 全部 NPC 归属 hill（无多余实体混入）
    const hillNpcs = query(world2, [NetworkId]).filter((eid) => EntityMap[eid] === "hill");
    expect(hillNpcs.length).toBe(2);
  });
});

/**
 * 读档恢复 explicit-id 图回归（F2 残余缺陷：EntityMap 值 = source.id 时与 registry key 错位）。
 *
 * 实体归属（EntityMap）现以 registry key 为规范化键。若 restoreWorld 的激活键/缓存键与实体
 * 归属键不一致（旧实现按 source.id），恢复时 ensureMapActive 以 EntityMap 值查
 * resolvedMapSources 会命中不了（键不同于 key），图静默不重建——activeMaps 空、world.maps 缺键、
 * spawning 规则失效、collision 回退默认墙。本用例用显式 id `"hill-canon"` ≠ registry key
 * `"hill"` 钉住：序列化→恢复后按 registry key 重建激活/缓存，NPC 不翻倍。
 */
describe("persist 恢复 explicit-id 图（registry key 命名空间）", () => {
  /** 挂一张带 2 个 NPC 出生点的 explicit-id 图：registry key "hill"，显式 id "hill-canon"。 */
  function attachExplicitIdMap(world: GameWorld): void {
    world.gameDef.resolvedMapSources = {
      hill: {
        kind: "generated", generatorId: "simple", id: "hill-canon", name: "hill-canon",
        seed: 1, width: 8, height: 8, tileWidth: 16, tileHeight: 16,
        npcSpawns: [
          { kind: "npc1", offsetTiles: [1, 0] },
          { kind: "npc1", offsetTiles: [0, 1] },
        ],
      },
    };
  }

  it("explicit-id 图恢复：按 registry key 重建激活与缓存，NPC 计数与存档前一致", () => {
    const world1 = createBareWorld();
    clearEntityMap();
    attachExplicitIdMap(world1);
    ensureArchetype(world1, { kind: "npc1", components: {} });

    // 首次激活 hill（registry key）→ spawnInitialNpcs 布置 2 个初始 NPC（存档前置基准），归属=key
    expect(ensureMapActive(world1, "hill")).toBe(true);
    expect(world1.activeMaps.has("hill")).toBe(true);
    const preCount = query(world1, [NetworkId]).length;
    expect(preCount).toBe(2);

    const record = serializeWorld(world1, "s1");

    // 恢复进全新 world2（同源 resolvedMapSources；同 npcSpawns）
    const world2 = createBareWorld();
    clearEntityMap();
    attachExplicitIdMap(world2);
    ensureArchetype(world2, { kind: "npc1", components: {} });

    const orphan = restoreWorld(world2, record);
    expect(orphan).toEqual([]);
    // 恢复后按 registry key 重建激活与缓存；不得以 source.id（hill-canon）为键
    expect(world2.activeMaps.has("hill")).toBe(true);
    expect(world2.activeMaps.has("hill-canon")).toBe(false);
    expect(world2.maps["hill"]).toBeDefined();
    // NPC 计数与存档前一致（不翻倍），全部归属 registry key（非 source.id）
    const postCount = query(world2, [NetworkId]).length;
    expect(postCount).toBe(preCount);
    const hillNpcs = query(world2, [NetworkId]).filter((eid) => EntityMap[eid] === "hill");
    expect(hillNpcs.length).toBe(2);
    // 再次 ensureMapActive(registry key) 仍解析到来源返回 true
    expect(ensureMapActive(world2, "hill")).toBe(true);
  });
});
