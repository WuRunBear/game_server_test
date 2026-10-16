/**
 * 地图切片 7：地形写回入口 + 增量存档（docs/map-system-v2-design.md §3）。
 *
 * 覆盖：
 * - 写回入口：tiles/walkable 原地变化 + version 指纹重算 + 值域/索引/图存在性
 *   硬校验 + 同值写回 no-op（不动指纹/纪元/脏格）+ callerTick 记账 + 出厂底板
 *   不被写回污染；地形纪元与建造纪元相互独立；
 * - 碰撞失效重建：写回 walkable=0 后按层碰撞静态体经地形纪元重建（实体被阻挡）；
 * - 合成 tick 系统调用方：写回挂进 instance.systems 后 step，全链生效；
 * - 脏格登记：推完即清（二次排空为空）；
 * - 增量存档等价性：改 3 格 → 存（delta 条目）→ 读档（种子重算底板 + 指纹
 *   比对 + 叠加）→ 与存档前世界逐位一致，且再存档产出同一增量条目（幂等）；
 * - 超阈值降级全量：修改数 ≤10% 走增量、>10% 走全量；全量条目读档逐字节还原；
 * - 指纹不匹配拒绝读档 + 畸形修改项拒绝读档（绝不静默加载）。
 */
import { describe, it, expect, beforeAll } from "vitest";
import { addComponent, addEntity } from "bitecs";
import {
  bootstrapFramework,
  createGameInstance,
  createGameSimulation,
  createDefaultGameDefinition,
  serializeWorld,
} from "framework/index";
import {
  setGround,
  setWalkable,
  drainDirtyTiles,
  terrainBaselineOf,
  getTerrainEpoch,
} from "map/runtime/terrainWriteback";
import { getBuiltStructuresEpoch } from "map/runtime/builtStructures";
import { serializeGeometry, type SerializedMapGeometry } from "map/geometry/snapshot";
import { computeGeometryVersion } from "map/geometry/version";
import type { SerializedMapDelta } from "map/geometry/delta";
import { Transform } from "framework/components/transform";
import { Velocity, Collider, ColliderShape } from "framework/components/physics";
import { EntityMap } from "framework/components/entityMap";
import { collisionSystem } from "framework/systems/core/collisionSystem";
import { movementSystem } from "framework/systems/core/movementSystem";
import { memoryRepository } from "./helpers/persistence";
import type { LoadedGameDefinition } from "framework/config/schema/GameDefinitionSchema";
import type { MapConfig } from "framework/config/schema/MapRegistrySchema";
import type { WorldRecord } from "framework/repository";
import type { GameWorld } from "framework/world";
import type { SimulationPort } from "simulation";

beforeAll(() => {
  bootstrapFramework();
});

const MAP = "wb-map";

/** 8×8 全可走单区域图配置（固定 seed，出厂底板可复算）。 */
function mapConfig(): MapConfig {
  return {
    key: MAP,
    seed: 42,
    initialAgeTicks: 0,
    pipeline: [
      {
        generator: "noise-terrain",
        params: {
          width: 8,
          height: 8,
          tileWidth: 16,
          tileHeight: 16,
          bandLevel: 1,
          groundPalette: { "1": 1 },
          nonWalkableSemantics: [],
        },
      },
      { generator: "climate-regions", params: { names: ["alpha"], style: "noise" } },
    ],
  };
}

/** 单图无规则定义（写回/存档断言不掺杂演化实体）。 */
function buildDef(): LoadedGameDefinition {
  const def = createDefaultGameDefinition();
  def.resolvedEntities = [];
  def.resolvedMapConfigs = [mapConfig()];
  def.resolvedEntityRules = [];
  def.resolvedStaticEntityRules = [];
  return def;
}

function simWorld(sim: SimulationPort): GameWorld {
  return (sim as unknown as { world: GameWorld }).world;
}

/** 清空 EntityMap 模块级单例残留（AoS 数组跨 world 复用 eid，防跨用例串扰）。 */
function clearEntityMap(): void {
  for (let i = 0; i < EntityMap.length; i++) EntityMap[i] = undefined;
}

/** 手工构造移动实体（Transform + Velocity + Box Collider，碰撞系统处理的最小集）。 */
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

