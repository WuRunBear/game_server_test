/**
 * 批次 D1 测试：多层建造内容可达（F-13）、栅栏/门结构防御（F-12）、
 * projectile 启用（F-14）。
 *
 * 覆盖：
 * - 真实 game 配置：楼梯 kit 配方可从零获得、投掷武器档案与配方面、门/栅栏
 *   的 Health + Structure(wall) + Passage、wall_upper 进入 building-demo 模板、
 *   projectile 系统在 game.json 启用；
 * - 门开合：interact 意图切换 Passage、开放时不进建造阻挡索引（A* 直穿）、
 *   碰撞实体体不登记、开合状态随存档往返；
 * - 栅栏/门：A* 绕行不再穿栅栏、袭击把（关闭的）栅栏选为结构目标并可打坏，
 *   打开的门不被选为目标；
 * - 投掷：throw 命令确定性发射、冷却拦截、命中扣血、锁层不命中异层。
 */
import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { addComponent, addEntity, hasComponent, query } from "bitecs";
import {
  bootstrapFramework,
  createGameInstance,
  createGameSimulation,
  createDefaultGameDefinition,
  loadGameDefinition,
  spawnEntity,
  serializeWorld,
  restoreWorld,
  getRegistries,
  findPath,
  collectBuiltStructures,
  throwWeapon,
  projectileSystem,
  togglePassage,
  isPassageOpen,
  craftRecipe,
  stepCraftingJobs,
} from "framework/index";
import { Transform } from "framework/components/transform";
import { Collider, ColliderShape } from "framework/components/physics";
import { Attack, Health } from "framework/components/combat";
import { Cooldown } from "framework/components/timer";
import { Player } from "framework/components/tags";
import { Inventory } from "framework/components/inventory";
import { Equipment } from "framework/components/equipment";
import { NetworkId } from "framework/components/network";
import { EntityMap, entityMapOf } from "framework/components/entityMap";
import { EntityLevel, entityLevelOf } from "framework/components/entityLevel";
import { Kind } from "framework/components/kind";
import { Intent } from "framework/components/intent";
import { Passage, PASSAGE_CLOSED, PASSAGE_OPEN } from "framework/components/passage";
import { Projectile } from "framework/components/projectile";
import { Structure, STRUCTURE_ROLE_WALL } from "framework/components/structure";
import { getCollisionDebugSnapshot, collisionSystem } from "framework/systems/core/collisionSystem";
import { interactionSystem } from "framework/systems/gameplay/interactionSystem";
import { raidSystem } from "framework/systems/gameplay/raidSystem";
import { deathSystem } from "framework/systems/gameplay/deathSystem";
import { makeTestGeometry } from "./helpers/mapGeometry";
import type { LoadedGameDefinition } from "framework/config/schema/GameDefinitionSchema";
import type { ArchetypeSpec } from "framework/entities/archetypeRegistry";
import type { MapGeometry } from "map/geometry/types";
import type { GameWorld } from "framework/world";

const MAP = "d1-map";
const TILE = 16;

let realDef: LoadedGameDefinition;

beforeAll(() => {
  bootstrapFramework();
  realDef = loadGameDefinition({ gameJsonPath: "game/game.json" });
});

/** 清理跨 world 复用的 AoS/实体级单例（eid 复用防串扰）。 */
beforeEach(() => {
  const arrays = [EntityMap, EntityLevel, Inventory, Kind, Intent] as unknown as (unknown[] | undefined)[];
  for (const arr of arrays) {
    if (!arr) continue;
    for (let i = 0; i < arr.length; i++) arr[i] = undefined;
  }
});

function tileCenter(tx: number, ty: number): { x: number; y: number } {
  return { x: (tx + 0.5) * TILE, y: (ty + 0.5) * TILE };
}

/** 挂一块 8×8 全可走测试图并设为默认图。 */
function attachMap(world: GameWorld): MapGeometry {
  const geometry = makeTestGeometry({ key: MAP, width: 8, height: 8 });
  world.maps[MAP] = geometry;
  world.activeMaps.add(MAP);
  world.defaultMapId = MAP;
  return geometry;
}

/** 默认最小世界 + 真实 game 配置中的原型/物品（不生成真实地图，保持用例快）。 */
function createRealContentWorld(): GameWorld {
  const world = createGameInstance(createDefaultGameDefinition()).world;
  for (const kind of ["door", "fence", "wall_upper"]) {
    const spec = realDef.resolvedEntities.find((entity) => entity.kind === kind);
    if (!spec) throw new Error(`missing real archetype: ${kind}`);
    world.archetypes.override(spec);
  }
  world.gameDef.itemsByKind = new Map(realDef.resolvedItems.map((item) => [item.kind, item]));
  attachMap(world);
  return world;
}

