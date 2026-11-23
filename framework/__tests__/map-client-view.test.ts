/**
 * CC-05 地图客户端视图测试（框架层，不启 HTTP）。
 *
 * 覆盖：
 * - `/maps/render` 的 tiles 与 effectiveGroundAt 逐格一致（相位/进度/覆盖规则同源）；
 * - renderVersion 的稳定性与失效条件（同输入恒定；底板版本/相位变化即变）；
 * - `/maps/collision`：walkableAtLevel（含楼板让不可走格可站）+ 建造物占用，
 *   实体只暴露 networkId（绝无 eid）；
 * - `Space.exposure` netSync 派生键：玩家进入围合+有顶房间 → indoor，离开 → outdoor；
 * - `PlayerState.mapVersion`：applySnapshot 写入当前图版本，换图后立即变化；
 * - schema 字段顺序：mapVersion 及其后的 CC-10 资料字段追加在末尾；
 * - `/world/map-graph`：presentation 展示名/连接 + registry 兜底。
 */
import { readFileSync } from "node:fs";

import { addComponent, addEntity, query } from "bitecs";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  bootstrapFramework,
  createDefaultGameDefinition,
  createGameInstance,
  createGameSimulation,
  EnvironmentRuleSchema,
  effectiveGroundAt,
  setGround,
  setLevel,
  setWalkable,
  type EnvironmentRule,
  type SimulationPort,
} from "framework/index";
import {
  registerTerrainBaseline,
  terrainModificationsSince,
} from "map/runtime/terrainWriteback";
import { clearPresentation, loadPresentation } from "framework/content/presentation";
import type { LoadedGameDefinition } from "framework/config/schema/GameDefinitionSchema";
import { Transform } from "framework/components/transform";
import { EntityMap, entityMapOf } from "framework/components/entityMap";
import { EntityLevel, entityLevelOf } from "framework/components/entityLevel";
import { NetworkId } from "framework/components/network";
import { Kind } from "framework/components/kind";
import { GridOccupancy } from "framework/components/gridOccupancy";
import { Placeable } from "framework/components/placeable";
import { Collider, ColliderShape } from "framework/components/physics";
import { Player } from "framework/components/tags";
import {
  Structure,
  STRUCTURE_ROLE_FLOOR,
  STRUCTURE_ROLE_WALL,
} from "framework/components/structure";
import { RoomState } from "network/colyseus/state/RoomState";
import { PlayerState } from "network/colyseus/state/PlayerState";
import { GameRoom } from "network/colyseus/rooms/GameRoom";
import type { TickResult } from "simulation/types";
import {
  buildMapCollisionView,
  buildMapRenderView,
  buildWorldMapGraph,
  computeMapRenderVersion,
  quantizePhaseProgress,
} from "map/clientView";
import { makeTestGeometry } from "./helpers/mapGeometry";
import type { GameWorld } from "framework/world";
import type { MapGeometry } from "map/geometry/types";

beforeAll(() => {
  bootstrapFramework();
});

beforeEach(() => {
  // AoS 模块级单例（eid 跨 world 复用）：清残留防跨用例串扰。
  EntityMap.length = 0;
  EntityLevel.length = 0;
  Kind.length = 0;
});

afterEach(() => {
  clearPresentation();
});

/** 构造 8×8 地表全 3（grass）、全可走的测试图。 */
function makeRenderGeometry(): MapGeometry {
  return makeTestGeometry({
    key: "render-map",
    width: 8,
    height: 8,
    tiles: () => 3,
  });
}

/** 两相位环境规则：cold 后段积雪；warm 融雪。 */
const RENDER_RULE: EnvironmentRule = EnvironmentRuleSchema.parse({
  seed: 7,
  weatherSlotTicks: 50,
  phases: [
    { id: "cold", durationTicks: 100 },
    { id: "warm", durationTicks: 100 },
  ],
  groundOverrides: [
    { phaseId: "cold", fromSemantic: 3, toSemantic: 10, minProgress: 0.8 },
    { phaseId: "warm", fromSemantic: 10, toSemantic: 3 },
  ],
});

function createRenderWorld(geometry: MapGeometry, rule?: EnvironmentRule): GameWorld {
  const world = createGameInstance(createDefaultGameDefinition()).world;
  world.maps[geometry.key] = geometry;
  world.activeMaps.add(geometry.key);
  world.defaultMapId = geometry.key;
  if (rule) world.gameDef.resolvedRules["environment"] = rule;
  return world;
}

