/**
 * 同图过滤（per-player-maps 计划 todo 8）测试。
 *
 * 覆盖：
 * - 跨图同坐标隔离：感知不可见 / attackTarget 拒绝（且无 killed 事件）/
 *   自动拾取不吞 / 交互路由（interact/attack/talk）不选他图目标。
 * - 同图回归：同一张地图内感知/攻击/拾取/交互行为与改动前一致
 *   （镜像 survival.test.ts 的 Slice 1/2 用例设置）。
 *
 * 约定：
 * - world.defaultMapId = "dm"；手工 addEntity 的实体无 EntityMap 条目 →
 *   entityMapOf 回退默认图（与默认图世界行为完全一致）。
 * - 跨图实体显式 EntityMap[eid] = "other"。
 */
import type { MapGeometry } from "map/geometry/types";
import { makeTestGeometry } from "./helpers/mapGeometry";
import { describe, it, expect, beforeAll } from "vitest";
import { addComponent, addEntity, hasComponent, query } from "bitecs";
import {
  bootstrapFramework,
  createGameInstance,
  createDefaultGameDefinition,
} from "framework/index";
import { Transform } from "framework/components/transform";
import { Size } from "framework/components/size";
import { Health, Team, Attack } from "framework/components/combat";
import { NetworkId } from "framework/components/network";
import { Player, NPC, Enemy, Item, Resource } from "framework/components/tags";
import { Perception } from "framework/components/perception";
import { Inventory, type InventoryEntry } from "framework/components/inventory";
import { ItemMeta } from "framework/components/itemMeta";
import { ResourceNode } from "framework/components/resourceNode";
import { Intent } from "framework/components/intent";
import { Dialogue } from "framework/components/dialogue";
import { DialogueSource } from "framework/components/dialogueSource";
import { EntityMap } from "framework/components/entityMap";
import { perceptionSystem } from "framework/systems/gameplay/perceptionSystem";
import { attackTarget } from "framework/systems/gameplay/combatSystem";
import { inventorySystem } from "framework/systems/gameplay/inventorySystem";
import { createInteractionSystem } from "framework/systems/gameplay/interactionSystem";
import { setEntityKind, getOrCreateBlackboard } from "framework/systems/gameplay/aiSystem";
import { bbGet, BB_PERCEPTION_TARGET, type PerceivedTarget } from "framework/ai/blackboard";
import type { GameWorld } from "framework/world";
import type { ItemKindSpec } from "framework/config/schema/ItemKindSchema";

beforeAll(() => {
  // 全局引导一次：注册表是幂等单例，所有用例共享同一套内置实现
  bootstrapFramework();
});

/** 测试默认地图 id；无 EntityMap 条目的实体经 entityMapOf 回退到它。 */
const DEFAULT_MAP = "dm";
/** 跨图实体的地图 id。 */
const OTHER_MAP = "other";

/** 最小确定性地图几何（只用于 world.maps 登记，供 effectiveMapOf 的已知图判定）。 */
function buildMap(id: string): MapGeometry {
  return makeTestGeometry({ key: id, width: 8, height: 8 });
}

/** 构造一个最小世界（默认配置），默认图 = "dm"，登记 dm/other 两张图。 */
function createMapWorld(): GameWorld {
  const world = createGameInstance(createDefaultGameDefinition()).world;
  world.defaultMapId = DEFAULT_MAP;
  world.maps[DEFAULT_MAP] = buildMap(DEFAULT_MAP);
  world.maps[OTHER_MAP] = buildMap(OTHER_MAP);
  return world;
}

function setItemKind(world: GameWorld, spec: ItemKindSpec): void {
  world.gameDef.itemsByKind!.set(spec.kind, spec);
}

/** 给 world 挂一棵最小可路由对话树（treeId "t1"），talk 意图路由才能打开会话。 */
function attachTalkTree(world: GameWorld): void {
  world.gameDef.dialoguesByKind = new Map([
    [
      "t1",
      {
        id: "t1",
        start: "s",
        nodes: {
          s: { text: "hi", options: [{ label: "ok", to: "__end__" }] },
        },
      },
    ],
  ]);
}

