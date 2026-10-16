/**
 * v2 地图切片 6：楼层建造 + 房间检测测试。
 *
 * 覆盖（验证清单 ①-⑦）：
 * ① 统一 gameplay 距离助手（前置修正 4）：同层欧氏/异层不可达/LOS 预留位语义，
 *    并逐消费方断言异层不放行（combat/perception/place-deconstruct/crafting/
 *    dialogue/inventory；projectile 异层不接触由切片 5 测试覆盖）；
 * ② walkableAtLevel = 地形 OR 建造（前置修正 3）：楼板让上层格可站，无楼板
 *    上层不可站；碰撞静态体按建造索引开辟楼板格 + 建造纪元信号；
 * ③ GridOccupancy 升 (x, y, level)：同格异层共存（L0 家具 + L1 楼板），
 *    同层同格仍拒绝；
 * ④ 端到端：楼板/墙/楼梯（连接器）→ 跨层行走（上行格升层、不振荡、
 *    下行格降层）→ 室内判定；
 * ⑤ stranded 策略（前置修正 8）：唯一连接器 + 高层有人 → 拒拆；有第二可达
 *    下行连接器 → 允许；高层无人 → 允许；
 * ⑥ 房间检测：围合+有顶=室内、开口=室外、无顶=室外、旷野孤板=室外；
 * ⑦ 序列化往返：多层建造物（Structure/GridOccupancy.cellLevel/EntityLevel）
 *    存档→恢复逐字段保真，层号不随地形重推导。
 *
 * 几何全部手工确定性 MapGeometry（tile 16px），像素按格中心 (k+0.5)·16 手算。
 */
import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { addComponent, addEntity, query } from "bitecs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const check2d = require("check2d") as typeof import("check2d");

import {
  bootstrapFramework,
  createGameInstance,
  createDefaultGameDefinition,
  serializeWorld,
  restoreWorld,
  placeEntity,
  deconstructEntity,
  spawnEntity,
} from "framework/index";
import { Transform } from "framework/components/transform";
import { Velocity, Collider, ColliderShape } from "framework/components/physics";
import { NetworkId } from "framework/components/network";
import { Health, Attack, Team } from "framework/components/combat";
import { Player, NPC, Item } from "framework/components/tags";
import { Size } from "framework/components/size";
import { Perception } from "framework/components/perception";
import { Placeable } from "framework/components/placeable";
import { GridOccupancy } from "framework/components/gridOccupancy";
import { Inventory } from "framework/components/inventory";
import { ItemMeta } from "framework/components/itemMeta";
import { CraftingStation } from "framework/components/craftingStation";
import { Dialogue } from "framework/components/dialogue";
import { DialogueSource } from "framework/components/dialogueSource";
import { EntityMap, entityMapOf } from "framework/components/entityMap";
import { EntityLevel, entityLevelOf } from "framework/components/entityLevel";
import {
  Structure,
  STRUCTURE_ROLE_FLOOR,
  STRUCTURE_ROLE_WALL,
  STRUCTURE_ROLE_CONNECTOR,
  CONNECTOR_DIR_UP,
  CONNECTOR_DIR_DOWN,
} from "framework/components/structure";
import { sameLevelDistance, isGameplayReachable } from "framework/utils/gameplayDistance";
import { overlapsOccupiedGrid } from "framework/utils/placement";
import { walkableAtLevel } from "map/geometry/query";
import {
  collectBuiltStructures,
  floodSameLevel,
  bumpBuiltStructuresEpoch,
  getBuiltStructuresEpoch,
  type BuiltStructuresIndex,
} from "framework/map/runtime/builtStructures";
import { buildLevelMapBodies } from "framework/systems/core/collisionSystem";
import { collisionSystem } from "framework/systems/core/collisionSystem";
import { movementSystem } from "framework/systems/core/movementSystem";
import { entityLevelSystem, effectiveTileIndex } from "framework/systems/core/entityLevelSystem";
import { attackTarget } from "framework/systems/gameplay/combatSystem";
import { perceptionSystem } from "framework/systems/gameplay/perceptionSystem";
import { getOrCreateBlackboard } from "framework/systems/gameplay/aiSystem";
import { bbGet, BB_PERCEPTION_TARGET, type PerceivedTarget } from "framework/ai/blackboard";
import { craftRecipe } from "framework/systems/gameplay/craftingSystem";
import { startDialogue } from "framework/systems/gameplay/dialogueSystem";
import { inventorySystem } from "framework/systems/gameplay/inventorySystem";
import { canRemoveConnector } from "framework/systems/gameplay/deconstructSystem";
import { spaceExposureAt, isIndoors, entitySpaceExposure } from "framework/map/runtime/indoors";
import { setEntityKind } from "framework/systems/gameplay/aiSystem";
import { destroyEntity } from "framework/entities/destroyEntity";
import { makeTestGeometry } from "./helpers/mapGeometry";
import type { GameWorld } from "framework/world";
import type { MapGeometry } from "map/geometry/types";

beforeAll(() => {
  bootstrapFramework();
});

/** AoS 模块级单例清残留（EntityMap/EntityLevel 跨 world 复用 eid，防跨用例串扰）。 */
beforeEach(() => {
  for (let i = 0; i < EntityMap.length; i++) EntityMap[i] = undefined;
  for (let i = 0; i < EntityLevel.length; i++) EntityLevel[i] = undefined;
});

