/**
 * 完整性审计批次 F1（2026-10-18）回归测试——正确性项。
 *
 * 覆盖：
 * - F-16 `setLevel`：Int8 值域/索引硬校验、指纹重算、地形纪元递增、脏格登记、
 *   增量存档 level 修改项与读档往返；
 * - F-17 坠落伤害：cliff 层差 ≥ minDropLevels 按层差扣血（slope 下行不扣）、
 *   cliff 语义校验、无配置零变化；
 * - F-22 混批腐烂：不同 spoilAt 不合并（拆为独立堆叠）、同 spoilAt/无 spoilAt
 *   正常合并、transferSlot 混批拒绝；
 * - F-23 合成产物：即时/延时产出都按到账 tick 传 nowTick（spoilAt 不再晚 1 tick）；
 * - F-24 成就奖励：无在线玩家时挂起 pending 键，上线后补发且只发一次；
 * - F-25 同格连接器：保留 eid 序首个 + 告警一次（不静默丢弃）；
 * - F-26 房间检测上限：rules/place.json 的 maxEnclosedArea 生效（缺省 256）；
 * - F-28 背包可见性：其他玩家 Inventory 槽位不下发（仅自己 + 容器可见）；
 * - F-29 A* 稳定阈值 + 每 tick 搜索预算（30 NPC 同帧有界 + 抖动不重算）。
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addComponent, addEntity, query } from "bitecs";
import type { Client } from "@colyseus/core";
import { StateView } from "@colyseus/schema";

import {
  bootstrapFramework,
  createDefaultGameDefinition,
  createGameInstance,
  createGameSimulation,
  createFileRepository,
  loadGameDefinition,
  serializeWorld,
  type GameWorld,
  type SimulationPort,
} from "framework/index";
import { createActionRegistry } from "framework/ai/actionRegistry";
import { createBehaviourTree } from "framework/ai/btFactory";
import { registerBuiltinActions } from "framework/ai/registerBuiltinActions";
import { GameRoom } from "network/colyseus/rooms/GameRoom";
import { RoomState } from "network/colyseus/state/RoomState";
import { PlayerState } from "network/colyseus/state/PlayerState";
import { Transform } from "framework/components/transform";
import { Velocity } from "framework/components/physics";
import { Health, Defense } from "framework/components/combat";
import { NetworkId } from "framework/components/network";
import { Player } from "framework/components/tags";
import { Inventory } from "framework/components/inventory";
import { ItemMeta } from "framework/components/itemMeta";
import { Kind } from "framework/components/kind";
import { EntityMap } from "framework/components/entityMap";
import { EntityLevel } from "framework/components/entityLevel";
import {
  Structure,
  STRUCTURE_ROLE_CONNECTOR,
  STRUCTURE_ROLE_FLOOR,
  STRUCTURE_ROLE_WALL,
  CONNECTOR_DIR_UP,
} from "framework/components/structure";
import { setGround, setLevel, setWalkable, drainDirtyTiles, getTerrainEpoch, terrainBaselineOf } from "map/runtime/terrainWriteback";
import { collectConnectorLookup } from "map/runtime/builtStructures";
import { spaceExposureAt } from "map/runtime/indoors";
import { computeGeometryVersion } from "map/geometry/version";
import { getBuiltStructuresEpoch } from "map/runtime/builtStructures";
import { entityLevelSystem, resolveEntityLevel } from "framework/systems/core/entityLevelSystem";
import { addToInventory, transferSlot } from "framework/systems/gameplay/inventoryOps";
import { craftRecipe, stepCraftingJobs } from "framework/systems/gameplay/craftingSystem";
import {
  createAchievementSystem,
  isAchievementUnlocked,
  achievementPendingKey,
} from "framework/systems/gameplay/achievementSystem";
import { Population } from "framework/simulation/population/population";
import { fastForwardPopulations } from "framework/simulation/population/populationSystem";
import { ItemKindSchema } from "framework/config/schema/ItemKindSchema";
import { createBlackboard, bbSet, BB_PERCEPTION_TARGET } from "framework/ai/blackboard";
import { stepBehaviourTree } from "framework/ai/btRunner";
import {
  BB_NAV_CHASE,
  getNavigationRuntime,
  pathfindingSearchesThisTick,
} from "framework/ai/pathfinding/navigate";
import { makeTestGeometry } from "./helpers/mapGeometry";
import { memoryRepository } from "./helpers/persistence";
import type { LoadedGameDefinition } from "framework/config/schema/GameDefinitionSchema";
import type { MapConfig } from "framework/config/schema/MapRegistrySchema";
import type { WorldRecord } from "framework/repository";
import type { SimulationPort as PortType } from "simulation";
import type { TickResult } from "simulation/types";

beforeAll(() => {
  bootstrapFramework();
});

beforeEach(() => {
  for (const arr of [Inventory, ItemMeta, EntityMap, EntityLevel, Population]) {
    for (let i = 0; i < arr.length; i++) arr[i] = undefined;
  }
  for (let i = 0; i < Kind.length; i++) Kind[i] = "";
});

function simWorld(sim: SimulationPort): GameWorld {
  return (sim as unknown as { world: GameWorld }).world;
}

function spawnEntityAt(world: GameWorld, mapId: string, x: number, y: number): number {
  const eid = addEntity(world);
  addComponent(world, eid, Transform);
  EntityMap[eid] = mapId;
  Transform.x[eid] = x;
  Transform.y[eid] = y;
  return eid;
}

function attachMap(world: GameWorld, key: string, geometry: ReturnType<typeof makeTestGeometry>): void {
  world.maps[key] = geometry;
  world.activeMaps.add(key);
  world.defaultMapId = key;
}

// ---------------------------------------------------------------------------
// F-16 setLevel 写回
// ---------------------------------------------------------------------------

const WB_MAP = "f1-writeback";

function wbMapConfig(): MapConfig {
  return {
    key: WB_MAP,
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

function wbDef(): LoadedGameDefinition {
  const def = createDefaultGameDefinition();
  def.resolvedEntities = [];
  def.resolvedMapConfigs = [wbMapConfig()];
  def.resolvedEntityRules = [];
  def.resolvedStaticEntityRules = [];
  return def;
}

describe("F-16 setLevel 写回", () => {
  it("原地改 level + 指纹重算 + 地形纪元递增 + 脏格登记；同值 no-op", () => {
    const world = createGameInstance(wbDef()).world;
    const geometry = world.maps[WB_MAP]!;
    const version0 = geometry.version;
    const builtEpoch0 = getBuiltStructuresEpoch(world, WB_MAP);

    expect(setLevel(world, WB_MAP, 9, 2)).toBe(true);
    expect(geometry.level[9]).toBe(2);
    expect(geometry.version).not.toBe(version0);
    expect(geometry.version).toBe(computeGeometryVersion(geometry));
    expect(getTerrainEpoch(world, WB_MAP)).toBe(1);
    // 与建造纪元相互独立（地形写回不递增建造纪元）
    expect(getBuiltStructuresEpoch(world, WB_MAP)).toBe(builtEpoch0);
    expect(drainDirtyTiles(world).get(WB_MAP)).toEqual([
      { tileIndex: 9, field: "level", value: 2, tick: world.time.tick },
    ]);

    // 同值写回：不动指纹/纪元/脏格
    const versionAfter = geometry.version;
    expect(setLevel(world, WB_MAP, 9, 2)).toBe(false);
    expect(geometry.version).toBe(versionAfter);
    expect(getTerrainEpoch(world, WB_MAP)).toBe(1);
    expect(drainDirtyTiles(world).size).toBe(0);

    // 出厂底板是副本：level 未被写回污染
    expect(terrainBaselineOf(world, WB_MAP)!.level[9]).not.toBe(2);
  });

  it("Int8 值域 / 索引 / 未知图硬校验", () => {
    const world = createGameInstance(wbDef()).world;
    expect(() => setLevel(world, "no-such-map", 0, 1)).toThrow(/no-such-map/);
    expect(() => setLevel(world, WB_MAP, 64, 1)).toThrow(/tileIndex/);
    expect(() => setLevel(world, WB_MAP, 0, 128)).toThrow(/-128\.\.127/);
    expect(() => setLevel(world, WB_MAP, 0, -129)).toThrow(/-128\.\.127/);
    expect(() => setLevel(world, WB_MAP, 0, 1.5)).toThrow(/-128\.\.127/);
  });

  it("level 变化随增量存档落盘并在读档时叠加（与 tiles/walkable 同契约）", async () => {
    const sim1 = await createGameSimulation(wbDef(), {
      repository: memoryRepository(null),
      saveId: "f1",
    });
    const world1 = simWorld(sim1);
    setGround(world1, WB_MAP, 10, 4);
    setWalkable(world1, WB_MAP, 11, 0);
    setLevel(world1, WB_MAP, 12, -1); // 负层 = 地下预留，Int8 合法
    const savedLevel = world1.maps[WB_MAP]!.level[12];

    const record = JSON.parse(JSON.stringify(serializeWorld(world1, "f1"))) as WorldRecord;
    const entry = record.maps![WB_MAP] as unknown as {
      format?: string;
      modifications: Array<Record<string, unknown>>;
    };
    expect(entry.format).toBe("delta");
    expect(entry.modifications).toContainEqual({ tileIndex: 12, field: "level", value: -1 });

    record.savedAt = Date.now() + 3_600_000;
    const sim2 = await createGameSimulation(wbDef(), {
      repository: memoryRepository(record),
      saveId: "f1",
    });
    expect(simWorld(sim2).maps[WB_MAP]!.level[12]).toBe(savedLevel);
    expect(simWorld(sim2).maps[WB_MAP]!.level[12]).toBe(-1);
  });
});

// ---------------------------------------------------------------------------
// F-17 坠落伤害
// ---------------------------------------------------------------------------

const FALL_MAP = "f1-fall";

function fallWorld(fallDamage?: { damagePerLevel: number; minDropLevels?: number }): GameWorld {
  const def = createDefaultGameDefinition();
  def.resolvedRules = fallDamage ? { place: { fallDamage } } : {};
  return createGameInstance(def).world;
}

/** 高台 L2（x≤3）/ cliff 带（x=3,4；x=4 为 L0）/ 低地 L0（x≥4）。 */
function cliffGeometry() {
  return makeTestGeometry({
    key: FALL_MAP,
    width: 8,
    height: 8,
    tiles: (tx) => (tx === 3 || tx === 4 ? 8 : 0),
    levels: (tx) => (tx <= 3 ? 2 : 0),
    levelSemantics: { slope: 7, cliff: 8 },
  });
}