/** 按 kind 在测试图格中心生成实体。 */
function spawnAt(
  world: GameWorld,
  kind: string,
  tx: number,
  ty: number,
  level?: number,
): number {
  const center = tileCenter(tx, ty);
  return spawnEntity(world, world.archetypes.get(kind), getRegistries().componentRegistry, {
    x: center.x,
    y: center.y,
    mapId: MAP,
    ...(level === undefined ? {} : { level }),
  });
}

/** 注册测试原型（全局注册表；已存在跳过）。 */
function ensureArchetype(spec: ArchetypeSpec): void {
  const registry = getRegistries().archetypeRegistry;
  if (!registry.has(spec.kind)) registry.register(spec);
}

/** 投掷者/通用测试玩家：Transform/NetworkId/Player/Health/Attack/Cooldown。 */
function spawnPlayer(world: GameWorld, tx: number, ty: number, addEquipment = true): number {
  const eid = addEntity(world);
  addComponent(world, eid, Transform);
  addComponent(world, eid, NetworkId);
  addComponent(world, eid, Player);
  addComponent(world, eid, Health);
  addComponent(world, eid, Attack);
  addComponent(world, eid, Cooldown);
  const center = tileCenter(tx, ty);
  Transform.x[eid] = center.x;
  Transform.y[eid] = center.y;
  Health.current[eid] = 100;
  Health.max[eid] = 100;
  Attack.value[eid] = 10;
  Attack.range[eid] = 32;
  Cooldown.remainingMs[eid] = 0;
  EntityMap[eid] = MAP;
  EntityLevel[eid] = 0;
  NetworkId.value[eid] = world.nextNetworkId++;
  if (addEquipment) {
    addComponent(world, eid, Equipment);
    Equipment.weaponSlot[eid] = 0;
    Inventory[eid] = { capacity: 4, slots: [{ kind: "throwing_spear", count: 1 }, null, null, null] };
  }
  return eid;
}

/** 有生命的靶实体（同图同层）。 */
function spawnTarget(world: GameWorld, tx: number, ty: number, level = 0): number {
  const eid = addEntity(world);
  addComponent(world, eid, Transform);
  addComponent(world, eid, NetworkId);
  addComponent(world, eid, Health);
  const center = tileCenter(tx, ty);
  Transform.x[eid] = center.x;
  Transform.y[eid] = center.y;
  Health.current[eid] = 100;
  Health.max[eid] = 100;
  EntityMap[eid] = MAP;
  EntityLevel[eid] = level;
  NetworkId.value[eid] = world.nextNetworkId++;
  return eid;
}

/* ------------------------------------------------------------------ */
/* 真实配置：内容可达                                                    */
/* ------------------------------------------------------------------ */