describe("地形写回入口（setGround / setWalkable）", () => {
  it("写回后 tiles/walkable 变化、version 指纹重算、出厂底板不被污染", () => {
    const world = createGameInstance(buildDef()).world;
    const geometry = world.maps[MAP]!;
    const version0 = geometry.version;

    expect(setGround(world, MAP, 3 * 8 + 5, 3)).toBe(true);
    expect(geometry.tiles[3 * 8 + 5]).toBe(3);
    expect(geometry.version).not.toBe(version0);
    // version 与内容恒同步（重算走 computeGeometryVersion 通道）
    expect(geometry.version).toBe(computeGeometryVersion(geometry));

    const versionAfterGround = geometry.version;
    expect(setWalkable(world, MAP, 4 * 8 + 5, 0)).toBe(true);
    expect(geometry.walkable[4 * 8 + 5]).toBe(0);
    expect(geometry.version).not.toBe(versionAfterGround);
    expect(geometry.version).toBe(computeGeometryVersion(geometry));

    // 出厂底板是副本：写回后基准仍是生成时内容与指纹
    const baseline = terrainBaselineOf(world, MAP)!;
    expect(baseline.tiles[3 * 8 + 5]).not.toBe(3);
    expect(baseline.walkable[4 * 8 + 5]).toBe(1);
    expect(baseline.version).toBe(version0);
  });

  it("同值写回 no-op：返回 false，指纹/地形纪元/脏格全不动", () => {
    const world = createGameInstance(buildDef()).world;
    const geometry = world.maps[MAP]!;
    const epoch0 = getTerrainEpoch(world, MAP);
    const builtEpoch0 = getBuiltStructuresEpoch(world, MAP);
    const version0 = geometry.version;

    expect(setGround(world, MAP, 0, geometry.tiles[0]!)).toBe(false);
    expect(setWalkable(world, MAP, 1, geometry.walkable[1] as 0 | 1)).toBe(false);

    expect(geometry.version).toBe(version0);
    expect(getTerrainEpoch(world, MAP)).toBe(epoch0);
    expect(drainDirtyTiles(world).size).toBe(0);
  });

  it("硬校验：未知图 / 越界索引 / 值域非法 → 显式抛错", () => {
    const world = createGameInstance(buildDef()).world;
    expect(() => setGround(world, "no-such-map", 0, 1)).toThrow(/no-such-map/);
    expect(() => setGround(world, MAP, 64, 1)).toThrow(/tileIndex/);
    expect(() => setGround(world, MAP, -1, 1)).toThrow(/tileIndex/);
    expect(() => setGround(world, MAP, 0, 256)).toThrow(/0\.\.255/);
    expect(() => setWalkable(world, MAP, 0, 2 as 0 | 1)).toThrow(/0 or 1/);
  });

  it("地形纪元与建造纪元相互独立：写回只递增地形纪元", () => {
    const world = createGameInstance(buildDef()).world;
    expect(getBuiltStructuresEpoch(world, MAP)).toBe(0);
    setWalkable(world, MAP, 0, 0);
    expect(getTerrainEpoch(world, MAP)).toBe(1);
    expect(getBuiltStructuresEpoch(world, MAP)).toBe(0);
  });

  it("脏格登记：记录 field/value/tick（显式 callerTick 优先），推完即清", () => {
    const world = createGameInstance(buildDef()).world;
    const tick0 = world.time.tick;

    setGround(world, MAP, 9, 2); // 缺省 callerTick = world.time.tick
    setWalkable(world, MAP, 10, 0, 12345); // 显式 callerTick（补差重放标注形态）
    setGround(world, MAP, 9, 5); // 同格二次写：队列按发生序保留两条终值记录

    const drained = drainDirtyTiles(world);
    expect(drained.size).toBe(1);
    expect(drained.get(MAP)).toEqual([
      { tileIndex: 9, field: "tiles", value: 2, tick: tick0 },
      { tileIndex: 10, field: "walkable", value: 0, tick: 12345 },
      { tileIndex: 9, field: "tiles", value: 5, tick: tick0 },
    ]);

    // 推完即清：二次排空为空（不落盘、不跨消费堆积）
    expect(drainDirtyTiles(world).size).toBe(0);
  });
});

