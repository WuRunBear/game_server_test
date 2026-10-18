/**
 * 完整性审计批次 B1 回归测试（F-05 / F-18 / F-19）。
 *
 * - F-05 楼层支撑：走出楼板边缘自然下落、站在楼板上不下落、拆楼板下一 tick
 *   下落、楼板在头顶不抬升实体；slope 既有语义零回归；
 * - F-18 template 锚点跨区域：锚点/占用格落出 rule.region 的候选整组跳过，
 *   分段多次 evolve 不会跨调用无界补种；正常模板零回归；
 * - F-19 采集溢出物：部分入包后的剩余落在资源节点附近（确定性小幅散布），
 *   不再落到地图原点；不可走时回退到节点/采集者所在格。
 *
 * 几何全部手工确定性 MapGeometry（tile 16px），像素按格中心 (k+0.5)·16 计算。
 */
import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { addComponent, addEntity, query, removeEntity } from "bitecs";

import { bootstrapFramework, createGameInstance, createDefaultGameDefinition } from "framework/index";
import { Transform } from "framework/components/transform";
import { EntityMap, entityMapOf } from "framework/components/entityMap";
import { EntityLevel, entityLevelOf } from "framework/components/entityLevel";
import { Structure, STRUCTURE_ROLE_FLOOR } from "framework/components/structure";
import { NetworkId } from "framework/components/network";
import { Player, Resource, Item } from "framework/components/tags";
import { Inventory, type InventoryEntry } from "framework/components/inventory";
import { ResourceNode } from "framework/components/resourceNode";
import { entityLevelSystem, resolveEntityLevel } from "framework/systems/core/entityLevelSystem";
import { harvest, harvestDropPosition } from "framework/systems/gameplay/gatheringSystem";
import { createGameWorld, type GameWorld } from "framework/world";
import { regionOf, walkableAt, walkableAtLevel } from "map/geometry/query";
import { evolve, type EvolutionDeps } from "map/evolution/engine";
import { makeTestGeometry } from "./helpers/mapGeometry";
import type { MapGeometry } from "map/geometry/types";
import type { EntityRule } from "map/evolution/schema";

beforeAll(() => {
  bootstrapFramework();
});

/** AoS 模块级单例清残留（EntityMap/EntityLevel 跨 world 复用 eid，防跨用例串扰）。 */
beforeEach(() => {
  for (let i = 0; i < EntityMap.length; i++) EntityMap[i] = undefined;
  for (let i = 0; i < EntityLevel.length; i++) EntityLevel[i] = undefined;
});

/** 格中心像素坐标。 */
const cell = (k: number): number => (k + 0.5) * 16;

function createBareWorld(): GameWorld {
  return createGameInstance(createDefaultGameDefinition()).world;
}

/** 挂一张全可走测试图。 */
function attachFlatMap(world: GameWorld, id: string, options: { width?: number; height?: number } = {}): MapGeometry {
  const geometry = makeTestGeometry({ key: id, width: options.width ?? 16, height: options.height ?? 16 });
  world.maps[id] = geometry;
  world.activeMaps.add(id);
  world.defaultMapId = id;
  return geometry;
}

/** 手工实体（Transform + 归属图）。 */
function spawnAt(world: GameWorld, x: number, y: number, mapId: string): number {
  const eid = addEntity(world);
  addComponent(world, eid, Transform);
  Transform.x[eid] = x;
  Transform.y[eid] = y;
  EntityMap[eid] = mapId;
  return eid;
}

/** 手工楼板实体（Structure role=floor，层号显式写入）。 */
function addFloor(world: GameWorld, mapId: string, level: number, tx: number, ty: number): number {
  const eid = spawnAt(world, cell(tx), cell(ty), mapId);
  addComponent(world, eid, Structure);
  Structure.role[eid] = STRUCTURE_ROLE_FLOOR;
  EntityLevel[eid] = level;
  return eid;
}

// ——————————————————————————————————————————————————————————————
// F-05：楼层支撑判定
// ——————————————————————————————————————————————————————————————