describe("D1 真实配置：多层建造内容与投掷武器可达", () => {
  it("楼梯 kit 有可从零获得的配方（材料为现有 wood/plank/stone，无站点门槛）", () => {
    const crafting = realDef.resolvedRules["crafting"] as {
      recipes: {
        id: string;
        stationType?: number;
        inputs: { kind: string; count: number }[];
        outputs: { kind: string; count: number }[];
      }[];
    };
    const byId = new Map(crafting.recipes.map((recipe) => [recipe.id, recipe]));
    for (const id of ["stairs_up_kit", "stairs_down_kit"]) {
      const recipe = byId.get(id);
      expect(recipe, `missing recipe ${id}`).toBeDefined();
      expect(recipe!.outputs).toEqual([{ kind: id, count: 1 }]);
      expect(recipe!.stationType).toBeUndefined();
      expect(recipe!.inputs.length).toBeGreaterThan(0);
      for (const input of recipe!.inputs) {
        expect(["wood", "plank", "stone"]).toContain(input.kind);
        expect(realDef.resolvedItems.some((item) => item.kind === input.kind)).toBe(true);
      }
    }
    // 楼梯 kit 物品本身可放置到对应原型
    const items = new Map(realDef.resolvedItems.map((item) => [item.kind, item]));
    expect(items.get("stairs_up_kit")?.place?.archetype).toBe("stairs_up");
    expect(items.get("stairs_down_kit")?.place?.archetype).toBe("stairs_down");
  });

  it("真实配方端到端：从零 wood/stone 造出 plank → stairs_up_kit", () => {
    const world = createRealContentWorld();
    world.gameDef.resolvedRules["crafting"] = realDef.resolvedRules["crafting"];
    const player = spawnPlayer(world, 1, 1, false);
    Inventory[player] = {
      capacity: 8,
      slots: [
        { kind: "wood", count: 8 },
        { kind: "stone", count: 6 },
        null,
        null,
        null,
        null,
        null,
        null,
      ],
    };
    const countOf = (kind: string): number =>
      Inventory[player]!.slots.reduce((sum, stack) => sum + (stack?.kind === kind ? stack.count : 0), 0);

    // wood → plank（即时配方，无站点门槛）
    expect(craftRecipe(world, player, "plank")).toBe(true);
    expect(craftRecipe(world, player, "plank")).toBe(true);
    expect(countOf("plank")).toBe(2);

    // plank×2 + stone×2 → stairs_up_kit（40 tick 延时，非站点配方）
    expect(craftRecipe(world, player, "stairs_up_kit")).toBe(true);
    expect(countOf("plank")).toBe(0);
    expect(countOf("stone")).toBe(4);
    world.time.tick += 40;
    stepCraftingJobs(world);
    expect(countOf("stairs_up_kit")).toBe(1);
  });

  it("门/栅栏已是防御结构；门挂可开合 Passage；wall_upper 被 demo 模板引用", () => {
    const entities = new Map(realDef.resolvedEntities.map((entity) => [entity.kind, entity]));
    for (const kind of ["door", "fence"] as const) {
      const spec = entities.get(kind)!;
      const components = spec.components as Record<string, Record<string, unknown>>;
      expect(components.Health, `${kind} missing Health`).toBeDefined();
      expect(components.Structure?.role, `${kind} not a wall`).toBe(STRUCTURE_ROLE_WALL);
    }
    const door = entities.get("door")!.components as Record<string, Record<string, unknown>>;
    expect(door.Passage?.open).toBe(PASSAGE_CLOSED);

    const upper = entities.get("wall_upper")!;
    expect(upper.level).toBe(1);
    expect((upper.components as Record<string, Record<string, unknown>>).Health).toBeDefined();

    const demo = realDef.resolvedEntityRules.find(
      (rule) => rule.map === "building-demo" && rule.kind === "stairs_up",
    ) as { template?: { kind: string }[] } | undefined;
    expect(demo?.template?.some((entry) => entry.kind === "wall_upper")).toBe(true);
  });

  it("投掷武器在物品表/配方中，且 game.json 启用 projectile 系统", () => {
    const items = new Map(realDef.resolvedItems.map((item) => [item.kind, item]));
    const spear = items.get("throwing_spear");
    expect(spear?.throw).toEqual({
      speed: 320,
      lifeMs: 1000,
      radius: 5,
      cooldownMs: 900,
      damage: 16,
    });
    expect(spear?.equip?.slot).toBe("weapon");

    const crafting = realDef.resolvedRules["crafting"] as {
      recipes: { id: string; outputs: { kind: string }[] }[];
    };
    expect(crafting.recipes.some((recipe) => recipe.outputs.some((out) => out.kind === "throwing_spear"))).toBe(
      true,
    );
    expect(realDef.systems?.some((system) => system.id === "projectile")).toBe(true);
    expect(realDef.netSync?.fields.some((field) => field.component === "Passage")).toBe(true);
  });
});

/* ------------------------------------------------------------------ */
/* 门开合                                                               */
/* ------------------------------------------------------------------ */