describe("碰撞缓存经地形纪元失效重建", () => {
  it("写回 walkable=0 后实体被新静态体阻挡（复用运行时走重建分支）", () => {
    const world = createGameInstance(buildDef()).world;
    clearEntityMap();
    const eid = spawnTestPlayer(world, 24, 72); // tile (1,4) 中心
    EntityMap[eid] = MAP;
    world.time.dtMs = 50;

    // 写回前 tile (3,4) 可走：两帧推进稳定越过其左缘 x=48
    Velocity.vx[eid] = 300;
    movementSystem(world);
    collisionSystem(world);
    movementSystem(world);
    collisionSystem(world);
    expect(Transform.x[eid]).toBeGreaterThanOrEqual(54);

    // tick 系统调用写回入口改地形 → 地形纪元递增 → 已存在的 0 层运行时
    // 下次访问按新通行位重建静态体
    expect(setWalkable(world, MAP, 4 * 8 + 3, 0)).toBe(true);
    expect(getTerrainEpoch(world, MAP)).toBe(1);

    Transform.x[eid] = 24;
    Velocity.vx[eid] = 300;
    movementSystem(world);
    collisionSystem(world);
    movementSystem(world);
    collisionSystem(world);

    // 墙体 [48,64) 挡住右缘（中心 ≤ 40），且阻挡后速度被清零
    expect(Transform.x[eid]).toBeLessThanOrEqual(40.01);
    expect(Velocity.vx[eid]).toBe(0);
  });
});

describe("合成 tick 系统调用方（全链）", () => {
  it("写回挂进 instance.systems 后 step：当 tick 改地形 + 指纹/纪元/脏格全链生效", () => {
    const instance = createGameInstance(buildDef());
    const world = instance.world;
    const geometry = world.maps[MAP]!;
    const version0 = geometry.version;
    let changed = false;

    // 模拟一个 tick 系统：系统签名 (world) → world，经入口改地形
    instance.systems.push((w) => {
      changed = setGround(w, MAP, 9, 2);
      return w;
    });
    instance.step(50);

    expect(changed).toBe(true);
    expect(geometry.tiles[9]).toBe(2);
    expect(geometry.version).not.toBe(version0);
    expect(getTerrainEpoch(world, MAP)).toBe(1);
    const drained = drainDirtyTiles(world);
    // 脏格记录的 tick = 写回发生时的逻辑帧（step 内 tick 自增后的当帧）
    expect(drained.get(MAP)).toEqual([{ tileIndex: 9, field: "tiles", value: 2, tick: world.time.tick }]);
  });
});