/** 构造一个最小世界（默认配置——系统链含 entity-level）。 */
function createBareWorld(): GameWorld {
  return createGameInstance(createDefaultGameDefinition()).world;
}

/** 挂一块 flat 全可走测试图（tile 16px；缺省 16×16，可指定更大尺寸避开洪泛上限）。 */
function attachFlatMap(world: GameWorld, id: string, size = 16): MapGeometry {
  const geometry = makeTestGeometry({ key: id, width: size, height: size });
  world.maps[id] = geometry;
  world.activeMaps.add(id);
  world.defaultMapId = id;
  return geometry;
}

interface TestEntityOpts {
  x?: number;
  y?: number;
  level?: number;
  /** 建造结构角色（挂 Structure 并写入角色/连接器字段）。 */
  structure?: { role: number; connectLow?: number; connectHigh?: number; connectDir?: number };
  collidable?: boolean;
}

/** 手工构造测试实体（Transform+NetworkId 必挂；层号/结构角色按需写入；collidable 才挂 Collider）。 */
function spawnTestEntity(world: GameWorld, opts: TestEntityOpts = {}): number {
  const eid = addEntity(world);
  addComponent(world, eid, Transform);
  addComponent(world, eid, NetworkId);
  addComponent(world, eid, Health);
  if (opts.collidable) {
    addComponent(world, eid, Collider);
    Collider.shape[eid] = ColliderShape.Box;
    Collider.halfW[eid] = 8;
    Collider.halfH[eid] = 8;
  }
  Health.current[eid] = 100;
  Health.max[eid] = 100;
  Transform.x[eid] = opts.x ?? 0;
  Transform.y[eid] = opts.y ?? 0;
  NetworkId.value[eid] = world.nextNetworkId++;
  EntityMap[eid] = world.defaultMapId;
  if (opts.level !== undefined) EntityLevel[eid] = opts.level;
  if (opts.structure) {
    addComponent(world, eid, Structure);
    Structure.role[eid] = opts.structure.role;
    Structure.connectLow[eid] = opts.structure.connectLow ?? 0;
    Structure.connectHigh[eid] = opts.structure.connectHigh ?? 0;
    Structure.connectDir[eid] = opts.structure.connectDir ?? CONNECTOR_DIR_UP;
  }
  return eid;
}

/** 手工构造玩家（Velocity + 16×16 Collider + 背包 + Team 1）。 */
function spawnTestPlayer(world: GameWorld, x: number, y: number): number {
  const eid = addEntity(world);
  addComponent(world, eid, Transform);
  addComponent(world, eid, NetworkId);
  addComponent(world, eid, Player);
  addComponent(world, eid, Health);
  addComponent(world, eid, Velocity);
  addComponent(world, eid, Collider);
  addComponent(world, eid, Size);
  addComponent(world, eid, Team);
  Transform.x[eid] = x;
  Transform.y[eid] = y;
  Health.current[eid] = 100;
  Health.max[eid] = 100;
  Collider.shape[eid] = ColliderShape.Box;
  Collider.halfW[eid] = 8;
  Collider.halfH[eid] = 8;
  Size.w[eid] = 16;
  Size.h[eid] = 16;
  Team.id[eid] = 1;
  Inventory[eid] = { capacity: 4, slots: [null, null, null, null] };
  NetworkId.value[eid] = world.nextNetworkId++;
  EntityMap[eid] = world.defaultMapId;
  setEntityKind(world, eid, "test-player");
  return eid;
}

/** 跑一帧「移动 → 层号 → 碰撞」核心链（dt=50ms）。 */
function stepCore(world: GameWorld): void {
  world.time.tick += 1;
  world.time.dtMs = 50;
  movementSystem(world);
  entityLevelSystem(world);
  collisionSystem(world);
}

/** 格中心像素坐标。 */
const cell = (k: number): number => (k + 0.5) * 16;

/** 按 networkId 查 eid（测试辅助）。 */
function findByNid(world: GameWorld, nid: number): number {
  for (const eid of query(world, [NetworkId])) {
    if (NetworkId.value[eid] === nid) return eid;
  }
  throw new Error(`entity with networkId ${nid} not found`);
}