function spawnHealthEntity(world: GameWorld, x: number, y: number, level: number): number {
  const eid = spawnEntityAt(world, FALL_MAP, x, y);
  addComponent(world, eid, Health);
  Health.current[eid] = 100;
  Health.max[eid] = 100;
  EntityLevel[eid] = level;
  return eid;
}

describe("F-17 坠落伤害", () => {
  it("cliff 跳下 ≥2 层按层差扣血（走标准伤害公式）；slope 下层差不扣", () => {
    const world = fallWorld({ damagePerLevel: 10, minDropLevels: 2 });
    attachMap(world, FALL_MAP, cliffGeometry());
    const jumper = spawnHealthEntity(world, 72, 72, 2); // tile (4,4)：cliff 带 + L0
    entityLevelSystem(world);
    expect(EntityLevel[jumper]).toBe(0);
    expect(Health.current[jumper]).toBe(80); // 2 层 × 10

    // slope 下行（Δ=1 < minDropLevels）不扣血
    const slopeMap = makeTestGeometry({
      key: "f1-slope",
      width: 8,
      height: 8,
      tiles: (_tx, ty) => (ty === 3 || ty === 4 ? 7 : 0),
      levels: (_tx, ty) => (ty >= 4 ? 1 : 0),
      levelSemantics: { slope: 7, cliff: 8 },
    });
    attachMap(world, "f1-slope", slopeMap);
    const walker = spawnEntityAt(world, "f1-slope", 40, 72);
    addComponent(world, walker, Health);
    Health.current[walker] = 100;
    Health.max[walker] = 100;
    EntityLevel[walker] = 1;
    Transform.y[walker] = 70; // 有效格 y=3（slope 格、地形 L0）
    entityLevelSystem(world);
    expect(EntityLevel[walker]).toBe(0);
    expect(Health.current[walker]).toBe(100);
  });

  it("按 Defense 组件走标准公式（至少 1 点）；无 fallDamage 配置零变化", () => {
    const withDefense = fallWorld({ damagePerLevel: 10, minDropLevels: 2 });
    attachMap(withDefense, FALL_MAP, cliffGeometry());
    const armored = spawnHealthEntity(withDefense, 72, 72, 2);
    addComponent(withDefense, armored, Defense);
    Defense.value[armored] = 5;
    entityLevelSystem(withDefense);
    expect(Health.current[armored]).toBe(85); // 20 - 5

    const noConfig = fallWorld();
    attachMap(noConfig, FALL_MAP, cliffGeometry());
    const plain = spawnHealthEntity(noConfig, 72, 72, 2);
    entityLevelSystem(noConfig);
    expect(EntityLevel[plain]).toBe(0);
    expect(Health.current[plain]).toBe(100);
  });

  it("cliff 语义校验：有 levelSemantics 时落点非 cliff 的 Δ≤-2 过渡被拒", () => {
    const geometry = makeTestGeometry({
      key: "f1-sem",
      width: 8,
      height: 1,
      tiles: (tx) => (tx === 4 ? 0 : 8), // 落点非 cliff
      levels: (tx) => (tx <= 3 ? 3 : 0),
      levelSemantics: { slope: 7, cliff: 8 },
    });
    // 经连接器产生 Δ=-3 过渡（support 被连接器满足，绕过 F-05 的自然下落）
    const connectorAt = () => ({ low: 0, high: 3, dir: 1, eid: 999 });
    expect(resolveEntityLevel(geometry, 72, 8, 3, connectorAt)).toBe(3);

    const cliffLanding = makeTestGeometry({
      key: "f1-sem-cliff",
      width: 8,
      height: 1,
      tiles: (tx) => (tx === 4 ? 8 : 0),
      levels: (tx) => (tx <= 3 ? 3 : 0),
      levelSemantics: { slope: 7, cliff: 8 },
    });
    expect(resolveEntityLevel(cliffLanding, 72, 8, 3, connectorAt)).toBe(0);

    // 生产路径（entityLevelSystem）：站在 L3 地形上走向非 cliff 的 L0 格
    // （support 来源 = terrain）→ 拒绝；同一位置若是 cliff 落点则允许并扣血。
    const world = fallWorld({ damagePerLevel: 10, minDropLevels: 2 });
    attachMap(world, FALL_MAP, geometry);
    const walker = spawnHealthEntity(world, 24, 8, 3);
    entityLevelSystem(world); // 记录「站在地形上」（非楼板）
    Transform.x[walker] = 72;
    entityLevelSystem(world);
    expect(EntityLevel[walker]).toBe(3); // 非 cliff 落点：保持原层
    expect(Health.current[walker]).toBe(100);

    attachMap(world, "f1-sem-cliff", cliffLanding);
    const jumper = spawnHealthEntity(world, 24, 8, 3);
    EntityMap[jumper] = "f1-sem-cliff";
    entityLevelSystem(world);
    Transform.x[jumper] = 72;
    entityLevelSystem(world);
    expect(EntityLevel[jumper]).toBe(0); // cliff 落点：允许跳下
    expect(Health.current[jumper]).toBe(70); // 3 层 × 10
  });
});