/** cell 中心像素坐标。 */
const cell = (k: number): number => (k + 0.5) * 16;

/** 手工构造建造物（Transform/NetworkId/Kind + Structure；可选 GridOccupancy 格组）。 */
function spawnStructure(
  world: GameWorld,
  mapId: string,
  options: {
    tx: number;
    ty: number;
    level: number;
    role: number;
    kind: string;
    networkId: number;
    cells?: { x: number; y: number; w: number; h: number };
  },
): number {
  const eid = addEntity(world);
  addComponent(world, eid, Transform);
  addComponent(world, eid, NetworkId);
  addComponent(world, eid, Structure);
  Transform.x[eid] = cell(options.tx);
  Transform.y[eid] = cell(options.ty);
  NetworkId.value[eid] = options.networkId;
  EntityMap[eid] = mapId;
  EntityLevel[eid] = options.level;
  Structure.role[eid] = options.role;
  Kind[eid] = options.kind;
  if (options.cells) {
    addComponent(world, eid, GridOccupancy);
    GridOccupancy.cellX[eid] = options.cells.x;
    GridOccupancy.cellY[eid] = options.cells.y;
    GridOccupancy.cellLevel[eid] = options.level;
    GridOccupancy.cellW[eid] = options.cells.w;
    GridOccupancy.cellH[eid] = options.cells.h;
  } else {
    // eid 槽跨 world 复用：无格组声明时清 0，避免读到上一用例残留。
    GridOccupancy.cellW[eid] = 0;
    GridOccupancy.cellH[eid] = 0;
  }
  return eid;
}

/** 房间 A 的墙环（3×3 周界，L0）+ 顶（(2,2) L1 楼板）。 */
function buildRoom(world: GameWorld, mapId: string, nextNetworkId: number): number {
  let nid = nextNetworkId;
  const ring = (tx: number, ty: number): void => {
    spawnStructure(world, mapId, {
      tx,
      ty,
      level: 0,
      role: STRUCTURE_ROLE_WALL,
      kind: "wall",
      networkId: nid++,
    });
  };
  for (let t = 1; t <= 3; t += 1) {
    ring(t, 1);
    ring(t, 3);
    if (t > 1 && t < 3) {
      ring(1, t);
      ring(3, t);
    }
  }
  spawnStructure(world, mapId, {
    tx: 2,
    ty: 2,
    level: 1,
    role: STRUCTURE_ROLE_FLOOR,
    kind: "floor",
    networkId: nid++,
  });
  return nid;
}