// —— ① 统一距离助手 ——————————————————————————————————————
describe("① 统一 gameplay 距离助手（前置修正 4）", () => {
  it("纯函数语义：同层欧氏距离（边界恰等可达）；异层不可达", () => {
    expect(sameLevelDistance(0, 0, 1, 3, 4, 1)).toBe(5);
    expect(sameLevelDistance(0, 0, 1, 3, 4, 2)).toBeUndefined();
    // 边界：dist == range 可达（与各消费方原 dist > range 拒 的语义一致）
    expect(isGameplayReachable({ x: 0, y: 0, level: 0 }, { x: 5, y: 0, level: 0 }, 5)).toBe(true);
    expect(isGameplayReachable({ x: 0, y: 0, level: 0 }, { x: 5.01, y: 0, level: 0 }, 5)).toBe(false);
    expect(isGameplayReachable({ x: 0, y: 0, level: 0 }, { x: 0, y: 0, level: 1 }, 1000)).toBe(false);
  });

  it("LOS 预留位：缺省恒可视；回调拒绝即不可达（参数透传两端坐标与层）", () => {
    const calls: Array<{ ax: number; ay: number; bx: number; by: number; level: number }> = [];
    const los = (ax: number, ay: number, bx: number, by: number, level: number): boolean => {
      calls.push({ ax, ay, bx, by, level });
      return false;
    };
    expect(isGameplayReachable({ x: 0, y: 0, level: 2 }, { x: 1, y: 1, level: 2 }, 10, los)).toBe(false);
    expect(calls).toEqual([{ ax: 0, ay: 0, bx: 1, by: 1, level: 2 }]);
  });

  it("消费方 combat：同层射程内命中（回归）；异层同坐标拒绝", () => {
    const world = createBareWorld();
    attachFlatMap(world, "d-combat");
    const attacker = spawnTestPlayer(world, cell(2), cell(2));
    addComponent(world, attacker, Attack);
    Attack.value[attacker] = 10;
    const near = spawnTestEntity(world, { x: cell(3), y: cell(2), level: 0 });
    const otherLevel = spawnTestEntity(world, { x: cell(3), y: cell(2), level: 1 });

    expect(attackTarget(world, attacker, near)).toBe(true);
    expect(Health.current[near]).toBeLessThan(100);
    expect(attackTarget(world, attacker, otherLevel)).toBe(false);
    expect(Health.current[otherLevel]).toBe(100);
  });

  it("消费方 perception：同层半径内最近目标写入黑板（回归）；异层不感知", () => {
    const world = createBareWorld();
    attachFlatMap(world, "d-percep");
    // 观察者：NPC + Team 2 + 感知半径 96
    const observer = spawnTestEntity(world, { x: cell(2), y: cell(2), level: 0 });
    addComponent(world, observer, NPC);
    addComponent(world, observer, Team);
    Team.id[observer] = 2;
    addComponent(world, observer, Perception);
    Perception.visionRadius[observer] = 96;

    const preySame = spawnTestPlayer(world, cell(4), cell(2)); // 距 32px，Team 1
    const preyOther = spawnTestPlayer(world, cell(3), cell(2)); // 距 16px 更近，但异层
    EntityLevel[preyOther] = 1;

    perceptionSystem(world);
    const target = bbGet<PerceivedTarget>(getOrCreateBlackboard(world, observer), BB_PERCEPTION_TARGET);
    expect(target).not.toBeNull();
    expect(target!.eid).toBe(preySame); // 异层更近者不可感知，命中同层者
  });

  it("消费方 place/deconstruct：同层照常（回归）；异层放置物不可拆", () => {
    const world = createBareWorld();
    attachFlatMap(world, "d-place");
    world.gameDef.resolvedRules["place"] = { placeRange: 64 };
    const player = spawnTestPlayer(world, cell(2), cell(2));
    EntityLevel[player] = 0;
    const target = spawnTestEntity(world, { x: cell(5), y: cell(2), level: 0 });
    addComponent(world, target, Placeable);
    Placeable.ownerNetworkId[target] = NetworkId.value[player];

    expect(deconstructEntity(world, player, NetworkId.value[target])).toBe(true); // 同层回归

    const upstairs = spawnTestEntity(world, { x: cell(5), y: cell(2), level: 1 });
    addComponent(world, upstairs, Placeable);
    Placeable.ownerNetworkId[upstairs] = NetworkId.value[player];
    expect(deconstructEntity(world, player, NetworkId.value[upstairs])).toBe(false); // 异层不可达
    expect(entityLevelOf(upstairs)).toBe(1);
  });

  it("消费方 crafting：同层站点可达（回归）；异层站点不可达", () => {
    const world = createBareWorld();
    attachFlatMap(world, "d-craft");
    world.gameDef.resolvedRules["crafting"] = {
      recipes: [{ id: "r1", stationType: 7, inputs: [], outputs: [{ kind: "stone", count: 1 }] }],
      stationRange: 96,
    };
    const player = spawnTestPlayer(world, cell(2), cell(2));
    EntityLevel[player] = 0;
    const station = spawnTestEntity(world, { x: cell(3), y: cell(2), level: 0 });
    addComponent(world, station, CraftingStation);
    CraftingStation.stationType[station] = 7;
    expect(craftRecipe(world, player, "r1")).toBe(true);

    destroyEntity(world, station);
    const upstairs = spawnTestEntity(world, { x: cell(3), y: cell(2), level: 1 });
    addComponent(world, upstairs, CraftingStation);
    CraftingStation.stationType[upstairs] = 7;
    expect(craftRecipe(world, player, "r1")).toBe(false); // 异层站点不可达
  });

  it("消费方 dialogue：同层范围内开对话（回归）；异层/超距拒绝", () => {
    const world = createBareWorld();
    attachFlatMap(world, "d-dialog");
    world.gameDef.dialoguesByKind?.set("t-tree", {
      id: "t-tree",
      start: "s",
      nodes: { s: { text: "hi", options: [] } },
    } as never);
    const player = spawnTestPlayer(world, cell(2), cell(2));
    EntityLevel[player] = 0;

    const withSource = (level: number, tx: number): number => {
      const npc = spawnTestEntity(world, { x: cell(tx), y: cell(2), level });
      addComponent(world, npc, NPC);
      // DialogueSource 是 AoS 组件：直接写值即「挂载」（不能 addComponent）
      DialogueSource[npc] = { treeId: "t-tree" };
      return npc;
    };
    const npcNear = withSource(0, 3); // 距 16px ≤ 48
    expect(startDialogue(world, player, npcNear, 48)).toBe(true);
    expect(Dialogue[player]?.treeId).toBe("t-tree");
    Dialogue[player] = undefined;

    const npcFar = withSource(0, 9); // 距 112px > 48
    expect(startDialogue(world, player, npcFar, 48)).toBe(false);
    const npcUpstairs = withSource(1, 3); // 同坐标异层
    expect(startDialogue(world, player, npcUpstairs, 48)).toBe(false);
  });

  it("消费方 inventory：同层 16px 内拾取（回归）；异层掉落物不拾取", () => {
    const world = createBareWorld();
    attachFlatMap(world, "d-inv");
    world.time.tick = 10; // now = tick × dtMs，越过 pickupAfterMs=0
    const player = spawnTestPlayer(world, cell(2), cell(2));
    EntityLevel[player] = 0;

    const dropItem = (kind: string, level: number): number => {
      const item = spawnTestEntity(world, { x: cell(2) + 10, y: cell(2), level });
      addComponent(world, item, Item);
      ItemMeta[item] = { kind, count: 1, pickupAfterMs: 0 };
      return item;
    };
    dropItem("stone", 0);
    dropItem("wood", 1); // 同坐标异层

    inventorySystem(world);
    const inv = Inventory[player]!;
    expect(inv.slots.some((s) => s?.kind === "stone")).toBe(true); // 同层拾取
    expect(inv.slots.some((s) => s?.kind === "wood")).toBe(false); // 异层不拾取
  });

  it("floodSameLevel 基元：楼板并入可走集、墙阻挡、maxVisited 提前终止", () => {
    const world = createBareWorld();
    const geometry = attachFlatMap(world, "d-flood");
    // 全图不可走（模拟水/虚空），仅 (3,3) 有 L1 楼板 → L1 视角只能站楼板格
    geometry.walkable.fill(0);
    const built: BuiltStructuresIndex = { floors: new Map([[1, new Set([3 * 16 + 3])]]), walls: new Map(), connectors: new Map() };
    const reach = floodSameLevel(geometry, built, 3, 3, 1);
    expect([...reach]).toEqual([3 * 16 + 3]);

    // 墙阻挡：可走地面被整列墙分隔（列贯图，东西不可绕行）
    const geometry2 = attachFlatMap(world, "d-flood2");
    const built2: BuiltStructuresIndex = {
      floors: new Map(),
      walls: new Map([[0, new Set(Array.from({ length: 16 }, (_, ty) => ty * 16 + 4))]]),
      connectors: new Map(),
    };
    const left = floodSameLevel(geometry2, built2, 2, 2, 0);
    expect(left.has(2 * 16 + 3)).toBe(true); // 墙西侧
    expect(left.has(2 * 16 + 5)).toBe(false); // 墙东侧不可达

    // maxVisited 提前终止：全可走图 64 格上限
    const geometry3 = attachFlatMap(world, "d-flood3");
    const capped = floodSameLevel(geometry3, collectBuiltStructures(world, "d-flood3"), 0, 0, 0, { maxVisited: 64 });
    expect(capped.size).toBe(64);
  });
});