// ---------------------------------------------------------------------------
// F-22 混批腐烂
// ---------------------------------------------------------------------------

function itemKinds(world: GameWorld, specs: Array<Record<string, unknown>>): void {
  for (const spec of specs) {
    const parsed = ItemKindSchema.parse(spec);
    world.gameDef.itemsByKind!.set(parsed.kind, parsed);
  }
}

describe("F-22 腐烂混批不合并", () => {
  it("同 kind 不同 spoilAt → 拆成独立堆叠；相同/都未配置 → 正常合并", () => {
    const world = createGameInstance(createDefaultGameDefinition()).world;
    itemKinds(world, [
      { kind: "food", maxStack: 20, spoilTicks: 10 },
      { kind: "stable", maxStack: 20 },
    ]);
    const inv = { capacity: 4, slots: Array.from({ length: 4 }, () => null) };

    expect(addToInventory(inv, world.gameDef.itemsByKind, "food", 2, { spoilAt: 1010 })).toBe(0);
    expect(addToInventory(inv, world.gameDef.itemsByKind, "food", 1, { spoilAt: 1005 })).toBe(0);
    // 早到期批次不与新鲜批次混堆（各自独立保留 spoilAt）
    expect(inv.slots[0]).toEqual({ kind: "food", count: 2, spoilAt: 1010 });
    expect(inv.slots[1]).toEqual({ kind: "food", count: 1, spoilAt: 1005 });

    // 相同 spoilAt → 合并
    expect(addToInventory(inv, world.gameDef.itemsByKind, "food", 3, { spoilAt: 1005 })).toBe(0);
    expect(inv.slots[1]).toEqual({ kind: "food", count: 4, spoilAt: 1005 });
    expect(inv.slots[2]).toBeNull();

    // 都不腐烂（spoilAt undefined）→ 合并
    expect(addToInventory(inv, world.gameDef.itemsByKind, "stable", 2)).toBe(0);
    expect(addToInventory(inv, world.gameDef.itemsByKind, "stable", 3)).toBe(0);
    expect(inv.slots[2]).toEqual({ kind: "stable", count: 5 });
  });

  it("槽位压力取舍：混批满槽时剩余返还未入包（不静默混堆）", () => {
    const world = createGameInstance(createDefaultGameDefinition()).world;
    itemKinds(world, [{ kind: "food", maxStack: 20, spoilTicks: 10 }]);
    const inv = { capacity: 2, slots: [{ kind: "food", count: 20, spoilAt: 1010 }, null] };

    // 第一批进空槽
    expect(addToInventory(inv, world.gameDef.itemsByKind, "food", 5, { spoilAt: 1005 })).toBe(0);
    // 第三批无处可放（两个槽位均被不同批次占满，且不混堆）→ leftover 返还
    expect(addToInventory(inv, world.gameDef.itemsByKind, "food", 3, { spoilAt: 1000 })).toBe(3);
    expect(inv.slots[0]!.spoilAt).toBe(1010);
    expect(inv.slots[1]!.spoilAt).toBe(1005);
  });

  it("transferSlot 混批 → 拒绝移动（保持两槽原样）；同批次仍合并", () => {
    const inv = {
      capacity: 2,
      slots: [
        { kind: "food", count: 2, spoilAt: 1010 },
        { kind: "food", count: 3, spoilAt: 1005 },
      ],
    };
    expect(transferSlot(inv, 0, 1, () => 20)).toBe(false);
    expect(inv.slots[0]).toEqual({ kind: "food", count: 2, spoilAt: 1010 });
    expect(inv.slots[1]).toEqual({ kind: "food", count: 3, spoilAt: 1005 });

    inv.slots[0] = { kind: "food", count: 2, spoilAt: 1005 };
    expect(transferSlot(inv, 0, 1, () => 20)).toBe(true);
    expect(inv.slots[0]).toBeNull();
    expect(inv.slots[1]).toEqual({ kind: "food", count: 5, spoilAt: 1005 });
  });
});