describe("D1 门开合：交互 / 寻路 / 碰撞 / 存档", () => {
  it("interact 意图切换 Passage；打开后不进建造阻挡索引且 A* 直穿", () => {
    const world = createRealContentWorld();
    const geometry = world.maps[MAP];
    const player = spawnPlayer(world, 2, 5, false);
    const door = spawnAt(world, "door", 3, 5);

    // 关闭：墙位进入建造索引，A* 从门上方/下方绕行（不经过门格）
    let built = collectBuiltStructures(world, MAP);
    expect(built.walls.get(0)?.has(5 * geometry.grid.width + 3) ?? false).toBe(true);
    const closedPath = findPath(
      geometry,
      built,
      { x: 1, y: 5, level: 0 },
      { x: 5, y: 5, level: 0 },
    );
    expect(closedPath).not.toBeNull();
    expect(closedPath!.some((step) => step.x === 3 && step.y === 5)).toBe(false);

    // 交互开合：范围内的门被切换为打开
    Intent[player] = "interact";
    interactionSystem(world);
    expect(Intent[player]).toBeNull();
    expect(isPassageOpen(world, door)).toBe(true);
    expect(Passage.open[door]).toBe(PASSAGE_OPEN);

    built = collectBuiltStructures(world, MAP);
    expect(built.walls.get(0)?.has(5 * geometry.grid.width + 3) ?? false).toBe(false);
    const openPath = findPath(
      geometry,
      built,
      { x: 1, y: 5, level: 0 },
      { x: 5, y: 5, level: 0 },
    );
    expect(openPath).not.toBeNull();
    expect(openPath!.length).toBe(5); // 直线 5 格，经过门格
    expect(openPath!.some((step) => step.x === 3 && step.y === 5)).toBe(true);

    // 再交互一次：关闭，墙位恢复
    Intent[player] = "interact";
    interactionSystem(world);
    expect(isPassageOpen(world, door)).toBe(false);
    built = collectBuiltStructures(world, MAP);
    expect(built.walls.get(0)?.has(5 * geometry.grid.width + 3) ?? false).toBe(true);
  });

  it("碰撞一致：关闭时登记实体碰撞体，打开后移除（A*/碰撞同源）", () => {
    const world = createRealContentWorld();
    const door = spawnAt(world, "door", 3, 3);

    collisionSystem(world);
    let snapshot = getCollisionDebugSnapshot(world, { mapId: MAP, level: 0 });
    expect(snapshot.entityBodies.some((body) => "eid" in body && body.eid === door)).toBe(true);

    togglePassage(world, door);
    collisionSystem(world);
    snapshot = getCollisionDebugSnapshot(world, { mapId: MAP, level: 0 });
    expect(snapshot.entityBodies.some((body) => "eid" in body && body.eid === door)).toBe(false);

    togglePassage(world, door);
    collisionSystem(world);
    snapshot = getCollisionDebugSnapshot(world, { mapId: MAP, level: 0 });
    expect(snapshot.entityBodies.some((body) => "eid" in body && body.eid === door)).toBe(true);
  });

  it("开合状态随世界存档往返（实体级持久）", () => {
    const world = createRealContentWorld();
    const door = spawnAt(world, "door", 4, 4);
    togglePassage(world, door);
    const networkId = NetworkId.value[door];
    const record = serializeWorld(world, "d1-save");

    // 新世界（同一真实原型注册）恢复：门仍为打开
    const restored = createRealContentWorld();
    restoreWorld(restored, record);
    let restoredDoor: number | undefined;
    for (const eid of query(restored, [Passage])) {
      if (NetworkId.value[eid] === networkId) restoredDoor = eid;
    }
    expect(restoredDoor).toBeDefined();
    expect(isPassageOpen(restored, restoredDoor!)).toBe(true);
  });
});

/* ------------------------------------------------------------------ */
/* 栅栏/门作为防御结构                                                  */
/* ------------------------------------------------------------------ */

describe("D1 栅栏/门：寻路阻挡 + 袭击目标", () => {
  it("A* 绕过栅栏（不再穿栏），且栅栏进入 built.walls", () => {
    const world = createRealContentWorld();
    const geometry = world.maps[MAP];
    spawnAt(world, "fence", 3, 3);
    const built = collectBuiltStructures(world, MAP);
    expect(built.walls.get(0)?.has(3 * geometry.grid.width + 3)).toBe(true);

    const path = findPath(geometry, built, { x: 1, y: 3, level: 0 }, { x: 5, y: 3, level: 0 });
    expect(path).not.toBeNull();
    expect(path!.some((step) => step.x === 3 && step.y === 3)).toBe(false);
    expect(path!.length).toBeGreaterThan(5);
  });

  it("袭击把关闭的栅栏选为结构目标并可打坏；打开的门不被选", () => {
    ensureArchetype({
      kind: "d1-raider",
      components: {
        Collider: { shape: ColliderShape.Box, halfW: 8, halfH: 8 },
        Health: { current: 50, max: 50 },
        Attack: { value: 100, range: 200 },
        Cooldown: {},
      },
      team: 2,
    });

    const world = createRealContentWorld();
    const player = spawnPlayer(world, 4, 4, false);
    const door = spawnAt(world, "door", 3, 4);
    togglePassage(world, door); // 打开的门：不阻挡也不该被袭击
    const fence = spawnAt(world, "fence", 5, 4);
    const doorHealth = Health.current[door];
    const fenceHealth = Health.current[fence];

    world.gameDef.resolvedRules["raid"] = {
      intervalTicks: 5,
      waveSize: 1,
      kinds: ["d1-raider"],
      radiusTiles: 2,
      structureRadiusTiles: 2,
      attackStructures: true,
    };

    world.time.tick = 5;
    raidSystem(world);
    expect(query(world, [Player]).length).toBe(1);
    expect(Health.current[fence]).toBe(fenceHealth); // 指派当 tick 不结算

    world.time.tick = 6;
    raidSystem(world);
    expect(Health.current[fence]).toBeLessThanOrEqual(0);
    expect(Health.current[door]).toBe(doorHealth);

    deathSystem(world);
    expect(hasComponent(world, fence, Transform)).toBe(false);
    // 玩家只是参照中心，未被误伤
    expect(Health.current[player]).toBe(100);
  });
});