// —— ② walkableAtLevel 地形 OR 建造 ————————————————————————
describe("② walkableAtLevel = 地形 OR 建造（前置修正 3）", () => {
  it("楼板让上层格可站；无楼板上层不可站；缺省 built 仅地形（零回归）", () => {
    const world = createBareWorld();
    const geometry = attachFlatMap(world, "wa");
    geometry.walkable[5 * 16 + 5] = 0; // 模拟水面/阻挡格

    expect(walkableAtLevel(geometry, 5, 5, 0)).toBe(false);
    expect(walkableAtLevel(geometry, 5, 5, 1)).toBe(false); // 无楼板：上层也不可站

    const built = { floors: new Map([[1, new Set([5 * 16 + 5])]]) };
    expect(walkableAtLevel(geometry, 5, 5, 1, built)).toBe(true); // 楼板可站
    expect(walkableAtLevel(geometry, 5, 5, 0, built)).toBe(false); // 楼板属 L1，不影响 L0 地形判定
    expect(walkableAtLevel(geometry, 5, 5, 1)).toBe(false); // 缺省 built：旧语义不变
  });

  it("碰撞静态体按建造索引开辟楼板格（地形 OR 建造同源）", () => {
    const world = createBareWorld();
    const geometry = attachFlatMap(world, "cb");
    geometry.walkable[5 * 16 + 5] = 0; // 单格阻挡（(5,5)，像素 [80,96)）

    const system0 = new check2d.System();
    const before = buildLevelMapBodies(system0, geometry, 1);
    expect(before.length).toBe(1);
    expect((before[0] as unknown as { x: number }).x).toBe(80);

    const system1 = new check2d.System();
    const built = { floors: new Map([[1, new Set([5 * 16 + 5])]]) };
    const after = buildLevelMapBodies(system1, geometry, 1, built);
    expect(after).toEqual([]); // 楼板格在 L1 视角可站 → 无静态体
  });

  it("建造纪元：楼板增删递增所在图计数（碰撞运行时重建信号）", () => {
    const world = createBareWorld();
    attachFlatMap(world, "epoch");
    expect(getBuiltStructuresEpoch(world, "epoch")).toBe(0);
    bumpBuiltStructuresEpoch(world, "epoch");
    expect(getBuiltStructuresEpoch(world, "epoch")).toBe(1);
    expect(getBuiltStructuresEpoch(world, "other-map")).toBe(0); // 按图隔离
  });
});