// ---------------------------------------------------------------------------
// F-23 合成产物计时
// ---------------------------------------------------------------------------

describe("F-23 合成产物 nowTick", () => {
  function craftWorld(): GameWorld {
    const def = createDefaultGameDefinition();
    def.resolvedRules = {
      crafting: {
        recipes: [
          { id: "cook-now", inputs: [{ kind: "raw", count: 1 }], outputs: [{ kind: "food", count: 2 }] },
          {
            id: "cook-delayed",
            inputs: [{ kind: "raw", count: 1 }],
            outputs: [{ kind: "food", count: 1 }],
            durationTicks: 2,
          },
        ],
      },
    };
    const world = createGameInstance(def).world;
    itemKinds(world, [
      { kind: "raw", maxStack: 20 },
      { kind: "food", maxStack: 20, spoilTicks: 10 },
    ]);
    return world;
  }

  it("即时产出按当前 tick 写 spoilAt（不再晚 1 tick）", () => {
    const world = craftWorld();
    const owner = spawnEntityAt(world, "", 0, 0);
    Inventory[owner] = { capacity: 4, slots: [{ kind: "raw", count: 1 }, null, null, null] };
    world.time.tick = 1000;

    expect(craftRecipe(world, owner, "cook-now")).toBe(true);
    expect(Inventory[owner]!.slots[0]).toEqual({ kind: "food", count: 2, spoilAt: 1010 });
  });

  it("延时产出按到账 tick 写 spoilAt", () => {
    const world = craftWorld();
    const owner = spawnEntityAt(world, "", 0, 0);
    Inventory[owner] = { capacity: 4, slots: [{ kind: "raw", count: 1 }, null, null, null] };
    world.time.tick = 1000;

    expect(craftRecipe(world, owner, "cook-delayed")).toBe(true);
    world.time.tick = 1002;
    stepCraftingJobs(world);
    expect(Inventory[owner]!.slots[0]).toEqual({ kind: "food", count: 1, spoilAt: 1012 });
  });
});