interface PlayerOpts {
  x?: number; y?: number; hp?: number; capacity?: number;
  attack?: { value: number; range?: number };
  map?: string;
}

/** 手工 spawn 测试玩家：Player/Health/Team/Transform + Inventory，可带 Attack。 */
function spawnTestPlayer(world: GameWorld, opts: PlayerOpts = {}): number {
  const eid = addEntity(world);
  addComponent(world, eid, Transform);
  addComponent(world, eid, NetworkId);
  addComponent(world, eid, Player);
  addComponent(world, eid, Health);
  addComponent(world, eid, Team);
  Transform.x[eid] = opts.x ?? 0;
  Transform.y[eid] = opts.y ?? 0;
  Health.current[eid] = opts.hp ?? 100;
  Health.max[eid] = 100;
  Team.id[eid] = 1;
  if (opts.attack) {
    addComponent(world, eid, Attack);
    Attack.value[eid] = opts.attack.value;
    Attack.range[eid] = opts.attack.range ?? 0;
  }
  const capacity = opts.capacity ?? 4;
  Inventory[eid] = { capacity, slots: Array.from({ length: capacity }, () => null) };
  NetworkId.value[eid] = world.nextNetworkId++;
  setEntityKind(world, eid, "test-player");
  EntityMap[eid] = opts.map ?? DEFAULT_MAP;
  return eid;
}

interface HunterOpts { x?: number; y?: number; hp?: number; visionRadius?: number; team?: number; map?: string; }

/** 手工 spawn 感知实体：NPC+Enemy+Health+Perception+Team（perceptionSystem 的 eid 侧）。 */
function spawnTestHunter(world: GameWorld, opts: HunterOpts = {}): number {
  const eid = addEntity(world);
  addComponent(world, eid, Transform);
  addComponent(world, eid, NetworkId);
  addComponent(world, eid, NPC);
  addComponent(world, eid, Enemy);
  addComponent(world, eid, Health);
  addComponent(world, eid, Perception);
  addComponent(world, eid, Team);
  Transform.x[eid] = opts.x ?? 0;
  Transform.y[eid] = opts.y ?? 0;
  Health.current[eid] = opts.hp ?? 30;
  Health.max[eid] = opts.hp ?? 30;
  Perception.visionRadius[eid] = opts.visionRadius ?? 50;
  Team.id[eid] = opts.team ?? 2;
  NetworkId.value[eid] = world.nextNetworkId++;
  setEntityKind(world, eid, "test-enemy");
  EntityMap[eid] = opts.map ?? DEFAULT_MAP;
  return eid;
}

interface ResourceOpts {
  x?: number; y?: number; remaining?: number; max?: number;
  yieldsKind?: string; map?: string;
}

/** 手工 spawn 测试资源节点：Resource tag + ResourceNode AoS（interact 意图目标）。 */
function spawnTestResource(world: GameWorld, opts: ResourceOpts = {}): number {
  const eid = addEntity(world);
  addComponent(world, eid, Transform);
  addComponent(world, eid, NetworkId);
  addComponent(world, eid, Resource);
  addComponent(world, eid, Size);
  Transform.x[eid] = opts.x ?? 0;
  Transform.y[eid] = opts.y ?? 0;
  const max = opts.max ?? opts.remaining ?? 1;
  ResourceNode[eid] = {
    remaining: opts.remaining ?? max,
    max,
    amountPerHit: 1,
    regenMs: 0,
    yieldsKind: opts.yieldsKind ?? "k1",
    directConsume: false,
    depletedSinceMs: null,
  };
  NetworkId.value[eid] = world.nextNetworkId++;
  setEntityKind(world, eid, "test-resource");
  EntityMap[eid] = opts.map ?? DEFAULT_MAP;
  return eid;
}

interface ItemOpts { x?: number; y?: number; kind?: string; count?: number; pickupAfterMs?: number; map?: string; }