// —— ③ GridOccupancy 同格多层共存 ——————————————————————————
describe("③ GridOccupancy 升 (x, y, level)", () => {
  /** 注册测试放置原型与物品（家具无结构角色；楼板 role=floor）。 */
  function setupPlaceables(world: GameWorld): void {
    world.gameDef.resolvedRules["place"] = { placeRange: 999, gridSnap: true };
    if (!world.archetypes.has("t-furn")) {
      world.archetypes.register({
        kind: "t-furn",
        components: {
          Size: { w: 16, h: 16 },
          Placeable: { footprintW: 16, footprintH: 16, canCollide: 0 },
          GridOccupancy: {},
        },
      });
    }
    if (!world.archetypes.has("t-slab")) {
      world.archetypes.register({
        kind: "t-slab",
        components: {
          Size: { w: 16, h: 16 },
          Placeable: { footprintW: 16, footprintH: 16, canCollide: 0 },
          Structure: { role: STRUCTURE_ROLE_FLOOR },
          GridOccupancy: {},
        },
      });
    }
    const items = world.gameDef.itemsByKind as Map<string, { kind: string; maxStack: number; place: { archetype: string } }>;
    items.set("t-furn-kit", { kind: "t-furn-kit", maxStack: 9, place: { archetype: "t-furn" } });
    items.set("t-slab-kit", { kind: "t-slab-kit", maxStack: 9, place: { archetype: "t-slab" } });
  }

  it("放置链：L0 家具与 L1 楼板同格共存；同层同格仍拒绝", () => {
    const world = createBareWorld();
    attachFlatMap(world, "occ");
    setupPlaceables(world);
    const player = spawnTestPlayer(world, cell(2), cell(2));
    Inventory[player]!.slots = [
      { kind: "t-furn-kit", count: 3 },
      { kind: "t-slab-kit", count: 3 },
      null,
      null,
    ];
    entityLevelSystem(world);
    expect(entityLevelOf(player)).toBe(0);

    // L0 家具落放置者层
    expect(placeEntity(world, player, 0, cell(5), cell(3))).toBe(true);
    const furniture = query(world, [Placeable])[0];
    expect(entityLevelOf(furniture)).toBe(0);
    expect(GridOccupancy.cellLevel[furniture]).toBe(0);
    expect(GridOccupancy.cellX[furniture]).toBe(5);
    expect(GridOccupancy.cellY[furniture]).toBe(3);

    // L1 楼板：同格放置成功（楼板角色升一层；异层格组不冲突）
    expect(placeEntity(world, player, 1, cell(5), cell(3))).toBe(true);
    const slab = query(world, [Placeable])[1];
    expect(entityLevelOf(slab)).toBe(1);
    expect(GridOccupancy.cellLevel[slab]).toBe(1);
    expect(GridOccupancy.cellX[slab]).toBe(5);

    // 同层（L1）同格重复放置被拒；同层异格允许
    expect(placeEntity(world, player, 1, cell(5), cell(3))).toBe(false);
    expect(placeEntity(world, player, 1, cell(6), cell(3))).toBe(true);
    expect(query(world, [Placeable]).length).toBe(3);
  });

  it("占用判定直查：overlapsOccupiedGrid 按层过滤（缺省保持全层旧语义）", () => {
    const world = createBareWorld();
    attachFlatMap(world, "occ2");
    const eid = spawnTestEntity(world, { x: cell(5), y: cell(3), level: 0 });
    addComponent(world, eid, GridOccupancy);
    GridOccupancy.cellX[eid] = 5;
    GridOccupancy.cellY[eid] = 3;
    GridOccupancy.cellLevel[eid] = 0;
    GridOccupancy.cellW[eid] = 1;
    GridOccupancy.cellH[eid] = 1;

    expect(overlapsOccupiedGrid(world, "occ2", 5, 3, 1, 1, 0)).toBe(true); // 同格同层
    expect(overlapsOccupiedGrid(world, "occ2", 5, 3, 1, 1, 1)).toBe(false); // 同格异层共存
    expect(overlapsOccupiedGrid(world, "occ2", 5, 3, 1, 1)).toBe(true); // 缺省层（旧语义）
  });
});

