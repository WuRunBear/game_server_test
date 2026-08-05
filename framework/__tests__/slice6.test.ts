import { describe, it, expect, beforeAll } from "vitest";
import { addComponent, addEntity, query } from "bitecs";
import {
  bootstrapFramework,
  createGameInstance,
  createGameSimulation,
  createDefaultGameDefinition,
  loadGameDefinition,
  spawnEntity,
  getRegistries,
  setWorldMap,
  enterMap,
  serializeWorld,
} from "framework/index";
import { Transform } from "framework/components/transform";
import { Velocity, Collider, ColliderShape } from "framework/components/physics";
import { Health, Team } from "framework/components/combat";
import { NetworkId } from "framework/components/network";
import { Player } from "framework/components/tags";
import { Placeable } from "framework/components/placeable";
import { GridOccupancy } from "framework/components/gridOccupancy";
import { Portal } from "framework/components/portal";
import { ItemMeta } from "framework/components/itemMeta";
import { Inventory } from "framework/components/inventory";
import { Kind } from "framework/components/kind";
import { Size } from "framework/components/size";
import { placeEntity } from "framework/systems/gameplay/placeableSystem";
import { deconstructEntity } from "framework/systems/gameplay/deconstructSystem";
import { portalSystem } from "framework/systems/gameplay/portalSystem";
import { collisionSystem } from "framework/systems/core/collisionSystem";
import { movementSystem } from "framework/systems/core/movementSystem";
import { spawningSystem } from "framework/systems/gameplay/spawningSystem";
import { setEntityKind } from "framework/systems/gameplay/aiSystem";
import type { GameWorld } from "framework/world";
import type { ItemKindSpec } from "framework/config/schema/ItemKindSchema";

beforeAll(() => {
  bootstrapFramework();
});

/** 构造一个最小世界（默认配置，无依赖具体 game 配置内容）。 */
function createBareWorld(): GameWorld {
  return createGameInstance(createDefaultGameDefinition()).world;
}

function setItemKind(world: GameWorld, spec: ItemKindSpec): void {
  world.gameDef.itemsByKind!.set(spec.kind, spec);
}

function setPlaceRule(world: GameWorld, rule: { placeRange?: number; gridSnap?: boolean }): void {
  world.gameDef.resolvedRules["place"] = rule;
}

/** 注册测试原型（全局注册表单例，跨用例重复注册会抛错 → 已存在则跳过）。 */
function ensureArchetype(world: GameWorld, spec: Parameters<typeof world.archetypes.register>[0]): void {
  if (!world.archetypes.has(spec.kind)) {
    world.archetypes.register(spec);
  }
}

/** 给裸 world 挂一块 8×8 测试地图（128×128 像素，含 zone 1）。 */
function attachTestMap(world: GameWorld, id = "test"): void {
  world.map = {
    id,
    name: id,
    grid: { width: 8, height: 8, tileWidth: 16, tileHeight: 16 },
    blocked: new Uint8Array(64),
    spawns: { player: { x: 64, y: 64 }, npcs: [] },
    zones: [
      {
        id: 1,
        name: "z1",
        polygon: [
          { x: 0, y: 0 },
          { x: 128, y: 0 },
          { x: 128, y: 128 },
          { x: 0, y: 128 },
        ],
      },
    ],
  };
}

/** 挂两张生成图（a/b），供 setWorldMap/enterMap/portal 测试。 */
function attachTwoMaps(world: GameWorld): void {
  world.gameDef.resolvedMapSources = {
    a: {
      kind: "generated", generatorId: "simple", id: "a", name: "a",
      seed: 1, width: 8, height: 8, tileWidth: 16, tileHeight: 16,
    },
    b: {
      kind: "generated", generatorId: "simple", id: "b", name: "b",
      seed: 2, width: 8, height: 8, tileWidth: 16, tileHeight: 16,
    },
  };
  world.map = undefined;
}

interface PlayerOpts {
  x?: number; y?: number; hp?: number; capacity?: number; team?: number;
}