describe("增量存档（出厂底板 diff + 读档叠加）", () => {
  it("改 3 格 → 存（delta 条目）→ 读档（重算底板+指纹比对+叠加）→ 世界逐位一致；再存档幂等", async () => {
    const sim1 = await createGameSimulation(buildDef(), {
      repository: memoryRepository(null),
      saveId: "wb",
    });
    const world1 = simWorld(sim1);

    // 模拟 tick 系统写回 3 格（2 格地面语义 + 1 格通行位）
    setGround(world1, MAP, 10, 4);
    setGround(world1, MAP, 11, 5);
    setWalkable(world1, MAP, 12, 0);
    const g1 = world1.maps[MAP]!;

    const record = JSON.parse(JSON.stringify(serializeWorld(world1, "wb"))) as WorldRecord;
    // savedAt 拨到未来 → 离线折算为 0（确定性往返，不引入补差）
    record.savedAt = Date.now() + 3_600_000;

    // 存档走了增量格式：稀疏终态修改项 + 出厂底板指纹
    const entry = record.maps![MAP] as SerializedMapDelta;
    expect(entry.format).toBe("delta");
    expect(entry.key).toBe(MAP);
    expect(entry.baseVersion).toBe(terrainBaselineOf(world1, MAP)!.version);
    expect(entry.modifications).toEqual([
      { tileIndex: 10, field: "tiles", value: 4 },
      { tileIndex: 11, field: "tiles", value: 5 },
      { tileIndex: 12, field: "walkable", value: 0 },
    ]);

    const sim2 = await createGameSimulation(buildDef(), {
      repository: memoryRepository(record),
      saveId: "wb",
    });
    const world2 = simWorld(sim2);
    const g2 = world2.maps[MAP]!;

    // 等价性：读档叠加后的几何与存档前逐位一致（含指纹）
    expect(g2.tiles).toEqual(g1.tiles);
    expect(g2.walkable).toEqual(g1.walkable);
    expect(g2.level).toEqual(g1.level);
    expect(g2.regionOfTile).toEqual(g1.regionOfTile);
    expect(g2.regions).toEqual(g1.regions);
    expect(g2.version).toBe(g1.version);
    expect(world2.time.tick).toBe(world1.time.tick);

    // 幂等：读档后的世界（底板已重算登记）再存档产出同一增量条目
    const record2 = JSON.parse(JSON.stringify(serializeWorld(world2, "wb"))) as WorldRecord;
    expect(record2.maps![MAP]).toEqual(entry);
  });

  it("修改数 ≤10% 走增量、>10% 降级全量；全量条目读档逐字节还原", async () => {
    const world = createGameInstance(buildDef()).world;

    // 64 格改 6 格（9.4% ≤ 10%）→ 增量
    for (let i = 0; i < 6; i++) {
      setWalkable(world, MAP, i, 0);
    }
    const deltaRecord = serializeWorld(world, "wb") as WorldRecord;
    expect((deltaRecord.maps![MAP] as SerializedMapDelta).format).toBe("delta");

    // 第 7 格（10.9% > 10%）→ 降级为现行全量格式
    setWalkable(world, MAP, 8, 0);
    const fullRecord = JSON.parse(JSON.stringify(serializeWorld(world, "wb"))) as WorldRecord;
    const fullEntry = fullRecord.maps![MAP] as SerializedMapGeometry;
    expect("format" in fullRecord.maps![MAP]).toBe(false);
    expect(fullEntry.walkable[8]).toBe(0);
    expect(Array.from(fullEntry.walkable)).toEqual(Array.from(world.maps[MAP]!.walkable));

    // 全量条目读档逐字节还原（现行读档契约不变）
    fullRecord.savedAt = Date.now() + 3_600_000;
    const sim = await createGameSimulation(buildDef(), {
      repository: memoryRepository(fullRecord),
      saveId: "wb",
    });
    expect(serializeGeometry(simWorld(sim).maps[MAP]!)).toEqual(fullEntry);
  });

  it("底板指纹不匹配 → 拒绝读档（配置/种子漂移显式报错）", async () => {
    const world = createGameInstance(buildDef()).world;
    setGround(world, MAP, 0, 3);
    const record = JSON.parse(JSON.stringify(serializeWorld(world, "wb"))) as WorldRecord;
    (record.maps![MAP] as SerializedMapDelta).baseVersion = "deadbeef";

    await expect(
      createGameSimulation(buildDef(), { repository: memoryRepository(record), saveId: "wb" }),
    ).rejects.toThrow(/wb-map.*baseVersion "deadbeef"/);
  });

  it("畸形修改项 → 拒绝读档（越界索引/非法值域，绝不静默加载）", async () => {
    const world = createGameInstance(buildDef()).world;
    setGround(world, MAP, 0, 3);
    const record = JSON.parse(JSON.stringify(serializeWorld(world, "wb"))) as WorldRecord;

    const outOfRange = record.maps![MAP] as SerializedMapDelta;
    outOfRange.modifications = [{ tileIndex: 999, field: "walkable", value: 0 }];
    await expect(
      createGameSimulation(buildDef(), { repository: memoryRepository(record), saveId: "wb" }),
    ).rejects.toThrow(/tileIndex out of range/);

    const badValue = (JSON.parse(JSON.stringify(record)) as WorldRecord).maps![MAP] as SerializedMapDelta;
    badValue.modifications = [{ tileIndex: 0, field: "walkable", value: 2 }];
    await expect(
      createGameSimulation(buildDef(), { repository: memoryRepository({ ...record, maps: { [MAP]: badValue } }), saveId: "wb" }),
    ).rejects.toThrow(/walkable value must be 0 or 1/);
  });
});