// —— ④ 端到端：楼板/墙/楼梯 → 跨层走 → 室内 ————————————————
describe("④ 端到端：跨层行走 + 室内判定", () => {
  /**
   * 手工搭一座 5×5 两层小楼（足迹 tile (5..9, 5..9)）：
   * - L0 墙环（16 格，围合+阻挡）；L0 内部 (6..8, 6..8)；
   * - L1 楼板 8 格（内部除楼梯井 (7,8)——井上无顶）；
   * - stairs_up（上行连接器，L0）在 (7,8)；stairs_down（下行连接器，L1）在 (7,6)。
   */
  function buildHouse(world: GameWorld): void {
    for (let t = 5; t <= 9; t++) {
      spawnTestEntity(world, { x: cell(t), y: cell(5), level: 0, structure: { role: STRUCTURE_ROLE_WALL }, collidable: true });
      spawnTestEntity(world, { x: cell(t), y: cell(9), level: 0, structure: { role: STRUCTURE_ROLE_WALL }, collidable: true });
      if (t > 5 && t < 9) {
        spawnTestEntity(world, { x: cell(5), y: cell(t), level: 0, structure: { role: STRUCTURE_ROLE_WALL }, collidable: true });
        spawnTestEntity(world, { x: cell(9), y: cell(t), level: 0, structure: { role: STRUCTURE_ROLE_WALL }, collidable: true });
      }
    }
    for (let ty = 6; ty <= 8; ty++) {
      for (let tx = 6; tx <= 8; tx++) {
        if (tx === 7 && ty === 8) continue; // 楼梯井上方留空（无顶）
        spawnTestEntity(world, { x: cell(tx), y: cell(ty), level: 1, structure: { role: STRUCTURE_ROLE_FLOOR } });
      }
    }
    spawnTestEntity(world, {
      x: cell(7), y: cell(8), level: 0,
      structure: { role: STRUCTURE_ROLE_CONNECTOR, connectLow: 0, connectHigh: 1, connectDir: CONNECTOR_DIR_UP },
    });
    spawnTestEntity(world, {
      x: cell(7), y: cell(6), level: 1,
      structure: { role: STRUCTURE_ROLE_CONNECTOR, connectLow: 0, connectHigh: 1, connectDir: CONNECTOR_DIR_DOWN },
    });
  }

  it("玩家走上行楼梯升 L1 → 楼上行走不振荡 → 走下行楼梯回 L0", () => {
    const world = createBareWorld();
    attachFlatMap(world, "e2e");
    buildHouse(world);

    // 玩家出生楼内 (7,7)（L0 室内）
    const player = spawnTestPlayer(world, cell(7), cell(7));
    stepCore(world);
    expect(entityLevelOf(player)).toBe(0);

    // 南行 6 帧（64px/s × 50ms = 3.2px/帧；f32 累积在第 6 帧越过 stairs_up
    // 格中心 y=136）→ 升 L1
    Velocity.vy[player] = 64;
    for (let i = 0; i < 6; i++) stepCore(world);
    expect(entityLevelOf(player)).toBe(1);

    // 停在楼梯格：上行连接器对 L1 实体无重定向 → 不振荡
    Velocity.vy[player] = 0;
    for (let i = 0; i < 8; i++) stepCore(world);
    expect(entityLevelOf(player)).toBe(1);

    // 北行跨过楼梯井与两格楼板，越过 stairs_down (7,6) 格中心 → 降回 L0
    Velocity.vy[player] = -64;
    for (let i = 0; i < 7; i++) stepCore(world);
    expect(entityLevelOf(player)).toBe(0);

    // 回到 L0 后持续北行：撞 L0 北墙被挡，层号保持 0
    for (let i = 0; i < 6; i++) stepCore(world);
    expect(entityLevelOf(player)).toBe(0);
    expect(Transform.y[player]).toBeLessThan(cell(7)); // 已离开楼梯格
    expect(Transform.y[player]).toBeGreaterThan(cell(5)); // 未穿墙
  });

  it("室内判定：L0 室内=indoor、楼梯井=室外（无顶）、L1 阁楼=室外（无顶）、屋外=室外；实体查询同判", () => {
    const world = createBareWorld();
    attachFlatMap(world, "e2e-indoor");
    buildHouse(world);

    expect(isIndoors(world, "e2e-indoor", 6, 6, 0)).toBe(true); // 围合 + 头顶楼板
    expect(isIndoors(world, "e2e-indoor", 7, 8, 0)).toBe(false); // 楼梯井正上方无楼板 → 无顶
    expect(isIndoors(world, "e2e-indoor", 7, 7, 1)).toBe(false); // L1 头顶无 L2 楼板 → 无顶
    expect(isIndoors(world, "e2e-indoor", 3, 3, 0)).toBe(false); // 屋外露天
    expect(spaceExposureAt(world, "e2e-indoor", 6, 6, 0)).toBe("indoor");
    expect(spaceExposureAt(world, "e2e-indoor", 3, 3, 0)).toBe("outdoor");

    const player = spawnTestPlayer(world, cell(6), cell(6));
    EntityLevel[player] = 0;
    expect(entitySpaceExposure(world, player)).toBe("indoor");
    EntityLevel[player] = 1; // 阁楼层（无顶）
    expect(entitySpaceExposure(world, player)).toBe("outdoor");
  });
});