function spawnTestPlayer(world: GameWorld, opts: PlayerOpts = {}): number {
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
  Health.current[eid] = opts.hp ?? 100;
  Health.max[eid] = 100;
  Team.id[eid] = opts.team ?? 1;
  Collider.shape[eid] = ColliderShape.Box;
  Collider.halfW[eid] = 8;
  Collider.halfH[eid] = 8;
  Size.w[eid] = 16;
  Size.h[eid] = 16;
  Inventory[eid] = {
    capacity: opts.capacity ?? 4,
    slots: Array.from({ length: opts.capacity ?? 4 }, () => null),
  };
  NetworkId.value[eid] = world.nextNetworkId++;
  setEntityKind(world, eid, "test-player");
  return eid;
}

/** 注册可放置原型 plc（Placeable + GridOccupancy，16×16）+ 放置物品 k1。 */
function setupGridPlaceable(world: GameWorld): void {
  ensureArchetype(world, {
    kind: "plc",
    components: {
      Size: { w: 16, h: 16 },
      Collider: { shape: 1, halfW: 8, halfH: 8 },
      Placeable: { footprintW: 16, footprintH: 16, canCollide: 1 },
      GridOccupancy: {},
    },
  });
  setItemKind(world, { kind: "k1", maxStack: 1, place: { archetype: "plc" } });
}

/** 给玩家背包 slot 塞物品。 */
function giveItem(world: GameWorld, eid: number, kind: string, count = 1, slot = 0): void {
  Inventory[eid]!.slots[slot] = { kind, count };
}

function networkIdOf(world: GameWorld, eid: number): number {
  return NetworkId.value[eid];
}

describe("Slice 6：网格对齐与 GridOccupancy", () => {
  it("gridSnap 缺省（off）：任意坐标放置，不写格组（旧行为）", () => {
    const world = createBareWorld();
    attachTestMap(world);
    setupGridPlaceable(world);
    const player = spawnTestPlayer(world, { x: 0, y: 0 });
    giveItem(world, player, "k1");

    expect(placeEntity(world, player, 0, 30, 0)).toBe(true);
    const placed = query(world, [Placeable])[0];
    expect(Transform.x[placed]).toBe(30);
    // 未开启 gridSnap：格组不写（占位 0×0 不参与占用判定）
    expect(GridOccupancy.cellW[placed]).toBe(0);
    expect(Placeable.ownerNetworkId[placed]).toBe(networkIdOf(world, player));
  });

  it("gridSnap on：对齐到格线中心 + 写入格组", () => {
    const world = createBareWorld();
    attachTestMap(world);
    setupGridPlaceable(world);
    setPlaceRule(world, { placeRange: 64, gridSnap: true });
    const player = spawnTestPlayer(world, { x: 0, y: 0 });
    giveItem(world, player, "k1");

    // 16×16 占位 = 1 格；目标 (30, 0) → 格 (1, 0) → 中心 (24, 8)
    expect(placeEntity(world, player, 0, 30, 0)).toBe(true);
    const placed = query(world, [Placeable])[0];
    expect(Transform.x[placed]).toBe(24);
    expect(Transform.y[placed]).toBe(8);
    expect(GridOccupancy.cellX[placed]).toBe(1);
    expect(GridOccupancy.cellY[placed]).toBe(0);
    expect(GridOccupancy.cellW[placed]).toBe(1);
    expect(GridOccupancy.cellH[placed]).toBe(1);
  });

  it("gridSnap on：同格重放被拒；相邻格（无缝拼接）允许", () => {
    const world = createBareWorld();
    attachTestMap(world);
    setupGridPlaceable(world);
    setPlaceRule(world, { placeRange: 128, gridSnap: true });
    const player = spawnTestPlayer(world, { x: 0, y: 0 });

    giveItem(world, player, "k1");
    expect(placeEntity(world, player, 0, 24, 8)).toBe(true);

    giveItem(world, player, "k1");
    expect(placeEntity(world, player, 0, 25, 7)).toBe(false); // 同格重放

    giveItem(world, player, "k1");
    expect(placeEntity(world, player, 0, 40, 8)).toBe(true); // 相邻格
    const placed = query(world, [Placeable]);
    expect(placed.length).toBe(2);
    expect(GridOccupancy.cellX[placed[0]]).not.toBe(GridOccupancy.cellX[placed[1]]);
  });
});