// ---------------------------------------------------------------------------
// F-24 成就奖励待领取
// ---------------------------------------------------------------------------

function achievementDef(): LoadedGameDefinition {
  const def = createDefaultGameDefinition();
  def.resolvedRules = {
    factions: { factions: [{ id: "guild", members: ["merchant"], initialRep: 0 }] },
    achievements: {
      achievements: [
        {
          id: "a1",
          condition: "progressAtLeast:foo:1",
          reward: {
            items: [{ kind: "coin", count: 7 }],
            progress: { points: 5 },
            factionRep: [{ factionId: "guild", delta: 2 }],
          },
        },
      ],
    },
  };
  def.resolvedItems = [ItemKindSchema.parse({ kind: "coin", value: 1, maxStack: 9999 })];
  return def;
}

function spawnPlayerWithInventory(world: GameWorld, capacity = 4): number {
  const eid = spawnEntityAt(world, "", 0, 0);
  addComponent(world, eid, Player);
  addComponent(world, eid, NetworkId);
  NetworkId.value[eid] = world.nextNetworkId++;
  Inventory[eid] = { capacity, slots: Array.from({ length: capacity }, () => null) };
  return eid;
}

describe("F-24 成就奖励不丢（待领取）", () => {
  it("无在线玩家 → 写 pending 键；玩家上线后补发一次并清除", () => {
    const world = createGameInstance(achievementDef()).world;
    const system = createAchievementSystem({ checkIntervalTicks: 1 });
    world.time.tick = 0;
    world.progress.foo = 1;

    system(world);
    expect(isAchievementUnlocked(world, "a1")).toBe(true);
    expect(world.progress[achievementPendingKey("a1")]).toBe(1);
    // 世界侧 progress 奖励在解锁时已结算（不随 pending 重复）
    expect(world.progress.points).toBe(5);

    const player = spawnPlayerWithInventory(world);
    system(world); // 同一 tick 检查周期内补发
    expect(world.progress[achievementPendingKey("a1")]).toBeUndefined();
    expect(world.progress.points).toBe(5); // 世界进度不重复
    expect(Inventory[player]!.slots[0]!.kind).toBe("coin");
    expect(Inventory[player]!.slots[0]!.count).toBe(7);

    // 幂等：再次检查不重复发放
    world.time.tick = 1;
    system(world);
    expect(Inventory[player]!.slots.reduce((sum, slot) => sum + (slot?.kind === "coin" ? slot.count : 0), 0)).toBe(7);
  });

  it("背包放不下时保留 pending 重试，腾出空间后补发", () => {
    const world = createGameInstance(achievementDef()).world;
    const system = createAchievementSystem({ checkIntervalTicks: 1 });
    world.time.tick = 0;
    world.progress.foo = 1;
    system(world);

    const player = spawnPlayerWithInventory(world, 1);
    Inventory[player]!.slots[0] = { kind: "junk", count: 1 };
    system(world);
    expect(world.progress[achievementPendingKey("a1")]).toBe(1);
    expect(Inventory[player]!.slots[0]).toEqual({ kind: "junk", count: 1 });

    Inventory[player]!.slots[0] = null;
    world.time.tick = 1;
    system(world);
    expect(world.progress[achievementPendingKey("a1")]).toBeUndefined();
    expect(Inventory[player]!.slots[0]).toEqual({ kind: "coin", count: 7 });
  });

  it("有在线触发玩家时直接发放，不产生 pending", () => {
    const world = createGameInstance(achievementDef()).world;
    const player = spawnPlayerWithInventory(world);
    const system = createAchievementSystem({ checkIntervalTicks: 1 });
    world.time.tick = 0;
    world.progress.foo = 1;

    system(world);
    expect(isAchievementUnlocked(world, "a1")).toBe(true);
    expect(world.progress[achievementPendingKey("a1")]).toBeUndefined();
    expect(Inventory[player]!.slots[0]).toEqual({ kind: "coin", count: 7 });
  });
});