// —— ⑤ stranded 策略 ————————————————————————————————————
describe("⑤ stranded：拆唯一楼梯被拒，有第二楼梯允许（前置修正 8）", () => {
  interface StrandedWorld {
    world: GameWorld;
    owner: number;
    soleStairs: number;
    secondStairs: number;
  }

  /**
   * 搭 L1 楼板走道 (5..8, 5) + 下行连接器；owner 站在走道上（L1——拆除
   * 受统一距离助手约束，必须同层）。
   */
  function buildStranded(withSecond: boolean): StrandedWorld {
    const world = createBareWorld();
    attachFlatMap(world, "stranded");
    for (let tx = 5; tx <= 8; tx++) {
      spawnTestEntity(world, {
        x: cell(tx), y: cell(5), level: 1,
        structure: { role: STRUCTURE_ROLE_FLOOR },
      });
    }
    const owner = spawnTestPlayer(world, cell(6), cell(5));
    EntityLevel[owner] = 1;
    const ownerNid = NetworkId.value[owner];

    const soleStairs = spawnTestEntity(world, {
      x: cell(8), y: cell(5), level: 1,
      structure: { role: STRUCTURE_ROLE_CONNECTOR, connectLow: 0, connectHigh: 1, connectDir: CONNECTOR_DIR_DOWN },
    });
    addComponent(world, soleStairs, Placeable);
    Placeable.ownerNetworkId[soleStairs] = ownerNid;

    let secondStairs = -1;
    if (withSecond) {
      secondStairs = spawnTestEntity(world, {
        x: cell(5), y: cell(5), level: 1,
        structure: { role: STRUCTURE_ROLE_CONNECTOR, connectLow: 0, connectHigh: 1, connectDir: CONNECTOR_DIR_DOWN },
      });
      addComponent(world, secondStairs, Placeable);
      Placeable.ownerNetworkId[secondStairs] = ownerNid;
    }
    return { world, owner, soleStairs, secondStairs };
  }

  it("canRemoveConnector 直查：唯一连接器 + 高层有人（楼板不算人）→ 拒绝", () => {
    const { world, soleStairs } = buildStranded(false);
    expect(canRemoveConnector(world, soleStairs)).toBe(false);
  });

  it("canRemoveConnector 直查：有同层可达的第二个下行连接器 → 允许", () => {
    const { world, soleStairs } = buildStranded(true);
    expect(canRemoveConnector(world, soleStairs)).toBe(true);
  });

  it("canRemoveConnector 直查：高层无人（除结构体）→ 允许", () => {
    const { world, soleStairs, owner } = buildStranded(false);
    EntityLevel[owner] = 0; // 人下楼了
    expect(canRemoveConnector(world, soleStairs)).toBe(true);
  });

  it("deconstruct 集成：楼上唯一楼梯拒拆；补第二楼梯后可拆", () => {
    const { world, owner, soleStairs } = buildStranded(false);
    expect(deconstructEntity(world, owner, NetworkId.value[soleStairs])).toBe(false);
    expect(entityLevelOf(soleStairs)).toBe(1); // 仍在

    // 补第二下行楼梯（与唯一楼梯同走道可达）→ 拆除放行
    const second = spawnTestEntity(world, {
      x: cell(5), y: cell(5), level: 1,
      structure: { role: STRUCTURE_ROLE_CONNECTOR, connectLow: 0, connectHigh: 1, connectDir: CONNECTOR_DIR_DOWN },
    });
    addComponent(world, second, Placeable);
    Placeable.ownerNetworkId[second] = NetworkId.value[owner];
    expect(deconstructEntity(world, owner, NetworkId.value[soleStairs])).toBe(true);
    expect(entityLevelOf(soleStairs)).toBe(0); // 已销毁，AoS 条目随 destroyEntity 清理
  });
});

// —— ⑥ 房间检测 ————————————————————————————————————————
describe("⑥ 房间检测：围合 + 有顶 = 室内", () => {
  function buildRooms(world: GameWorld): void {
    const ring = (tx: number, ty: number, level: number): number =>
      spawnTestEntity(world, { x: cell(tx), y: cell(ty), level, structure: { role: STRUCTURE_ROLE_WALL }, collidable: true });

    // 房间 A：3×3 全封（周界 8 墙）+ 顶（(2,2) L1 楼板）→ 室内
    for (let t = 1; t <= 3; t++) {
      ring(t, 1, 0);
      ring(t, 3, 0);
      if (t > 1 && t < 3) {
        ring(1, t, 0);
        ring(3, t, 0);
      }
    }
    spawnTestEntity(world, { x: cell(2), y: cell(2), level: 1, structure: { role: STRUCTURE_ROLE_FLOOR } });

    // 房间 B：同款墙环（平移 +6）但东墙中段 (9,2) 留开口 + 顶 → 室外
    for (let ty = 1; ty <= 3; ty++) {
      for (let tx = 7; tx <= 9; tx++) {
        const perimeter = tx === 7 || tx === 9 || ty === 1 || ty === 3;
        if (!perimeter) continue;
        if (tx === 9 && ty === 2) continue; // 东墙中段开口
        ring(tx, ty, 0);
      }
    }
    spawnTestEntity(world, { x: cell(8), y: cell(2), level: 1, structure: { role: STRUCTURE_ROLE_FLOOR } });

    // 房间 C：L2 全封但无顶 → 室外
    for (let t = 1; t <= 3; t++) {
      ring(t, 11, 2);
      ring(t, 13, 2);
      if (t > 1 && t < 3) {
        ring(1, t + 10, 2);
        ring(3, t + 10, 2);
      }
    }
  }

  it("围合+有顶=室内；开口=室外；无顶=室外", () => {
    const world = createBareWorld();
    // 24×24 图（576 格 > 缺省洪泛上限 256）：开口/旷野的洪泛必然超上限判室外
    attachFlatMap(world, "rooms", 24);
    buildRooms(world);

    expect(isIndoors(world, "rooms", 2, 2, 0)).toBe(true); // A：全封 + 顶
    expect(isIndoors(world, "rooms", 8, 2, 0)).toBe(false); // B：开口 → 洪泛逃逸
    expect(isIndoors(world, "rooms", 2, 12, 2)).toBe(false); // C：无顶
    expect(spaceExposureAt(world, "rooms", 2, 2, 0)).toBe("indoor");
    expect(spaceExposureAt(world, "rooms", 8, 2, 0)).toBe("outdoor");
  });

  it("旷野孤板（有顶无围合）= 室外（洪泛超上限提前终止，成本有界）", () => {
    const world = createBareWorld();
    attachFlatMap(world, "open", 24);
    spawnTestEntity(world, { x: cell(8), y: cell(8), level: 1, structure: { role: STRUCTURE_ROLE_FLOOR } });
    expect(isIndoors(world, "open", 8, 8, 0)).toBe(false);
  });
});