describe("Slice 6：静态碰撞（墙不被推走）", () => {
  it("无 Velocity 实体注册静态体：玩家被墙阻挡，墙位置不动", () => {
    const world = createBareWorld();
    attachTestMap(world);
    ensureArchetype(world, {
      kind: "wall",
      components: {
        Size: { w: 16, h: 16 },
        Collider: { shape: 1, halfW: 8, halfH: 8 },
        Placeable: { footprintW: 16, footprintH: 16, canCollide: 1 },
      },
    });
    const wall = spawnEntity(world, world.archetypes.get("wall"), getRegistries().componentRegistry, { x: 64, y: 64 });
    const player = spawnTestPlayer(world, { x: 50, y: 64 });

    // 玩家向墙方向移动一帧：50 + 200*0.05 = 60，右缘 68 已压到墙左缘 56
    // （速度不可过快：一帧位移超过半墙厚会让质心越过墙中心，check2d 按质心方向分离）
    Velocity.vx[player] = 200;
    Velocity.vy[player] = 0;
    world.time.dtMs = 50;
    movementSystem(world);
    collisionSystem(world);

    // 玩家被挡在墙左侧（墙半宽 8 → 墙左缘 56），未穿透
    expect(Transform.x[player]).toBeLessThanOrEqual(56.01);
    // 墙未被顶走
    expect(Transform.x[wall]).toBe(64);
    // 玩家 x 方向速度被清零（顶墙抖动抑制）
    expect(Velocity.vx[player]).toBe(0);
  });

  it("动态实体（有 Velocity）互撞仍然分离（动态体互撞回归）", () => {
    const world = createBareWorld();
    attachTestMap(world);
    const a = spawnTestPlayer(world, { x: 40, y: 64 });
    const b = spawnTestPlayer(world, { x: 60, y: 64 });
    Velocity.vx[a] = 100;
    world.time.dtMs = 50;
    movementSystem(world);
    collisionSystem(world);
    // 两个动态体互斥分离，坐标互不重叠
    expect(Math.abs(Transform.x[a] - Transform.x[b])).toBeGreaterThanOrEqual(16);
  });
});

describe("Slice 6：deconstruct 拆除（仅放置者可拆）", () => {
  function setupWithPlacedWall(world: GameWorld, x = 16, y = 8): { owner: number; wallEid: number } {
    attachTestMap(world);
    setupGridPlaceable(world);
    const owner = spawnTestPlayer(world, { x: 0, y: 0 });
    giveItem(world, owner, "k1");
    expect(placeEntity(world, owner, 0, x, y)).toBe(true);
    const wallEid = query(world, [Placeable])[0];
    return { owner, wallEid };
  }

  it("范围内可拆（仅放置者）；超距拒；无效 target 拒；非放置者拒；世界物拒", () => {
    const world = createBareWorld();
    // 近墙 (16,8) dist≈17.9 与远墙 (32,8) dist≈33——先放好再收紧范围
    setPlaceRule(world, { placeRange: 64 });
    const { owner, wallEid } = setupWithPlacedWall(world, 16, 8);
    giveItem(world, owner, "k1");
    expect(placeEntity(world, owner, 0, 32, 8)).toBe(true);
    const farWall = query(world, [Placeable]).find((e) => e !== wallEid)!;

    // 超距拒（range 32 < dist 33）
    setPlaceRule(world, { placeRange: 32 });
    expect(deconstructEntity(world, owner, networkIdOf(world, farWall))).toBe(false);
    // 范围内可拆
    expect(deconstructEntity(world, owner, networkIdOf(world, wallEid))).toBe(true);
    expect(query(world, [Placeable]).length).toBe(1);

    // 非放置者拒
    const stranger = spawnTestPlayer(world, { x: 0, y: 5 });
    expect(deconstructEntity(world, stranger, networkIdOf(world, farWall))).toBe(false);
    // 无效 target 拒
    expect(deconstructEntity(world, owner, 999999)).toBe(false);
    // 世界物（owner 0，如地图静态放置物）不可拆
    const worldPlaceable = spawnEntity(world, world.archetypes.get("plc"), getRegistries().componentRegistry, { x: 96, y: 8 });
    Placeable.ownerNetworkId[worldPlaceable] = 0;
    expect(deconstructEntity(world, owner, networkIdOf(world, worldPlaceable))).toBe(false);
  });
});

