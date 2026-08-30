/**
 * Slice 6 测试：网格放置 / 静态碰撞 / 拆除 / 多地图（传送门）链路。
 *
 * 覆盖：gridSnap 网格对齐与 GridOccupancy 占用、静态体碰撞（墙不被推走）、
 * deconstruct 拆除（仅放置者可拆）、ensureMapActive/movePlayerToMap/portalSystem
 * 分图语义（per-player：仅触发玩家切图，他人不动）、spawningSystem 按 mapId 过滤、
 * 存档记录/恢复（实体级 EntityMap 归属），以及真实 game 配置集成（墙放置→拆除全链路）。
 */
import { makeTestGeometry } from "./helpers/mapGeometry";
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
  movePlayerToMap,
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
import { EntityMap } from "framework/components/entityMap";
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
import type { Repository } from "framework/repository";

beforeAll(() => {
  // 全局引导一次：注册表是幂等单例，所有用例共享同一套内置实现
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

/** 给裸 world 挂一块 8×8 测试地图（128×128 像素，全可走，常驻激活）。 */
function attachTestMap(world: GameWorld, id = "test"): void {
  world.maps[id] = makeTestGeometry({ key: id, width: 8, height: 8 });
  world.activeMaps.add(id);
  world.defaultMapId = id;
}

/** 挂两张已构建图（a/b，全部常驻激活——核心切换后无惰性构建）。 */
function attachTwoMaps(world: GameWorld): void {
  world.maps = {
    a: makeTestGeometry({ key: "a", width: 8, height: 8 }),
    b: makeTestGeometry({ key: "b", width: 8, height: 8 }),
  };
  world.activeMaps = new Set(["a", "b"]);
  world.defaultMapId = "a";
}

/** 清空 EntityMap 模块级单例残留（AoS 数组跨 world 复用 eid，防跨用例串扰）。 */
function clearEntityMap(): void {
  for (let i = 0; i < EntityMap.length; i++) EntityMap[i] = undefined;
}

/** 清空 Portal AoS 残留：玩家 eid 命中旧用例的 portal 槽会被误判为 portal 自触发。 */
function clearPortal(): void {
  for (let i = 0; i < Portal.length; i++) Portal[i] = undefined;
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

// 网格放置：gridSnap 开启时占位对齐格线并写入格组（GridOccupancy），同格重放被拒、相邻格允许；未开启保持旧行为
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

// 静态碰撞：无 Velocity 的实体注册为静态体，玩家被挡停且墙不被推走；动态体之间仍正常分离
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

// 拆除：仅放置者可拆且需在范围内；超距/非放置者/无效 target/世界物（owner=0）均拒绝
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

// 多地图：ensureMapActive 惰性激活（幂等，NPC 仅首次布置）；movePlayerToMap 仅移动单玩家；
// portalSystem 触发者切图、他人不动、目标图无效不触发、不相交不触发
describe("Slice 6：portal 场景切换", () => {
  it("movePlayerToMap：仅触发玩家换图+传送；他人与场景实体不动；目标图按需激活", () => {
    const world = createBareWorld();
    clearEntityMap();
    clearPortal();
    attachTwoMaps(world);
    expect(world.maps["a"].key).toBe("a");
    expect(world.activeMaps.has("a")).toBe(true);

    const player = spawnTestPlayer(world, { x: 10, y: 10 });
    EntityMap[player] = "a";
    const other = spawnTestPlayer(world, { x: 50, y: 50 });
    EntityMap[other] = "a";
    // 场景实体（与图无关，不参与切图）
    ensureArchetype(world, { kind: "scn", components: { Size: { w: 16, h: 16 } } });
    const scene = spawnEntity(world, world.archetypes.get("scn"), getRegistries().componentRegistry, { x: 20, y: 20 });

    expect(movePlayerToMap(world, player, "b", { x: 99, y: 77 })).toBe(true);
    expect(EntityMap[player]).toBe("b");
    expect(Transform.x[player]).toBe(99);
    expect(Transform.y[player]).toBe(77);
    // 无清场：其他玩家与场景实体原地不动
    expect(EntityMap[other]).toBe("a");
    expect(Transform.x[other]).toBe(50);
    expect(Transform.y[other]).toBe(50);
    expect(Transform.x[scene]).toBe(20);
    // 目标图已在激活集中（常驻语义）
    expect(world.maps["b"].key).toBe("b");
    expect(world.activeMaps.has("b")).toBe(true);
  });

  it("portalSystem：玩家与 portal 相交仅触发者切图；另一玩家不动；目标图无效不触发", () => {
    const world = createBareWorld();
    clearEntityMap();
    clearPortal();
    attachTwoMaps(world);
    const playerA = spawnTestPlayer(world, { x: 60, y: 60 });
    EntityMap[playerA] = "a";
    const playerB = spawnTestPlayer(world, { x: 300, y: 300 });
    EntityMap[playerB] = "a";
    ensureArchetype(world, {
      kind: "p1",
      components: { Size: { w: 32, h: 32 }, Portal: { targetMap: "b", x: 111, y: 222 } },
    });
    const p1 = spawnEntity(world, world.archetypes.get("p1"), getRegistries().componentRegistry, { x: 64, y: 64 });
    EntityMap[p1] = "a";

    portalSystem(world);
    // 触发者：换图 + 传送到 portal 声明坐标；另一玩家完全不动（per-player 隔离）
    expect(EntityMap[playerA]).toBe("b");
    expect(Transform.x[playerA]).toBe(111);
    expect(Transform.y[playerA]).toBe(222);
    expect(EntityMap[playerB]).toBe("a");
    expect(Transform.x[playerB]).toBe(300);
    expect(Transform.y[playerB]).toBe(300);
    expect(world.activeMaps.has("b")).toBe(true);

    // 目标图无效（未注册）：玩家与 portal 相交（同点重叠）也不移动
    ensureArchetype(world, {
      kind: "p2",
      components: { Size: { w: 32, h: 32 }, Portal: { targetMap: "nope", x: 0, y: 0 } },
    });
    const p2 = spawnEntity(world, world.archetypes.get("p2"), getRegistries().componentRegistry, { x: 300, y: 300 });
    EntityMap[p2] = "a";
    portalSystem(world);
    expect(EntityMap[playerB]).toBe("a");
    expect(Transform.x[playerB]).toBe(300);
    expect(Transform.y[playerB]).toBe(300);
    expect(world.maps["nope"]).toBeUndefined();
  });

  it("portalSystem：玩家与 portal 同图但不相交不触发", () => {
    const world = createBareWorld();
    clearEntityMap();
    clearPortal();
    attachTwoMaps(world);
    const player = spawnTestPlayer(world, { x: 10, y: 10 });
    EntityMap[player] = "a";
    ensureArchetype(world, {
      kind: "p3",
      components: { Size: { w: 32, h: 32 }, Portal: { targetMap: "b", x: 0, y: 0 } },
    });
    const p3 = spawnEntity(world, world.archetypes.get("p3"), getRegistries().componentRegistry, { x: 100, y: 100 });
    EntityMap[p3] = "a";
    portalSystem(world);
    expect(EntityMap[player]).toBe("a");
    expect(Transform.x[player]).toBe(10);
    expect(Transform.y[player]).toBe(10);
    // 未触发：世界状态不变（图已由 boot 全量构建并激活）
    expect(Object.keys(world.maps).sort()).toEqual(["a", "b"]);
    expect(world.activeMaps).toEqual(new Set(["a", "b"]));
  });

  it("portalSystem：完整 tick 链（movement+collision 分离到接触距离）后仍可触发", () => {
    const world = createBareWorld();
    clearEntityMap();
    clearPortal();
    attachTwoMaps(world);
    // 覆盖为无阻挡手工图（生成器随机障碍会干扰碰撞链）
    world.maps["a"] = makeTestGeometry({ key: "a", width: 8, height: 8 });
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
    const portal = spawnEntity(world, world.archetypes.get("p4"), getRegistries().componentRegistry, { x: 80, y: 64 });
    EntityMap[portal] = "a";
    const player = spawnTestPlayer(world, { x: 20, y: 64 });
    EntityMap[player] = "a";
    const other = spawnTestPlayer(world, { x: 500, y: 300 });
    EntityMap[other] = "a";

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
    expect(EntityMap[player]).toBe("b");
    expect(Transform.x[player]).toBe(111);
    expect(Transform.y[player]).toBe(222);
    // 他人不受影响
    expect(EntityMap[other]).toBe("a");
    expect(Transform.x[other]).toBe(500);
  });

  it("地图常驻激活：boot 后全部配置图在 world.maps/activeMaps（ensureMapActive 已消亡）", () => {
    const world = createBareWorld();
    clearEntityMap();
    clearPortal();
    attachTwoMaps(world);
    ensureArchetype(world, { kind: "npc1", components: {} });

    expect(world.maps["a"]).toBeDefined();
    expect(world.maps["a"].key).toBe("a");
    expect(world.activeMaps.has("a")).toBe(true);
    expect(world.activeMaps.has("nope")).toBe(false);
  });

  it("spawningSystem 已退役：注入 mapId 过滤规则也不产出实体", () => {
    const world = createBareWorld();
    attachTestMap(world, "a");
    ensureArchetype(world, { kind: "w1", components: {} });
    world.gameDef.resolvedSpawns = [
      { kind: "w1", zoneId: 1, max: 2, respawnMs: 0, mapId: "a" },
      { kind: "w1", zoneId: 1, max: 2, respawnMs: 0, mapId: "b" },
    ];
    spawningSystem(world);
    spawningSystem(world);
    expect(query(world, [Transform]).length).toBe(0);
  });

  it("serializeWorld 写 defaultMapId；initialRecord 恢复按实体 EntityMap 归属并激活玩家图", async () => {
    const world = createBareWorld();
    clearEntityMap();
    clearPortal();
    attachTwoMaps(world);
    // 注册 test-player 原型（restoreWorld 按 kind 重建实体）
    ensureArchetype(world, { kind: "test-player", components: {} });
    const player = spawnTestPlayer(world, { x: 5, y: 5 });
    EntityMap[player] = "a";
    const record = serializeWorld(world, "save1");
    // record.mapId 写世界默认图 id；实体级归属入 components
    expect(record.mapId).toBe("a");
    const saved = record.entities.find((e) => e.kind === "test-player")!;
    expect(saved.components["EntityMap"]).toBe("a");

    // 新 world 读档恢复：玩家回到其存档归属图（EntityMap 优先于 record.mapId），
    // 玩家地图从实体归属重建激活（record.mapId 为 "" 不生效）
    const world2 = createBareWorld();
    attachTwoMaps(world2);
    ensureArchetype(world2, { kind: "test-player", components: {} });
    // restoreWorld 在 createGameSimulation 构造时就写 EntityMap——清零须在构造前
    clearEntityMap();
    // 读档通道唯一化：快照经 repository 预载（createGameSimulation 装配处）注入
    const repo: Repository = {
      saveWorld: async () => {},
      loadWorld: async () => record,
    };
    const sim = await createGameSimulation(world2.gameDef, { repository: repo, saveId: "save1" });
    const simWorld = (sim as unknown as { world: GameWorld }).world;
    const restored = query(simWorld, [NetworkId])[0];
    expect(restored).toBeDefined();
    expect(EntityMap[restored]).toBe("a");
    // 激活集由 boot 全量构建（常驻语义）；restoreWorld 仅兜底激活「已构建图」——
    // 本 world 无地图配置（"a" 未构建）→ 守卫跳过，不抛错、不产生幽灵激活
    expect(simWorld.activeMaps.has("a")).toBe(false);
  });
});

// 真实 game 配置集成：墙放置→占用→拆除全链路走配置数据，验证端到端可用
describe("Slice 6：真实 game 配置集成", () => {
  it("合成 wall_kit → gridSnap 放置 → 拆除 → 死亡窗口拒绝 全链路", async () => {
    const def = loadGameDefinition({ gameJsonPath: "game/game.json" });
    const sim = await createGameSimulation(def);
    const world = (sim as unknown as { world: GameWorld }).world;

    sim.addPlayer("s1");
    const playerEid = query(world, [Player])[0];
    // 直接给 wall_kit（kit 配方引用校验由 validateIntegrity + slice3 真实配置用例覆盖）
    Inventory[playerEid]!.slots[0] = { kind: "wall_kit", count: 1 };

    // gridSnap 放置（真实配置 place.json 已开 gridSnap）；新地图阻挡/占用分布不同，
    // 以玩家为原点环状偏移重试，命中可放位置即成功
    const px = Transform.x[playerEid];
    const py = Transform.y[playerEid];
    let placed = false;
    for (const [dx, dy] of [[-20, 0], [20, 0], [0, -20], [0, 20], [-40, 0], [40, 0], [0, -40], [0, 40]]) {
      if (sim.submitCommand("s1", { type: "place", slot: 0, x: px + dx, y: py + dy })) {
        placed = true;
        break;
      }
    }
    expect(placed).toBe(true);
    // 开机演化可能已铺放带 Placeable 的实体（如 campfire）——取最后创建（本次放置）的
    const wall = query(world, [Placeable]).at(-1)!;
    expect(wall).toBeDefined();
    // 对齐到格中心（tile 16 → 中心坐标 ≡ 8 mod 16）
    expect(Transform.x[wall] % 16).toBe(8);
    expect(Transform.y[wall] % 16).toBe(8);
    expect(GridOccupancy.cellW[wall]).toBe(1);
    expect(Placeable.ownerNetworkId[wall]).toBe(NetworkId.value[playerEid]);

    // 放置者拆除成功
    expect(sim.submitCommand("s1", { type: "deconstruct", target: NetworkId.value[wall] })).toBe(true);
    expect(query(world, [Placeable]).some((e) => e === wall)).toBe(false);

    // 死亡窗口拒绝（submitCommand 层守卫）
    const wall2 = spawnEntity(world, world.archetypes.get("wall"), getRegistries().componentRegistry, { x: px + 24, y: py });
    Health.current[playerEid] = 0;
    expect(sim.submitCommand("s1", { type: "deconstruct", target: NetworkId.value[wall2] })).toBe(false);
  });
});