// ---------------------------------------------------------------------------
// F-25 同格连接器冲突告警
// ---------------------------------------------------------------------------

const CONNECTOR_MAP = "f1-connector";

function addStructure(
  world: GameWorld,
  mapId: string,
  role: number,
  level: number,
  tx: number,
  ty: number,
  connect?: { low: number; high: number; dir: number },
): number {
  const eid = spawnEntityAt(world, mapId, (tx + 0.5) * 16, (ty + 0.5) * 16);
  addComponent(world, eid, Structure);
  Structure.role[eid] = role;
  EntityLevel[eid] = level;
  if (connect) {
    Structure.connectLow[eid] = connect.low;
    Structure.connectHigh[eid] = connect.high;
    Structure.connectDir[eid] = connect.dir;
  }
  return eid;
}

describe("F-25 同格连接器不静默丢弃", () => {
  it("同格两个连接器：保留 eid 序首个并告警一次（重复投影不刷日志）", () => {
    const world = createGameInstance(createDefaultGameDefinition()).world;
    attachMap(world, CONNECTOR_MAP, makeTestGeometry({ key: CONNECTOR_MAP, width: 8, height: 8 }));
    const first = addStructure(world, CONNECTOR_MAP, STRUCTURE_ROLE_CONNECTOR, 0, 2, 2, {
      low: 0,
      high: 1,
      dir: CONNECTOR_DIR_UP,
    });
    const second = addStructure(world, CONNECTOR_MAP, STRUCTURE_ROLE_CONNECTOR, 0, 2, 2, {
      low: 0,
      high: 1,
      dir: 1,
    });

    const warn = vi.spyOn(world.logger, "warn").mockImplementation(() => undefined as never);
    const lookup1 = collectConnectorLookup(world);
    const lookup2 = collectConnectorLookup(world);

    expect(lookup1.get(CONNECTOR_MAP)!.get(2 * 8 + 2)!.eid).toBe(first);
    expect(lookup2.get(CONNECTOR_MAP)!.get(2 * 8 + 2)!.eid).toBe(first);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]![0])).toMatch(/连接器/);
    expect(warn.mock.calls[0]![1]).toMatchObject({ mapId: CONNECTOR_MAP, keptEid: first, droppedEid: second });
    warn.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// F-26 房间检测上限可配
// ---------------------------------------------------------------------------

describe("F-26 maxEnclosedArea 配置", () => {
  function buildRoomWorld(maxEnclosedArea?: number): GameWorld {
    const def = createDefaultGameDefinition();
    def.resolvedRules = maxEnclosedArea === undefined ? {} : { place: { maxEnclosedArea } };
    const world = createGameInstance(def).world;
    attachMap(
      world,
      "f1-room",
      makeTestGeometry({ key: "f1-room", width: 10, height: 10 }),
    );
    // 3×3 内室（3..5 × 3..5），外墙围一圈；内室中心头顶 L1 楼板
    for (let y = 2; y <= 6; y++) {
      for (let x = 2; x <= 6; x++) {
        const onBorder = x === 2 || x === 6 || y === 2 || y === 6;
        if (onBorder) addStructure(world, "f1-room", STRUCTURE_ROLE_WALL, 0, x, y);
      }
    }
    addStructure(world, "f1-room", STRUCTURE_ROLE_FLOOR, 1, 4, 4);
    return world;
  }

  it("规则 maxEnclosedArea 生效（小上限 → 露天）；显式 options 优先", () => {
    const small = buildRoomWorld(4);
    expect(spaceExposureAt(small, "f1-room", 4, 4, 0)).toBe("outdoor");
    expect(spaceExposureAt(small, "f1-room", 4, 4, 0, { maxEnclosedArea: 100 })).toBe("indoor");

    // 未配置 → 缺省 256，3×3 房间判室内
    const unconfigured = buildRoomWorld();
    expect(spaceExposureAt(unconfigured, "f1-room", 4, 4, 0)).toBe("indoor");

    // 真实 game 配置：place.json 显式声明 256
    const real = loadGameDefinition({ gameJsonPath: "game/game.json" });
    expect((real.resolvedRules["place"] as { maxEnclosedArea?: number }).maxEnclosedArea).toBe(256);
  });
});

// ---------------------------------------------------------------------------
// F-28 其他玩家背包不下发
// ---------------------------------------------------------------------------

type FakeClient = {
  sessionId: string;
  view?: StateView;
  send: (type: string, payload: unknown) => void;
};

type RoomAccess = {
  sim: PortType;
  applySnapshot: (result: TickResult) => void;
};

describe("F-28 per-client 背包可见性", () => {
  it("其他玩家 Inventory.* 不下发；本人背包/Container 背包仍可见", async () => {
    const def = createDefaultGameDefinition();
    def.netSync = {
      fields: [
        { component: "Transform", fields: ["x", "y"] },
        { component: "Inventory", tags: ["Player"], fields: ["slots"] },
      ],
    };
    const sim = await createGameSimulation(def);
    const j1 = sim.addPlayer("s1");
    const j2 = sim.addPlayer("s2");
    const world = simWorld(sim);
    const byNetwork = new Map<number, number>();
    for (const eid of query(world, [NetworkId])) byNetwork.set(NetworkId.value[eid], eid);
    const p1 = byNetwork.get(j1.networkId)!;
    const p2 = byNetwork.get(j2.networkId)!;
    Inventory[p1] = { capacity: 2, slots: [{ kind: "own-item", count: 1 }, null] };
    Inventory[p2] = { capacity: 2, slots: [{ kind: "other-item", count: 3 }, null] };
    Transform.x[p1] = 10;
    Transform.y[p1] = 10;
    Transform.x[p2] = 12;
    Transform.y[p2] = 12;

    const result = sim.tick(50);
    expect(result.snapshot.entities.get(j1.networkId)!.player).toBe(true);

    const room = new GameRoom();
    room.state = new RoomState();
    const clients: FakeClient[] = [];
    for (const [sessionId, networkId] of [["s1", j1.networkId], ["s2", j2.networkId]] as const) {
      const ps = new PlayerState();
      ps.sessionId = sessionId;
      ps.entityId = networkId;
      ps.visibleEntities.ownerSessionId = sessionId;
      room.state.players.set(sessionId, ps);
      const client: FakeClient = { sessionId, send: () => undefined, view: new StateView() };
      client.view?.add(ps);
      clients.push(client);
    }
    room.clients.push(...(clients as unknown as Client[]));
    const access = room as unknown as RoomAccess;
    access.sim = sim;
    access.applySnapshot(result);

    const own = room.state.players.get("s1")!.visibleEntities.get(String(j1.networkId))!;
    const other = room.state.players.get("s1")!.visibleEntities.get(String(j2.networkId))!;
    expect(own).toBeDefined();
    expect(other).toBeDefined();
    // 本人背包可见
    expect(own.stringValues.get("Inventory.0.kind")).toBe("own-item");
    expect(own.values.get("Inventory.0.count")).toBe(1);
    // 其他玩家的 Inventory.* 键完全不下发
    const leaked = [...other.stringValues.keys(), ...other.values.keys()].filter((key) =>
      key.startsWith("Inventory."),
    );
    expect(leaked).toEqual([]);
    // 其他非背包字段照旧同步
    expect(other.values.get("Transform.x")).toBe(12);

    sim.removePlayer("s1");
    sim.removePlayer("s2");
  });
});

// ---------------------------------------------------------------------------
// F-30 自动存档阻塞（JSON 编码移出 tick 同步段）
// ---------------------------------------------------------------------------

describe("F-30 存档编码延后", () => {
  it("fileRepository 的 JSON.stringify 在调用方同步段之后执行（tick 不承担编码）", async () => {
    const dir = await mkdtemp(join(tmpdir(), "f1-save-"));
    try {
      const repo = createFileRepository(dir);
      const record: WorldRecord = {
        id: "f1-f30",
        savedAt: 0,
        tick: 0,
        nextNetworkId: 1,
        timeOfDay: { hour: 0, phase: 0 },
        maps: {},
        entities: [],
      };

      const original = JSON.stringify;
      let insideCall = true;
      let encodedInsideCall = false;
      const spy = vi.spyOn(JSON, "stringify").mockImplementation((...args: Parameters<typeof JSON.stringify>) => {
        if (insideCall) encodedInsideCall = true;
        return original.apply(JSON, args);
      });

      const saving = repo.saveWorld(record);
      insideCall = false; // saveWorld 的同步段结束（等价于 tick 返回）
      await saving;
      spy.mockRestore();

      expect(encodedInsideCall).toBe(false);
      expect(await repo.loadWorld("f1-f30")).toMatchObject({ id: "f1-f30", tick: 0 });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// F-31 离线不实例化（结论：保持）
// ---------------------------------------------------------------------------

describe("F-31 离线补差不实例化 spawnInstances 实体", () => {
  it("fastForwardPopulations 只推进节点数值；实体留到在线 tick 的 populationSystem", () => {
    const world = createGameInstance(createDefaultGameDefinition()).world;
    attachMap(world, "f1-pop", makeTestGeometry({ key: "f1-pop", width: 8, height: 8, regions: ["r"] }));
    const source = spawnEntityAt(world, "f1-pop", 40, 40);
    Kind[source] = "nest";
    Population[source] = {
      species: "wolf",
      count: 2,
      cap: 64,
      carryingDensity: 0.5,
      growthRate: 1,
      growthIntervalTicks: 1,
      homeRegion: "r",
      lastEvolvedTick: 0,
      sourceKind: "nest",
      spawnInstances: true,
    };

    const aliveWolves = (): number => {
      let n = 0;
      for (let eid = 0; eid < Kind.length; eid++) if (Kind[eid] === "wolf") n += 1;
      return n;
    };

    fastForwardPopulations(world, 10);
    expect(Population[source]!.lastEvolvedTick).toBe(10);
    expect(Population[source]!.count).toBeGreaterThan(2); // 记账已推进
    expect(aliveWolves()).toBe(0); // 离线不落地
  });
});

// ---------------------------------------------------------------------------
// F-29 A* 稳定阈值 + 每 tick 搜索预算
// ---------------------------------------------------------------------------

function makeTree(definition: Parameters<typeof createBehaviourTree>[0]) {
  const registry = createActionRegistry();
  registerBuiltinActions(registry);
  return createBehaviourTree(definition, registry);
}

function spawnActor(world: GameWorld, mapId: string, x: number, y: number): number {
  const eid = spawnEntityAt(world, mapId, x, y);
  addComponent(world, eid, Velocity);
  Velocity.vx[eid] = 0;
  Velocity.vy[eid] = 0;
  EntityLevel[eid] = 0;
  return eid;
}

describe("F-29 A* 节流与预算", () => {
  it("稳定阈值：目标格小范围抖动不立即重算，超出阈值才重算", () => {
    const geometry = makeTestGeometry({
      width: 20,
      height: 6,
      blocked: (x) => x === 10,
    });
    const world = createGameInstance(createDefaultGameDefinition()).world;
    world.gameDef.systems = [
      { id: "ai", config: { pathfinding: { repathTicks: 10, maxNodes: 4096, goalStability: 32, maxSearchesPerTick: 8 } } },
    ];
    attachMap(world, "f1-stable", geometry);
    const self = spawnActor(world, "f1-stable", 24, 40);
    const target = spawnActor(world, "f1-stable", 280, 40);
    const inst = makeTree({ type: "root", child: { type: "action", call: "Chase", args: { speed: 10 } } });
    const bb = createBlackboard(self);
    bbSet(bb, BB_PERCEPTION_TARGET, { eid: target, dist: 256 });
    const step = () => stepBehaviourTree(inst, { world, self, bb });

    world.time.tick = 0;
    step();
    const runtime = getNavigationRuntime(bb, BB_NAV_CHASE)!;
    expect(runtime.searches).toBe(1);

    // 目标平移 1 格（16px）：阈值内、间隔未到 → 不重算
    Transform.x[target] = 296;
    world.time.tick = 1;
    step();
    expect(runtime.searches).toBe(1);

    // 平移 4 格：超出阈值 → 立即重算
    Transform.x[target] = 344;
    world.time.tick = 2;
    step();
    expect(runtime.searches).toBe(2);
  });

  it("每 tick 搜索预算：30 个 NPC 同帧至多 N 次 A*（超出回退直线/沿用旧路径）", () => {
    const geometry = makeTestGeometry({
      width: 20,
      height: 20,
      blocked: (x) => x === 10 && x < 20,
    });
    const world = createGameInstance(createDefaultGameDefinition()).world;
    world.gameDef.systems = [
      { id: "ai", config: { pathfinding: { repathTicks: 20, maxNodes: 4096, maxSearchesPerTick: 4 } } },
    ];
    attachMap(world, "f1-budget", geometry);

    const inst = makeTree({ type: "root", child: { type: "action", call: "Chase", args: { speed: 10 } } });
    const actors: Array<{ eid: number; bb: ReturnType<typeof createBlackboard> }> = [];
    for (let i = 0; i < 30; i++) {
      const y = 20 + (i % 16) * 18;
      const self = spawnActor(world, "f1-budget", 24, y);
      const target = spawnActor(world, "f1-budget", 300, y);
      const bb = createBlackboard(self);
      bbSet(bb, BB_PERCEPTION_TARGET, { eid: target, dist: 276 });
      actors.push({ eid: self, bb });
    }

    world.time.tick = 0;
    for (const actor of actors) {
      stepBehaviourTree(inst, { world, self: actor.eid, bb: actor.bb });
    }
    expect(pathfindingSearchesThisTick(world)).toBe(4);
    const searched = actors.filter((actor) => getNavigationRuntime(actor.bb, BB_NAV_CHASE)!.searches > 0);
    expect(searched).toHaveLength(4);

    // 有搜索预算的实体拿到路径；其余回退直线但仍在移动（不卡死）
    for (const actor of actors) {
      expect(Math.hypot(Velocity.vx[actor.eid], Velocity.vy[actor.eid])).toBeGreaterThan(0);
    }

    // 下一 tick 预算重置：又有至多 4 次搜索（不会累计饿死）
    world.time.tick = 1;
    for (const actor of actors) {
      stepBehaviourTree(inst, { world, self: actor.eid, bb: actor.bb });
    }
    expect(pathfindingSearchesThisTick(world)).toBeLessThanOrEqual(4);
  });
});