describe("Slice 6：portal 场景切换", () => {
  it("enterMap：换图 + 清场（保留玩家内容）+ 布置 + 传送玩家", () => {
    const world = createBareWorld();
    attachTwoMaps(world);
    expect(setWorldMap(world, "a")).toBe(true);
    expect(world.map?.id).toBe("a");

    // legacy AoS 数组跨 world 共享：清零 ItemMeta 残留，防 eid 复用误判为玩家内容
    for (let i = 0; i < ItemMeta.length; i++) ItemMeta[i] = undefined;

    const player = spawnTestPlayer(world, { x: 10, y: 10 });
    // 场景实体（无玩家内容组件）
    ensureArchetype(world, { kind: "scn", components: { Size: { w: 16, h: 16 } } });
    const sceneEntity = spawnEntity(world, world.archetypes.get("scn"), getRegistries().componentRegistry, { x: 20, y: 20 });
    // 玩家内容：放置物 + 地面掉落物（ItemMeta 为 AoS 数据，实体须经 spawnEntity 挂组件）
    ensureArchetype(world, {
      kind: "plc2",
      components: { Size: { w: 16, h: 16 }, Placeable: { footprintW: 16, footprintH: 16, canCollide: 1 } },
    });
    const placed = spawnEntity(world, world.archetypes.get("plc2"), getRegistries().componentRegistry, { x: 30, y: 20 });
    const drop = spawnEntity(world, world.archetypes.get("scn"), getRegistries().componentRegistry, { x: 40, y: 20 });
    ItemMeta[drop] = { kind: "x", count: 1, pickupAfterMs: 0 };

    expect(enterMap(world, "b", { x: 99, y: 77 })).toBe(true);
    expect(world.map?.id).toBe("b");

    // 场景实体被清场（eid 可能被 enterMap 布置的新实体复用，按 eid+Kind 联合判定；
    // drop 同为 scn 原型但应保留）
    const sceneStillAlive = query(world, [Transform]).some(
      (e) => e === sceneEntity && Kind[e] === "scn",
    );
    expect(sceneStillAlive).toBe(false);
    // 玩家内容保留
    expect(query(world, [Placeable]).includes(placed)).toBe(true);
    expect(query(world, [Transform]).includes(drop)).toBe(true);
    expect(ItemMeta[drop]).toEqual({ kind: "x", count: 1, pickupAfterMs: 0 });

    // 玩家传送到目标坐标；场景保留实体坐标不变
    expect(Transform.x[player]).toBe(99);
    expect(Transform.y[player]).toBe(77);
    expect(Transform.x[placed]).toBe(30);
  });

  it("portalSystem：玩家与 portal 相交触发切图；目标图无效不触发；不相交不触发", () => {
    const world = createBareWorld();
    attachTwoMaps(world);
    setWorldMap(world, "a");
    const player = spawnTestPlayer(world, { x: 60, y: 60 });
    ensureArchetype(world, {
      kind: "p1",
      components: { Size: { w: 32, h: 32 }, Portal: { targetMap: "b", x: 111, y: 222 } },
    });
    spawnEntity(world, world.archetypes.get("p1"), getRegistries().componentRegistry, { x: 64, y: 64 });

    portalSystem(world);
    expect(world.map?.id).toBe("b");
    expect(Transform.x[player]).toBe(111);
    expect(Transform.y[player]).toBe(222);

    // 目标图无效（未注册）：不切换
    ensureArchetype(world, {
      kind: "p2",
      components: { Size: { w: 32, h: 32 }, Portal: { targetMap: "nope", x: 0, y: 0 } },
    });
    spawnEntity(world, world.archetypes.get("p2"), getRegistries().componentRegistry, { x: 40, y: 40 });
    portalSystem(world);
    expect(world.map?.id).toBe("b");
  });

  it("portalSystem：玩家未接触 portal 不触发", () => {
    const world = createBareWorld();
    attachTwoMaps(world);
    setWorldMap(world, "a");
    const player = spawnTestPlayer(world, { x: 10, y: 10 });
    ensureArchetype(world, {
      kind: "p3",
      components: { Size: { w: 32, h: 32 }, Portal: { targetMap: "b", x: 0, y: 0 } },
    });
    spawnEntity(world, world.archetypes.get("p3"), getRegistries().componentRegistry, { x: 100, y: 100 });
    portalSystem(world);
    expect(world.map?.id).toBe("a");
    expect(Transform.x[player]).toBe(10);
  });

  it("portalSystem：完整 tick 链（movement+collision 分离到接触距离）后仍可触发", () => {
    const world = createBareWorld();
    attachTwoMaps(world);
    setWorldMap(world, "a");
    // 覆盖为无阻挡手工图（生成器随机障碍会干扰碰撞链；resolvedMapSources 保留供 enterMap）
    world.map = {
      id: "a", name: "a",
      grid: { width: 8, height: 8, tileWidth: 16, tileHeight: 16 },
      blocked: new Uint8Array(64),
      spawns: { player: { x: 0, y: 0 }, npcs: [] },
      zones: [],
    };
    // portal 带阻挡 Collider（静态体）：玩家被碰撞系统分离到恰接触距离
    // （|dx| = 8+16 = 24）——接触判定（<=）保证分离后仍触发（严格小于会死锁）
    ensureArchetype(world, {
      kind: "p4",
      components: {
        Size: { w: 32, h: 32 },
        Collider: { shape: 1, halfW: 16, halfH: 16 },
        Portal: { targetMap: "b", x: 111, y: 222 },
      },
    });
    spawnEntity(world, world.archetypes.get("p4"), getRegistries().componentRegistry, { x: 80, y: 64 });
    const player = spawnTestPlayer(world, { x: 20, y: 64 });

    world.time.dtMs = 50;
    for (let i = 0; i < 20; i++) {
      Velocity.vx[player] = 120;
      Velocity.vy[player] = 0;
      movementSystem(world);
      collisionSystem(world);
    }
    // 玩家被挡在 portal 左缘（接触距离 24，恰在 Size 半宽和处）
    expect(Transform.x[player]).toBeGreaterThanOrEqual(56);
    portalSystem(world);
    expect(world.map?.id).toBe("b");
    expect(Transform.x[player]).toBe(111);
    expect(Transform.y[player]).toBe(222);
  });

  it("setWorldMap：重建地图相关缓存（collision/spawning），保留死亡重生标记等无关缓存", () => {
    const world = createBareWorld();
    attachTwoMaps(world);
    setWorldMap(world, "a");
    world.systemRuntimes.set("death", new Map([[1, { untilTick: 100 }]]));
    setWorldMap(world, "b");
    // 地图相关缓存被清（惰性重建于下个 tick）
    expect(world.systemRuntimes.get("collision")).toBeUndefined();
    expect(world.systemRuntimes.get("spawning")).toBeUndefined();
    // 与地图无关的缓存保留
    expect(world.systemRuntimes.get("death")).toBeDefined();
  });

  it("spawningSystem 按 mapId 过滤：只刷当前图规则", () => {
    const world = createBareWorld();
    attachTestMap(world, "a");
    ensureArchetype(world, { kind: "w1", components: {} });
    world.gameDef.resolvedSpawns = [
      { kind: "w1", zoneId: 1, max: 2, respawnMs: 0, mapId: "a" },
      { kind: "w1", zoneId: 1, max: 2, respawnMs: 0, mapId: "b" },
    ];
    world.time.tick = 0;
    world.time.fixedDtMs = 50;
    spawningSystem(world);
    spawningSystem(world);
    // 每 tick 每规则最多刷 1：两 tick 刷满 a 规则 max 2；b 规则始终被过滤
    expect(query(world, [Transform]).length).toBe(2);
    for (const eid of query(world, [Transform])) {
      expect(Kind[eid]).toBe("w1");
    }
  });

  it("serializeWorld 记录 mapId；createGameSimulation 恢复后切回存档图", () => {
    const world = createBareWorld();
    attachTwoMaps(world);
    // 注册 test-player 原型（restoreWorld 按 kind 重建实体）
    ensureArchetype(world, { kind: "test-player", components: {} });
    setWorldMap(world, "a");
    spawnTestPlayer(world, { x: 5, y: 5 });
    const record = serializeWorld(world, "save1");
    expect(record.mapId).toBe("a");

    // 新 world 默认在 b：读档恢复后应切回存档图 a（实体来自存档，不清场）
    const world2 = createBareWorld();
    attachTwoMaps(world2);
    ensureArchetype(world2, { kind: "test-player", components: {} });
    setWorldMap(world2, "b");
    const sim = createGameSimulation(world2.gameDef, { initialRecord: record });
    const simWorld = (sim as unknown as { world: GameWorld }).world;
    expect(simWorld.map?.id).toBe("a");
    expect(query(simWorld, [NetworkId]).length).toBe(1);
  });
});