describe("B1-a / F-05 楼层支撑：走出楼板边缘自然下落", () => {
  it("站在楼板上不下落；走出楼板边缘下一 tick 落到地形层", () => {
    const world = createBareWorld();
    attachFlatMap(world, "f05-edge");
    addFloor(world, "f05-edge", 1, 3, 2);
    const eid = spawnAt(world, cell(3), cell(2), "f05-edge");
    EntityLevel[eid] = 1; // 已在楼板上（如经楼梯上来）

    // 连续多 tick：楼板提供站立面，不回落
    for (let i = 0; i < 8; i++) entityLevelSystem(world);
    expect(entityLevelOf(eid)).toBe(1);

    // 走出楼板边缘到无楼板格 → 自然下落到地形层 0
    Transform.x[eid] = cell(6);
    entityLevelSystem(world);
    expect(entityLevelOf(eid)).toBe(0);
  });

  it("楼板被拆除后，站在上面的实体下一 tick 下落", () => {
    const world = createBareWorld();
    attachFlatMap(world, "f05-remove");
    const floor = addFloor(world, "f05-remove", 1, 5, 4);
    const eid = spawnAt(world, cell(5), cell(4), "f05-remove");
    EntityLevel[eid] = 1;

    entityLevelSystem(world);
    expect(entityLevelOf(eid)).toBe(1);

    removeEntity(world, floor);
    entityLevelSystem(world);
    expect(entityLevelOf(eid)).toBe(0);
  });

  it("头顶楼板不抬升楼下实体（只向下落，不向上掉）", () => {
    const world = createBareWorld();
    attachFlatMap(world, "f05-above");
    addFloor(world, "f05-above", 1, 4, 4);
    const eid = spawnAt(world, cell(4), cell(4), "f05-above");
    EntityLevel[eid] = 0; // 站在楼板下方地面

    entityLevelSystem(world);
    expect(entityLevelOf(eid)).toBe(0);
  });

  it("多层层高：从更高层走出边缘停到下方最近支撑面", () => {
    const world = createBareWorld();
    attachFlatMap(world, "f05-multi");
    addFloor(world, "f05-multi", 1, 4, 4);
    const eid = spawnAt(world, cell(4), cell(4), "f05-multi");
    EntityLevel[eid] = 3; // 三层（该格只有 L1 楼板）

    entityLevelSystem(world);
    expect(entityLevelOf(eid)).toBe(1); // 落到下方最高楼板，而非直接地形 0
  });
});

describe("B1-a / F-05 slope 语义零回归", () => {
  /** 坡道图（12×8，行 0-3 L0、行 4-7 L1，行 3/4 为 slope 语义格）。 */
  function makeSlopeMap(): MapGeometry {
    return makeTestGeometry({
      key: "f05-slope",
      width: 12,
      height: 8,
      tiles: (_tx, ty) => (ty === 3 || ty === 4 ? 7 : 0),
      levels: (_tx, ty) => (ty >= 4 ? 1 : 0),
      levelSemantics: { slope: 7, cliff: 8 },
    });
  }

  it("沿 slope 上行/下行仍按格中心越过切换，不被支撑判定打断", () => {
    const slope = makeSlopeMap();
    // 行 3 与行 4 交界：越过行 4 中心（y=72）才切换
    expect(resolveEntityLevel(slope, 88, 71.9, 0)).toBe(0);
    expect(resolveEntityLevel(slope, 88, 72.1, 0)).toBe(1);
    expect(resolveEntityLevel(slope, 88, 71.9, 1)).toBe(0);
    expect(resolveEntityLevel(slope, 88, 80, 1)).toBe(1);
  });

  it("无坡道标记的层差仍拒绝上行（不因支撑判定放行）", () => {
    const bare = makeTestGeometry({
      key: "f05-bare",
      width: 12,
      height: 8,
      levels: (_tx, ty) => (ty >= 4 ? 1 : 0),
      levelSemantics: { slope: 7, cliff: 8 },
    });
    expect(resolveEntityLevel(bare, 88, 72.1, 0)).toBe(0);
    expect(resolveEntityLevel(bare, 88, 96, 0)).toBe(0);
  });
});

// ——————————————————————————————————————————————————————————————
// F-18：template 锚点跨区域计数
// ——————————————————————————————————————————————————————————————

interface RegionSpawn {
  kind: string;
  x: number;
  y: number;
}

/**
 * 区域感知假 deps：countByKind 按实体中心格的 regionOf 计数（与真实
 * evolveDeps 同语义），canPlace 只查可走 + 占用（单格）。
 */