/** 手工 spawn 地面 item 实体：Item tag + ItemMeta AoS（自动拾取目标）。 */
function spawnGroundItem(world: GameWorld, opts: ItemOpts = {}): number {
  const eid = addEntity(world);
  addComponent(world, eid, Transform);
  addComponent(world, eid, NetworkId);
  addComponent(world, eid, Item);
  addComponent(world, eid, Size);
  Transform.x[eid] = opts.x ?? 0;
  Transform.y[eid] = opts.y ?? 0;
  ItemMeta[eid] = {
    kind: opts.kind ?? "k1",
    count: opts.count ?? 1,
    pickupAfterMs: opts.pickupAfterMs ?? 0,
  };
  NetworkId.value[eid] = world.nextNetworkId++;
  setEntityKind(world, eid, "test-item");
  EntityMap[eid] = opts.map ?? DEFAULT_MAP;
  return eid;
}

interface NpcOpts { x?: number; y?: number; map?: string; }

/** 手工 spawn 可对话 NPC：NPC tag + DialogueSource（talk 意图路由目标）。 */
function spawnTalkableNpc(world: GameWorld, opts: NpcOpts = {}): number {
  const eid = addEntity(world);
  addComponent(world, eid, Transform);
  addComponent(world, eid, NetworkId);
  addComponent(world, eid, NPC);
  Transform.x[eid] = opts.x ?? 0;
  Transform.y[eid] = opts.y ?? 0;
  DialogueSource[eid] = { treeId: "t1" };
  NetworkId.value[eid] = world.nextNetworkId++;
  setEntityKind(world, eid, "test-npc");
  EntityMap[eid] = opts.map ?? DEFAULT_MAP;
  return eid;
}

/** 断言取 [Item] 查询结果中 itemEid 对应的存活状态（拾取后应被 destroyEntity 移除）。 */
function groundItemAlive(world: GameWorld, itemEid: number): boolean {
  return query(world, [Item]).includes(itemEid);
}