describe("Slice 6：真实 game 配置集成", () => {
  it("合成 wall_kit → gridSnap 放置 → 拆除 → 死亡窗口拒绝 全链路", () => {
    const def = loadGameDefinition({ gameJsonPath: "game/game.json" });
    const sim = createGameSimulation(def);
    const world = (sim as unknown as { world: GameWorld }).world;

    sim.addPlayer("s1");
    const playerEid = query(world, [Player])[0];
    // 直接给 wall_kit（kit 配方引用校验由 validateIntegrity + slice3 真实配置用例覆盖）
    Inventory[playerEid]!.slots[0] = { kind: "wall_kit", count: 1 };

    // gridSnap 放置（真实配置 place.json 已开 gridSnap；出生点右侧有 villager，向左放）
    const px = Transform.x[playerEid];
    const py = Transform.y[playerEid];
    expect(sim.submitCommand("s1", { type: "place", slot: 0, x: px - 20, y: py })).toBe(true);
    const wall = query(world, [Placeable])[0];
    expect(wall !== undefined).toBe(true);
    // 对齐到格中心（tile 16 → 中心坐标 ≡ 8 mod 16）
    expect(Transform.x[wall] % 16).toBe(8);
    expect(Transform.y[wall] % 16).toBe(8);
    expect(GridOccupancy.cellW[wall]).toBe(1);
    expect(Placeable.ownerNetworkId[wall]).toBe(NetworkId.value[playerEid]);

    // 放置者拆除成功
    expect(sim.submitCommand("s1", { type: "deconstruct", target: NetworkId.value[wall] })).toBe(true);
    expect(query(world, [Placeable]).length).toBe(0);

    // 死亡窗口拒绝（submitCommand 层守卫）
    const wall2 = spawnEntity(world, world.archetypes.get("wall"), getRegistries().componentRegistry, { x: px + 24, y: py });
    Health.current[playerEid] = 0;
    expect(sim.submitCommand("s1", { type: "deconstruct", target: NetworkId.value[wall2] })).toBe(false);
  });
});