function makeRegionHarness(geometry: MapGeometry, seed: number) {
  const spawns: RegionSpawn[] = [];
  const occupied = new Set<string>();
  const deps: EvolutionDeps = {
    seed,
    countByKind: (mapKey, region, kind) => {
      if (mapKey !== geometry.key) return 0;
      return spawns.filter((s) => s.kind === kind && regionOf(geometry, s.x, s.y) === region).length;
    },
    canPlace: (mapKey, _kind, x, y) => {
      if (mapKey !== geometry.key) return false;
      return walkableAt(geometry, x, y) && !occupied.has(`${x},${y}`);
    },
    spawn: (kind, _mapKey, x, y) => {
      spawns.push({ kind, x, y });
      occupied.add(`${x},${y}`);
    },
  };
  return { deps, spawns };
}

describe("B1-b / F-18 template 锚点跨区域：候选整组跳过，计数不再无界", () => {
  /**
   * 贴边区域：region "edge" 只含第 2 列（x=2），模板锚点 tree 偏移 dx=1
   * （落在 x=3 的 plain 区域）、伴生 rock 偏移 dx=0（仍在 edge）。旧实现只
   * 校验可走，锚点永远落出区域 → countByKind(edge, tree) 恒 0 → 每个
   * timeSlot 反复补种（跨调用无界）。修复后整组跳过。
   */
  function makeEdgeGeometry(): MapGeometry {
    return makeTestGeometry({
      key: "f18-edge",
      width: 6,
      height: 6,
      regions: ["plain", "edge"],
      regionOfTile: (tx) => (tx === 2 ? 1 : 0),
    });
  }

  it("锚点落出 rule.region：所有候选被跳过，跨分段 evolve 也无跨区生成", () => {
    const geometry = makeEdgeGeometry();
    const { deps, spawns } = makeRegionHarness(geometry, 42);
    const rule: EntityRule = {
      map: geometry.key,
      region: "edge",
      kind: "tree",
      max: 2,
      every: 5,
      mode: "template",
      template: [
        { kind: "tree", dx: 1, dy: 0 },
        { kind: "rock", dx: 0, dy: 0 },
      ],
    };

    // 分段多次 evolve（跨调用计数）——旧实现每段都会补种
    for (let from = 0; from < 100; from += 5) {
      evolve(createGameWorld(50), geometry, [rule], from, from + 5, deps);
    }

    expect(spawns).toEqual([]);
    expect(spawns.filter((s) => s.kind === "tree").length).toBeLessThanOrEqual(rule.max);
  });

  it("正常模板零回归：全部占用格都在区域内 → 按 max 封顶成组创建", () => {
    const geometry = makeTestGeometry({ key: "f18-normal", width: 8, height: 8 });
    const { deps, spawns } = makeRegionHarness(geometry, 7);
    const rule: EntityRule = {
      map: geometry.key,
      region: "default",
      kind: "tree",
      max: 2,
      every: 5,
      mode: "template",
      template: [
        { kind: "tree", dx: 0, dy: 0 },
        { kind: "rock", dx: 1, dy: 0 },
      ],
    };

    evolve(createGameWorld(50), geometry, [rule], 0, 100, deps);

    expect(spawns.filter((s) => s.kind === "tree")).toHaveLength(2);
    expect(spawns.filter((s) => s.kind === "rock")).toHaveLength(2);
    for (const s of spawns) {
      expect(regionOf(geometry, s.x, s.y)).toBe("default");
    }
  });
});

// ——————————————————————————————————————————————————————————————
// F-19：采集溢出物落点
// ——————————————————————————————————————————————————————————————

interface HarvestFixture {
  world: GameWorld;
  player: number;
  node: number;
}