describe("isolation", () => {
  it("a) 跨图同坐标：感知目标列表排除他图实体（黑板目标为 null）", () => {
    const world = createMapWorld();
    const hunter = spawnTestHunter(world, { x: 0, y: 0, visionRadius: 50 });
    // 完全同距离、不同图的敌对玩家：同图才可感知
    const crossMapPlayer = spawnTestPlayer(world, { x: 10, y: 0, map: OTHER_MAP });
    perceptionSystem(world);

    const bb = getOrCreateBlackboard(world, hunter);
    expect(bbGet<PerceivedTarget>(bb, BB_PERCEPTION_TARGET)).toBeNull();
    expect(EntityMap[crossMapPlayer]).toBe(OTHER_MAP);
  });

  it("a) 跨图同坐标：attackTarget 返回 false 且不产生 killed 事件（一击可杀场景）", () => {
    const world = createMapWorld();
    const attacker = spawnTestPlayer(world, {
      x: 0, y: 0, attack: { value: 50, range: 32 },
    });
    const victim = spawnTestHunter(world, { x: 0, y: 0, hp: 10, map: OTHER_MAP });
    // 同图一击必杀（50 vs 10）；跨图必须整体拒绝——不扣血、不发 killed
    expect(attackTarget(world, attacker, victim)).toBe(false);
    expect(Health.current[victim]).toBe(10);
    expect(world.runtimeEvents.filter((e) => e.type === "killed")).toHaveLength(0);
  });

  it("a) 跨图同坐标：自动拾取不吞他图物品", () => {
    const world = createMapWorld();
    setItemKind(world, { kind: "k1", maxStack: 20 });
    const player = spawnTestPlayer(world, { x: 0, y: 0, capacity: 2 });
    const item = spawnGroundItem(world, { x: 0, y: 0, kind: "k1", count: 2, map: OTHER_MAP });

    inventorySystem(world);

    expect(groundItemAlive(world, item)).toBe(true);
    expect(Inventory[player]!.slots[0]).toBeNull();
  });

  it("a) 跨图同坐标：交互路由跳过——interact/attack/talk 最近目标都不选他图", () => {
    const world = createMapWorld();
    setItemKind(world, { kind: "k1", maxStack: 20 });
    attachTalkTree(world);
    const player = spawnTestPlayer(world, {
      x: 0, y: 0, attack: { value: 10, range: 32 },
    });
    const node = spawnTestResource(world, { x: 10, y: 0, remaining: 3, yieldsKind: "k1", map: OTHER_MAP });
    const enemy = spawnTestHunter(world, { x: 12, y: 0, hp: 100, map: OTHER_MAP });
    // NPC 须是最近 NPC（enemy 也带 NPC tag）——talk 候选最近者优先
    const npc = spawnTalkableNpc(world, { x: 8, y: 0, map: OTHER_MAP });
    const interact = createInteractionSystem({ range: 24 });

    Intent[player] = "interact";
    interact(world);
    expect(Intent[player]).toBeNull();
    expect(ResourceNode[node]!.remaining).toBe(3);
    expect(Inventory[player]!.slots[0]).toBeNull();

    Intent[player] = "attack";
    interact(world);
    expect(Intent[player]).toBeNull();
    expect(Health.current[enemy]).toBe(100);

    Intent[player] = "talk";
    interact(world);
    expect(Intent[player]).toBeNull();
    expect(Dialogue[player]).toBeUndefined();
  });

  it("b) 同图回归：感知仍能发现同图最近敌对目标", () => {
    const world = createMapWorld();
    const hunter = spawnTestHunter(world, { x: 0, y: 0, visionRadius: 50 });
    const target = spawnTestPlayer(world, { x: 10, y: 0 });
    perceptionSystem(world);

    const bb = getOrCreateBlackboard(world, hunter);
    const found = bbGet<PerceivedTarget>(bb, BB_PERCEPTION_TARGET);
    expect(found?.eid).toBe(target);
    expect(found?.dist).toBe(10);
  });

  it("b) 同图回归：攻击命中扣血（冷却/射程语义不变）", () => {
    const world = createMapWorld();
    const attacker = spawnTestPlayer(world, {
      x: 0, y: 0, attack: { value: 10, range: 32 },
    });
    const enemy = spawnTestHunter(world, { x: 10, y: 0, hp: 100 });
    expect(attackTarget(world, attacker, enemy)).toBe(true);
    expect(Health.current[enemy]).toBe(90);
  });

  it("b) 同图回归：自动拾取并入背包并移除物品实体", () => {
    const world = createMapWorld();
    setItemKind(world, { kind: "k1", maxStack: 20 });
    const player = spawnTestPlayer(world, { x: 0, y: 0, capacity: 2 });
    const item = spawnGroundItem(world, { x: 0, y: 0, kind: "k1", count: 2 });

    inventorySystem(world);

    expect(groundItemAlive(world, item)).toBe(false);
    expect(Inventory[player]!.slots[0]).toEqual({ kind: "k1", count: 2 });
  });

  it("b) 同图回归：交互路由最近目标——interact 采集 / attack 命中 / talk 开对话", () => {
    const world = createMapWorld();
    setItemKind(world, { kind: "k1", maxStack: 20 });
    attachTalkTree(world);
    const player = spawnTestPlayer(world, {
      x: 0, y: 0, attack: { value: 10, range: 32 },
    });
    const node = spawnTestResource(world, { x: 10, y: 0, remaining: 3, yieldsKind: "k1" });
    const enemy = spawnTestHunter(world, { x: 12, y: 0, hp: 100 });
    // NPC 须是最近 NPC（enemy 也带 NPC tag）——talk 候选最近者优先
    const npc = spawnTalkableNpc(world, { x: 8, y: 0 });
    const interact = createInteractionSystem({ range: 24 });

    Intent[player] = "interact";
    interact(world);
    expect(ResourceNode[node]!.remaining).toBe(2);
    expect(Inventory[player]!.slots[0]).toEqual({ kind: "k1", count: 1 });

    // 采集期间未占满背包；attack 路由到最近 Enemy（12 距离，射程 32）
    Intent[player] = "attack";
    interact(world);
    expect(Health.current[enemy]).toBe(90);

    Intent[player] = "talk";
    interact(world);
    expect(Dialogue[player]).toBeDefined();
    expect(Dialogue[player]!.treeId).toBe("t1");
  });
});