/* ------------------------------------------------------------------ */
/* 投掷                                                                 */
/* ------------------------------------------------------------------ */

describe("D1 投掷：确定性发射 / 冷却 / 命中扣血 / 锁层", () => {
  it("throwWeapon 按瞄准点确定性发射；冷却拦截第二次；命中扣血", () => {
    const world = createRealContentWorld();
    const player = spawnPlayer(world, 1, 1);
    const target = spawnTarget(world, 5, 1);
    const px = Transform.x[player];
    const py = Transform.y[player];

    world.time.dtMs = 100;
    expect(throwWeapon(world, player, Transform.x[target], Transform.y[target])).toBe(true);
    const projectiles = query(world, [Projectile]);
    expect(projectiles).toHaveLength(1);
    const projectile = projectiles[0]!;
    // 确定性速度：单位方向 × speed（配置 320）
    expect(Projectile.vx[projectile]).toBeCloseTo(320);
    expect(Projectile.vy[projectile]).toBeCloseTo(0);
    expect(Transform.x[projectile]).toBe(px);
    expect(Transform.y[projectile]).toBe(py);
    expect(Projectile.damage[projectile]).toBe(16);
    // 锁层：投射物层 = 主人层
    expect(EntityLevel[projectile]).toBe(entityLevelOf(player));
    // 冷却写入
    expect(Cooldown.remainingMs[player]).toBe(900);
    expect(throwWeapon(world, player, Transform.x[target], Transform.y[target])).toBe(false);

    // 推进两 tick（每次 32px）：第二 tick 到达靶位置 → 命中扣血并销毁
    projectileSystem(world);
    expect(hasComponent(world, projectile, Projectile)).toBe(true);
    projectileSystem(world);
    expect(hasComponent(world, projectile, Projectile)).toBe(false);
    // 防御 0：伤害 = 配置 damage 16
    expect(Health.current[target]).toBe(84);
  });

  it("锁层语义：异层目标不构成接触", () => {
    const world = createRealContentWorld();
    const player = spawnPlayer(world, 1, 1);
    const target = spawnTarget(world, 5, 1, 1); // 同坐标、层 1
    world.time.dtMs = 100;
    expect(throwWeapon(world, player, Transform.x[target], Transform.y[target])).toBe(true);
    for (let i = 0; i < 4; i++) projectileSystem(world);
    expect(Health.current[target]).toBe(100);
  });

  it("无投掷档案的武器 / 无武器拒绝投掷", () => {
    const world = createRealContentWorld();
    // 无 Equipment：装备解析失败 → false
    const bare = spawnPlayer(world, 1, 1, false);
    expect(throwWeapon(world, bare, 100, 100)).toBe(false);

    // 装备普通长矛（equip 无 throw）→ false
    const equipped = spawnPlayer(world, 2, 1);
    Inventory[equipped]!.slots[0] = { kind: "spear", count: 1 };
    expect(throwWeapon(world, equipped, 100, 100)).toBe(false);
  });

  it("GameSimulation 命令通道：throw 命令生成投射物并受冷却限制", async () => {
    const def = createDefaultGameDefinition();
    def.resolvedItems = realDef.resolvedItems;
    const sim = await createGameSimulation(def);
    const world = (sim as unknown as { world: GameWorld }).world;
    sim.addPlayer("s1");
    const player = query(world, [Player])[0]!;
    addComponent(world, player, Equipment);
    addComponent(world, player, Attack);
    addComponent(world, player, Cooldown);
    Inventory[player] = { capacity: 4, slots: [{ kind: "throwing_spear", count: 1 }, null, null, null] };
    Equipment.weaponSlot[player] = 0;
    Attack.value[player] = 10;
    Health.current[player] = 100;

    expect(sim.submitCommand("s1", { type: "throw", x: Transform.x[player] + 64, y: Transform.y[player] }).ok).toBe(true);
    expect(query(world, [Projectile])).toHaveLength(1);
    expect(sim.submitCommand("s1", { type: "throw", x: Transform.x[player] + 64, y: Transform.y[player] }).ok).toBe(false);
  });
});