/** 满包边界 fixture：背包 2 格，槽 0 已满；节点一次产 2 → 部分入包后溢出 1。 */
function makeHarvestFixture(map?: MapGeometry): HarvestFixture {
  const world = createBareWorld();
  const geometry = map ?? makeTestGeometry({ key: "f19-drop", width: 8, height: 8 });
  world.maps[geometry.key] = geometry;
  world.activeMaps.add(geometry.key);
  world.defaultMapId = geometry.key;
  world.gameDef.itemsByKind!.set("k1", { kind: "k1", maxStack: 1 });

  const player = spawnAt(world, cell(2), cell(2), world.defaultMapId);
  addComponent(world, player, NetworkId);
  addComponent(world, player, Player);
  NetworkId.value[player] = world.nextNetworkId++;
  Inventory[player] = {
    capacity: 2,
    slots: [{ kind: "k1", count: 1 }, null],
  } as InventoryEntry;
  EntityLevel[player] = 0;

  const node = spawnAt(world, cell(5), cell(2), world.defaultMapId);
  addComponent(world, node, NetworkId);
  addComponent(world, node, Resource);
  NetworkId.value[node] = world.nextNetworkId++;
  ResourceNode[node] = {
    remaining: 5,
    max: 5,
    amountPerHit: 2,
    regenMs: 0,
    yieldsKind: "k1",
    directConsume: false,
    depletedSinceMs: null,
  };
  EntityLevel[node] = 0;

  return { world, player, node };
}

describe("B1-c / F-19 采集溢出物落在节点附近", () => {
  it("部分入包：掉落物出现在节点附近（4~12px），不再落到 (0,0)", () => {
    const { world, player, node } = makeHarvestFixture();

    expect(harvest(world, player, node)).toBe(true);
    const items = query(world, [Item]);
    expect(items).toHaveLength(1);
    const item = items[0]!;
    const nodeX = Transform.x[node];
    const nodeY = Transform.y[node];
    const dist = Math.hypot(Transform.x[item] - nodeX, Transform.y[item] - nodeY);

    expect(Transform.x[item]).not.toBe(0);
    expect(Transform.y[item]).not.toBe(0);
    expect(dist).toBeGreaterThanOrEqual(4);
    expect(dist).toBeLessThanOrEqual(12 + 1e-6);
    expect(dist).toBeLessThan(24); // 远小于旧 16~24px 丢弃散布 + 原点偏移
    expect(entityMapOf(world, item)).toBe(world.defaultMapId);
  });

  it("确定性：同 tick/采集者/节点重复求落点结果一致", () => {
    const { world, player, node } = makeHarvestFixture();
    const first = harvestDropPosition(world, player, node, "k1");
    const second = harvestDropPosition(world, player, node, "k1");
    expect(second).toEqual(first);

    expect(harvest(world, player, node)).toBe(true);
    const item = query(world, [Item])[0]!;
    // Transform 是 f32：与 JS 双精度计算值按精度比较
    expect(Transform.x[item]).toBeCloseTo(first.x, 4);
    expect(Transform.y[item]).toBeCloseTo(first.y, 4);
  });

  it("散布落点不可走时回退到节点所在格（不落到不可走格）", () => {
    // 只保留节点格 (5,2) 可走：散布若越出该格必须回退到节点格中心
    const island = makeTestGeometry({
      key: "f19-island",
      width: 8,
      height: 8,
      blocked: (tx, ty) => !(tx === 5 && ty === 2),
    });
    const { world, player, node } = makeHarvestFixture(island);
    const geometry = world.maps[island.key]!;

    for (let tick = 0; tick < 12; tick++) {
      world.time.tick = tick;
      const drop = harvestDropPosition(world, player, node, "k1");
      const tx = Math.floor(drop.x / geometry.grid.tileWidth);
      const ty = Math.floor(drop.y / geometry.grid.tileHeight);
      expect(walkableAtLevel(geometry, tx, ty, 0)).toBe(true);
      expect(tx).toBe(5);
      expect(ty).toBe(2);
    }
  });

  it("节点与采集者所在格都不可走时落到最近可走格", () => {
    // 只有 (6,2) 可走；节点在 (5,2)、采集者在 (2,2)
    const island = makeTestGeometry({
      key: "f19-nearest",
      width: 8,
      height: 8,
      blocked: (tx, ty) => !(tx === 6 && ty === 2),
    });
    const { world, player, node } = makeHarvestFixture(island);
    const drop = harvestDropPosition(world, player, node, "k1");
    expect(Math.floor(drop.x / 16)).toBe(6);
    expect(Math.floor(drop.y / 16)).toBe(2);
    expect(drop.x).not.toBe(0);
    expect(drop.y).not.toBe(0);
  });
});