// ─────────────────────────────────────────────────────────────────────────────
describe("① /maps/render：有效地面与版本", () => {
  it("tiles 逐格等于 effectiveGroundAt；相位推进后有效地面与 renderVersion 同步变化", async () => {
    const geometry = makeRenderGeometry();
    const world = createRenderWorld(geometry, RENDER_RULE);

    world.time.tick = 90; // cold, progress 0.9 → 积雪
    const view = buildMapRenderView(world, geometry.key)!;
    expect(view).toBeDefined();
    expect(view.key).toBe(geometry.key);
    expect(view.baseVersion).toBe(geometry.version);
    expect(view.phaseId).toBe("cold");
    expect(view.phaseProgress).toBe(0.9);
    expect(view.tiles).toHaveLength(64);

    // 抽样 + 全量：与 effectiveGroundAt 同源
    for (let y = 0; y < 8; y += 1) {
      for (let x = 0; x < 8; x += 1) {
        expect(view.tiles[y * 8 + x]).toBe(effectiveGroundAt(world, x, y, geometry.key));
      }
    }
    expect(view.tiles[0]).toBe(10);
    // 底板不被改写
    expect(geometry.tiles[0]).toBe(3);

    // 同 tick/同版本 → 稳定；相位切换 → 变化
    expect(buildMapRenderView(world, geometry.key)!.renderVersion).toBe(view.renderVersion);
    world.time.tick = 110; // warm, progress 0.1 → 融雪
    const warm = buildMapRenderView(world, geometry.key)!;
    expect(warm.phaseId).toBe("warm");
    expect(warm.tiles[0]).toBe(3);
    expect(warm.renderVersion).not.toBe(view.renderVersion);
  });

  it("底板写回（baseVersion 变化）使 renderVersion 失效；无规则时有效地面 = 底板", () => {
    const geometry = makeRenderGeometry();
    const world = createRenderWorld(geometry);
    world.time.tick = 50;

    const before = buildMapRenderView(world, geometry.key)!;
    expect(before.phaseId).toBe("");
    expect(before.tiles).toEqual(new Array(64).fill(3));

    setGround(world, geometry.key, 5, 9);
    const after = buildMapRenderView(world, geometry.key)!;
    expect(after.baseVersion).not.toBe(before.baseVersion);
    expect(after.tiles[5]).toBe(9);
    expect(after.renderVersion).not.toBe(before.renderVersion);
  });

  it("地形增量：基线/历史版本 + tiles|walkable|level 三通道终态（last-write-wins）", () => {
    const geometry = makeRenderGeometry();
    const world = createRenderWorld(geometry);
    registerTerrainBaseline(world, geometry.key, geometry);
    const baseVersion = geometry.version;

    setGround(world, geometry.key, 5, 9);
    const v1 = geometry.version;
    expect(v1).not.toBe(baseVersion);
    expect(terrainModificationsSince(world, geometry.key, baseVersion)).toMatchObject({
      baseVersion,
      version: v1,
      modifications: [{ tileIndex: 5, field: "tiles", value: 9 }],
    });

    // 同格再写另两个通道：相对基线按字段序输出三条终态；相对 v1 只输出后两条。
    setWalkable(world, geometry.key, 5, 0);
    setLevel(world, geometry.key, 5, 2);
    const fromBase = terrainModificationsSince(world, geometry.key, baseVersion)!;
    expect(fromBase.modifications).toEqual([
      { tileIndex: 5, field: "tiles", value: 9 },
      { tileIndex: 5, field: "walkable", value: 0 },
      { tileIndex: 5, field: "level", value: 2 },
    ]);
    const fromHistory = terrainModificationsSince(world, geometry.key, v1)!;
    expect(fromHistory.baseVersion).toBe(v1);
    expect(fromHistory.version).toBe(geometry.version);
    expect(fromHistory.modifications).toEqual([
      { tileIndex: 5, field: "walkable", value: 0 },
      { tileIndex: 5, field: "level", value: 2 },
    ]);

    // 未知版本 → undefined（HTTP 层回退全量）。
    expect(terrainModificationsSince(world, geometry.key, "unknown")).toBeUndefined();
  });

  it("renderVersion 输入量化：同 base/phase/进度/tiles 恒同，任一输入变化即变", () => {
    const tiles = [3, 3, 10];
    const version = computeMapRenderVersion("aaaa", "cold", 0.9, tiles);
    expect(version).toMatch(/^[0-9a-f]{8}$/);
    expect(computeMapRenderVersion("aaaa", "cold", 0.9, tiles)).toBe(version);
    expect(computeMapRenderVersion("bbbb", "cold", 0.9, tiles)).not.toBe(version);
    expect(computeMapRenderVersion("aaaa", "warm", 0.9, tiles)).not.toBe(version);
    expect(computeMapRenderVersion("aaaa", "cold", 0.8, tiles)).not.toBe(version);
    expect(computeMapRenderVersion("aaaa", "cold", 0.9, [3, 3, 11])).not.toBe(version);
    // 量化：0.9004 与 0.9 同桶（输入 hash 前先量化）
    expect(quantizePhaseProgress(0.9004)).toBe(0.9);
    expect(computeMapRenderVersion("aaaa", "cold", 0.9004, tiles)).toBe(version);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("② /maps/collision：通行位 + 建造占用", () => {
  it("楼板让不可走格在其层可站；占用实体只用 networkId（无 eid）", () => {
    const geometry = makeTestGeometry({
      key: "collision-map",
      width: 8,
      height: 8,
      blocked: (tx, ty) => tx === 4 && ty === 4,
      tiles: (tx, ty) => (tx === 4 && ty === 4 ? 1 : 3),
    });
    const world = createRenderWorld(geometry);

    // L0 墙（2×1 格占位）+ L1 楼板压在水格 (4,4) 上。
    spawnStructure(world, geometry.key, {
      tx: 2,
      ty: 2,
      level: 0,
      role: STRUCTURE_ROLE_WALL,
      kind: "wall",
      networkId: 501,
      cells: { x: 2, y: 2, w: 2, h: 1 },
    });
    spawnStructure(world, geometry.key, {
      tx: 4,
      ty: 4,
      level: 1,
      role: STRUCTURE_ROLE_FLOOR,
      kind: "floor",
      networkId: 502,
    });

    const level0 = buildMapCollisionView(world, geometry.key, 0)!;
    expect(level0.level).toBe(0);
    expect(level0.grid).toEqual({ width: 8, height: 8, tileWidth: 16, tileHeight: 16 });
    expect(level0.walkable[4 * 8 + 4]).toBe(0); // 地形水格，L0 不可走
    expect(level0.occupants).toHaveLength(1);
    expect(level0.occupants[0]).toMatchObject({
      networkId: 501,
      kind: "wall",
      level: 0,
      role: "wall",
      cells: [2 * 8 + 2, 2 * 8 + 3],
    });
    expect(level0.occupants[0]).not.toHaveProperty("eid");

    const level1 = buildMapCollisionView(world, geometry.key, 1)!;
    expect(level1.walkable[4 * 8 + 4]).toBe(1); // L1 楼板让水上可站
    expect(level1.occupants).toHaveLength(1);
    expect(level1.occupants[0]).toMatchObject({
      networkId: 502,
      kind: "floor",
      level: 1,
      role: "floor",
      cells: [4 * 8 + 4],
    });
    expect(level1.occupants[0]).not.toHaveProperty("eid");
  });

  it("参与碰撞的 Placeable（无 Structure 角色）按墙位占用；canCollide=0 不输出", () => {
    const geometry = makeTestGeometry({ key: "collision-placeable", width: 8, height: 8 });
    const world = createRenderWorld(geometry);

    const spawnPlaceable = (networkId: number, canCollide: number): number => {
      const eid = addEntity(world);
      addComponent(world, eid, Transform);
      addComponent(world, eid, NetworkId);
      addComponent(world, eid, Placeable);
      addComponent(world, eid, Collider);
      Transform.x[eid] = cell(3);
      Transform.y[eid] = cell(3);
      NetworkId.value[eid] = networkId;
      EntityMap[eid] = geometry.key;
      Kind[eid] = "furniture";
      // eid 槽跨 world 复用：清掉上一用例可能残留的格组（本用例不占多格）。
      GridOccupancy.cellW[eid] = 0;
      GridOccupancy.cellH[eid] = 0;
      Placeable.canCollide[eid] = canCollide;
      Placeable.footprintW[eid] = 16;
      Placeable.footprintH[eid] = 16;
      Collider.shape[eid] = ColliderShape.Box;
      Collider.halfW[eid] = 8;
      Collider.halfH[eid] = 8;
      return eid;
    };

    spawnPlaceable(601, 1);
    spawnPlaceable(602, 0);

    const view = buildMapCollisionView(world, geometry.key, 0)!;
    expect(view.occupants.map((o) => o.networkId)).toEqual([601]);
    expect(view.occupants[0]!.role).toBe("wall");
    expect(view.occupants[0]!.cells).toEqual([3 * 8 + 3]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe("③ Space.exposure 与 PlayerState.mapVersion", () => {
  it("玩家在围合+有顶房间 indoor，离开房间 outdoor；mapVersion 随换图变化", async () => {
    const def = createDefaultGameDefinition();
    // 与 game/game.json 末尾同款派生条目（Kind 适配器路径 → Space.exposure）。
    def.netSync!.fields.push({ component: "Kind", tags: ["Player"], fields: ["exposure"] });
    const sim = await createGameSimulation(def);
    const world = simWorld(sim);

    const geometry = makeTestGeometry({ key: "rooms", width: 24, height: 24 });
    world.maps[geometry.key] = geometry;
    world.activeMaps.add(geometry.key);
    world.defaultMapId = geometry.key;
    // 第二张图用于换图后的 mapVersion 断言。
    const other = makeTestGeometry({ key: "rooms-b", width: 8, height: 8, tiles: () => 6 });
    world.maps[other.key] = other;
    world.activeMaps.add(other.key);

    const join = sim.addPlayer("s1");
    const playerEid = query(world, [Player])[0]!;
    expect(entityMapOf(world, playerEid)).toBe("rooms");
    buildRoom(world, geometry.key, 701);
    Transform.x[playerEid] = cell(2);
    Transform.y[playerEid] = cell(2);
    EntityLevel[playerEid] = 0;

    const tick = (): TickResult => sim.tick(50);
    const ownSnapshot = (result: TickResult) => result.snapshot.entities.get(join.networkId)!;

    let result = tick();
    expect(ownSnapshot(result).strings["Space.exposure"]).toBe("indoor");

    // 走到房间外（远处草地，洪泛必然超围合上限）→ outdoor
    Transform.x[playerEid] = cell(12);
    Transform.y[playerEid] = cell(12);
    result = tick();
    expect(ownSnapshot(result).strings["Space.exposure"]).toBe("outdoor");

    // GameRoom.applySnapshot：mapVersion = 当前图几何指纹（非空）
    const room = new GameRoom();
    room.state = new RoomState();
    const playerState = new PlayerState();
    playerState.sessionId = "s1";
    playerState.entityId = join.networkId;
    room.state.players.set("s1", playerState);
    room.clients.push({
      sessionId: "s1",
      send: () => {},
    } as never);

    const access = room as unknown as {
      sim: SimulationPort;
      applySnapshot: (r: TickResult) => void;
    };
    access.sim = sim;
    access.applySnapshot(result);
    expect(playerState.mapId).toBe("rooms");
    expect(playerState.mapVersion).toBe(geometry.version);
    expect(playerState.mapVersion.length).toBeGreaterThan(0);

    // 换图：EntityMap 改为 rooms-b → tick → mapVersion 立即反映新图版本
    EntityMap[playerEid] = other.key;
    result = tick();
    access.applySnapshot(result);
    expect(playerState.mapId).toBe("rooms-b");
    expect(playerState.mapVersion).toBe(other.version);
    expect(playerState.mapVersion).not.toBe(geometry.version);
  });

  it("schema 字段顺序：mapVersion 之后追加 CC-10 资料字段（旧字段索引不变）", () => {
    const source = readFileSync(
      new URL("../net/colyseus/state/PlayerState.ts", import.meta.url),
      "utf8",
    );
    const block = source.slice(source.indexOf("export class PlayerState"));
    const fields = [...block.matchAll(/^\s{2}(\w+)[!?]?:/gm)].map((m) => m[1]);
    const expectedFields = [
      "sessionId",
      "entityId",
      "mapId",
      "visibleEntities",
      "mapVersion",
      "displayName",
      "characterId",
      "appearance",
    ];
    expect(fields).toEqual(expectedFields);

    const generated = readFileSync(
      new URL("../../src/network/colyseus/client-schema/schema.ts", import.meta.url),
      "utf8",
    );
    const generatedStart = generated.indexOf("export class PlayerState");
    const generatedBlock = generated.slice(
      generatedStart,
      generated.indexOf("export class RoomState", generatedStart),
    );
    const generatedFields = [...generatedBlock.matchAll(/public\s+(\w+)\s*[!?:]/g)].map((m) => m[1]);
    expect(generatedFields).toEqual(expectedFields);

    const state = new PlayerState();
    expect(state.mapVersion).toBe("");
    expect([state.displayName, state.characterId, state.appearance]).toEqual(["", "", ""]);
  });
});

/** 取仿真内部 GameWorld（与既有 GameRoom 测试同款私有访问器）。 */
function simWorld(sim: SimulationPort): GameWorld {
  return (sim as unknown as { world: GameWorld }).world;
}

// ─────────────────────────────────────────────────────────────────────────────
describe("④ /world/map-graph", () => {
  it("presentation 提供 displayName/connections；无 presentation 时回退 registry id", () => {
    const gameDef = {
      resolvedMapConfigs: [{ key: "a" }, { key: "b" }],
    } as unknown as LoadedGameDefinition;

    loadPresentation({
      tileSemantics: {},
      maps: {
        a: {
          displayName: "甲岛",
          connections: [{ to: "b", kind: "portal", x: 3, y: 4 }],
        },
      },
    });
    expect(buildWorldMapGraph(gameDef)).toEqual({
      maps: [
        {
          id: "a",
          displayName: "甲岛",
          connections: [{ to: "b", kind: "portal", x: 3, y: 4 }],
        },
        { id: "b", displayName: "b", connections: [] },
      ],
    });

    clearPresentation();
    expect(buildWorldMapGraph(gameDef)).toEqual({
      maps: [
        { id: "a", displayName: "a", connections: [] },
        { id: "b", displayName: "b", connections: [] },
      ],
    });
  });
});