// —— ⑦ 序列化往返 ————————————————————————————————————————
describe("⑦ 序列化往返多层建造物", () => {
  /** 注册带 Structure 的测试原型（恢复链按 kind 查原型重建）。 */
  function ensureSerdeArchetypes(world: GameWorld): void {
    const reg = (kind: string, structure: Record<string, number>, collidable: boolean): void => {
      if (world.archetypes.has(kind)) return;
      world.archetypes.register({
        kind,
        components: {
          Size: { w: 16, h: 16 },
          ...(collidable ? { Collider: { shape: 1, halfW: 8, halfH: 8 } } : {}),
          Placeable: { footprintW: 16, footprintH: 16, canCollide: collidable ? 1 : 0, ownerNetworkId: 7 },
          Structure: structure,
          GridOccupancy: {},
        },
      });
    };
    reg("t-sd-floor", { role: STRUCTURE_ROLE_FLOOR }, false);
    reg("t-sd-wall", { role: STRUCTURE_ROLE_WALL }, true);
    reg("t-sd-stairs", { role: STRUCTURE_ROLE_CONNECTOR, connectDir: CONNECTOR_DIR_DOWN, connectLow: 0, connectHigh: 1 }, false);
  }

  it("Structure/GridOccupancy.cellLevel/EntityLevel 存档→恢复逐字段保真；层号不重推导", () => {
    const world = createBareWorld();
    attachFlatMap(world, "serde");
    ensureSerdeArchetypes(world);

    const floor = spawnEntity(world, world.archetypes.get("t-sd-floor"), world.components_registry, {
      x: cell(5), y: cell(5), mapId: "serde", level: 1,
    });
    GridOccupancy.cellX[floor] = 5;
    GridOccupancy.cellY[floor] = 5;
    GridOccupancy.cellLevel[floor] = 1;
    GridOccupancy.cellW[floor] = 1;
    GridOccupancy.cellH[floor] = 1;

    const wall = spawnEntity(world, world.archetypes.get("t-sd-wall"), world.components_registry, {
      x: cell(6), y: cell(5), mapId: "serde", level: 0,
    });
    GridOccupancy.cellX[wall] = 6;
    GridOccupancy.cellY[wall] = 5;
    GridOccupancy.cellLevel[wall] = 0;
    GridOccupancy.cellW[wall] = 1;
    GridOccupancy.cellH[wall] = 1;

    const stairs = spawnEntity(world, world.archetypes.get("t-sd-stairs"), world.components_registry, {
      x: cell(7), y: cell(5), mapId: "serde", level: 1,
    });
    GridOccupancy.cellX[stairs] = 7;
    GridOccupancy.cellY[stairs] = 5;
    GridOccupancy.cellLevel[stairs] = 1;
    GridOccupancy.cellW[stairs] = 1;
    GridOccupancy.cellH[stairs] = 1;

    const player = spawnEntity(world, world.archetypes.get("player"), world.components_registry, {
      x: cell(5), y: cell(5), mapId: "serde", level: 1,
    });
    entityLevelSystem(world); // 层号确立/校验

    const record = serializeWorld(world, "serde-save");
    const savedFloor = record.entities.find((e) => e.networkId === NetworkId.value[floor])!;
    const savedStairs = record.entities.find((e) => e.networkId === NetworkId.value[stairs])!;
    expect(savedFloor.components["EntityLevel"]).toBe(1);
    expect(savedFloor.components["GridOccupancy"]).toMatchObject({ cellLevel: 1, cellX: 5, cellY: 5 });
    expect(savedFloor.components["Structure"]).toMatchObject({ role: STRUCTURE_ROLE_FLOOR });
    expect(savedStairs.components["Structure"]).toMatchObject({
      role: STRUCTURE_ROLE_CONNECTOR,
      connectLow: 0,
      connectHigh: 1,
      connectDir: CONNECTOR_DIR_DOWN,
    });

    // 恢复到新 world → 逐字段保真；entityLevelSystem 不重推导（结构实体跳过）
    const world2 = createBareWorld();
    world2.maps["serde"] = makeTestGeometry({ key: "serde", width: 16, height: 16 });
    world2.activeMaps.add("serde");
    world2.defaultMapId = "serde";
    const restoredPlayers = restoreWorld(world2, record);
    expect(restoredPlayers.length).toBe(1);

    const rFloor = findByNid(world2, NetworkId.value[floor]);
    const rWall = findByNid(world2, NetworkId.value[wall]);
    const rStairs = findByNid(world2, NetworkId.value[stairs]);
    const rPlayer = findByNid(world2, NetworkId.value[player]);
    expect(entityLevelOf(rFloor)).toBe(1);
    expect(entityLevelOf(rWall)).toBe(0);
    expect(entityLevelOf(rStairs)).toBe(1);
    expect(entityLevelOf(rPlayer)).toBe(1); // 楼上玩家层号保真
    expect(GridOccupancy.cellLevel[rFloor]).toBe(1);
    expect(Structure.role[rFloor]).toBe(STRUCTURE_ROLE_FLOOR);
    expect(Structure.connectDir[rStairs]).toBe(CONNECTOR_DIR_DOWN);
    expect(Placeable.ownerNetworkId[rFloor]).toBe(7);

    entityLevelSystem(world2);
    expect(entityLevelOf(rFloor)).toBe(1); // 结构实体不被地形重推导
    expect(entityLevelOf(rWall)).toBe(0);
    expect(entityLevelOf(rStairs)).toBe(1);
    expect(entityLevelOf(rPlayer)).toBe(1);
  });
});
