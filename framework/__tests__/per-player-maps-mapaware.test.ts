/**
 * 分图（per-player maps）map-aware 测试（per-player-maps 计划 todo 9）。
 *
 * 覆盖：
 * - respawnSystem：玩家死亡重生回**自己所在图**的出生点（非他图出生点、非 (0,0)）
 * - placement：放置校验用放置者所在图的网格/阻挡（同格 A 挡 B 不挡）；
 *   deconstruct 同图才可拆（跨图即便所有权+距离通过也拒）
 * - AI 边界：Flee 移动按自己所在图的像素边界钳制（同位置不同图结果不同）
 * - startDialogue：跨图对话拒、同图对话放行
 *
 * 地图运行时手工构造直写 world.maps（同 slice6 attachTestMap 的手工 MapGeometry
 * 思路，几何完全可控），实体统一经 spawnEntity overrides.mapId（T4）归属地图。
 */
import { makeTestGeometry } from "./helpers/mapGeometry";
import { describe, it, expect, beforeAll } from "vitest";
import { query } from "bitecs";
import {
  bootstrapFramework,
  createGameInstance,
  createDefaultGameDefinition,
  spawnEntity,
  getRegistries,
  startDialogue,
} from "framework/index";
import { Transform } from "framework/components/transform";
import { Velocity } from "framework/components/physics";
import { Health } from "framework/components/combat";
import { NetworkId } from "framework/components/network";
import { EntityMap } from "framework/components/entityMap";
import { Dialogue } from "framework/components/dialogue";
import { DialogueSource } from "framework/components/dialogueSource";
import { Placeable } from "framework/components/placeable";
import { GridOccupancy } from "framework/components/gridOccupancy";
import { Inventory } from "framework/components/inventory";
import { respawnSystem } from "framework/systems/gameplay/respawnSystem";
import { deathSystem } from "framework/systems/gameplay/deathSystem";
import { placeEntity } from "framework/systems/gameplay/placeableSystem";
import { deconstructEntity } from "framework/systems/gameplay/deconstructSystem";
import { createActionRegistry } from "framework/ai/actionRegistry";
import { registerBuiltinActions } from "framework/ai/registerBuiltinActions";
import { createNpcTree } from "framework/ai/btFactory";
import { createBlackboard, bbSet, BB_PERCEPTION_TARGET } from "framework/ai/blackboard";
import { stepBehaviourTree } from "framework/ai/btRunner";
import type { GameWorld } from "framework/world";
import type { ItemKindSpec } from "framework/config/schema/ItemKindSchema";
import type { DialogueTreeJson } from "framework/config/schema/DialogueSchema";

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

/** 清空 EntityMap 模块级单例残留（AoS 数组跨 world 复用 eid，防跨用例串扰）。 */
function clearEntityMap(): void {
  for (let i = 0; i < EntityMap.length; i++) EntityMap[i] = undefined;
}

/** 确保运行期原型可用：玩家（Player+Health）/ 敌人（Velocity）。 */
function ensureRuntimeArchetypes(world: GameWorld): void {
  ensureArchetype(world, {
    kind: "t9-player",
    tags: ["Player"],
    components: { Health: { current: 100, max: 100 } },
  });
  ensureArchetype(world, {
    kind: "t9-enemy",
    components: { Velocity: {} },
  });
}

/** 手工构造 MapGeometry 直写 world.maps（几何完全可控：尺寸/单格阻挡）。 */
function installMap(
  world: GameWorld,
  id: string,
  opts: { width: number; height: number; player: { x: number; y: number }; blockedCell?: number },
): void {
  const blockedCol = opts.blockedCell !== undefined ? opts.blockedCell % opts.width : -1;
  const blockedRow = opts.blockedCell !== undefined ? Math.floor(opts.blockedCell / opts.width) : -1;
  world.maps[id] = makeTestGeometry({
    key: id,
    width: opts.width,
    height: opts.height,
    blocked: (tx, ty) => tx === blockedCol && ty === blockedRow,
  });
  world.activeMaps.add(id);
}

/** 放置链路配置：可放置原型（Placeable+GridOccupancy 16×16）+ 物品 + gridSnap 规则。 */
function setupPlaceRule(world: GameWorld): void {
  ensureArchetype(world, {
    kind: "t9-wall",
    components: {
      Size: { w: 16, h: 16 },
      Collider: { shape: 1, halfW: 8, halfH: 8 },
      Placeable: { footprintW: 16, footprintH: 16, canCollide: 1 },
      GridOccupancy: {},
    },
  });
  const item: ItemKindSpec = { kind: "t9-k1", maxStack: 1, place: { archetype: "t9-wall" } };
  world.gameDef.itemsByKind!.set(item.kind, item);
  world.gameDef.resolvedRules["place"] = { placeRange: 128, gridSnap: true };
}

/** 对话链路配置：DialogueSource NPC 原型 + 对话树（镜像 slice7 setupDialogueWorld）。 */
function setupDialogue(world: GameWorld): void {
  ensureArchetype(world, {
    kind: "t9-npc",
    tags: ["NPC"],
    components: {
      Size: { w: 16, h: 16 },
      Collider: { shape: 1, halfW: 8, halfH: 8 },
      Health: { current: 50, max: 50 },
      DialogueSource: { treeId: "t9" },
    },
  });
  const tree: DialogueTreeJson = {
    id: "t9",
    start: "start",
    nodes: {
      start: {
        text: "hi",
        options: [{ label: "bye", to: "__end__" }],
      },
    },
  };
  world.gameDef.resolvedDialogues = [tree];
  world.gameDef.dialoguesByKind = new Map([[tree.id, tree]]);
}

function spawn(
  world: GameWorld,
  kind: string,
  opts: { x: number; y: number; mapId: string },
): number {
  return spawnEntity(world, world.archetypes.get(kind), getRegistries().componentRegistry, opts);
}

describe("map-aware", () => {
  it("a) 玩家死亡重生回自己图几何中心（非他图中心、非 (0,0)）", () => {
    const world = createBareWorld();
    clearEntityMap();
    ensureRuntimeArchetypes(world);
    // a/b 中心刻意不同（8×8 → 64,64；12×12 → 96,96），且均非 (0,0)
    // （出生服务归后续 todo；当前重生占位 = 所在图几何中心）
    installMap(world, "a", { width: 8, height: 8, player: { x: 10, y: 12 } });
    installMap(world, "b", { width: 12, height: 12, player: { x: 200, y: 222 } });
    world.gameDef.resolvedRules["respawn"] = { delayMs: 0 };

    const player = spawn(world, "t9-player", { x: 50, y: 50, mapId: "a" });
    Health.current[player] = 0;
    deathSystem(world);
    respawnSystem(world);

    expect(Health.current[player]).toBe(100);
    expect(Transform.x[player]).toBe(64);
    expect(Transform.y[player]).toBe(64);
    // 不是 b 图中心，也不是 (0,0)
    expect(Transform.x[player]).not.toBe(96);
    expect(Transform.y[player]).not.toBe(96);
  });

  it("b1) 放置校验用放置者所在图：同格 A 挡 B 不挡，产物归放置者图", () => {
    const world = createBareWorld();
    clearEntityMap();
    ensureRuntimeArchetypes(world);
    setupPlaceRule(world);
    // 两图同尺寸，仅 a 的 cell (2,1)（index 1*4+2=6）阻挡——b 同格自由
    installMap(world, "a", { width: 4, height: 4, player: { x: 0, y: 0 }, blockedCell: 6 });
    installMap(world, "b", { width: 4, height: 4, player: { x: 0, y: 0 } });

    const pa = spawn(world, "t9-player", { x: 0, y: 0, mapId: "a" });
    const pb = spawn(world, "t9-player", { x: 0, y: 0, mapId: "b" });
    const give = (eid: number): void => {
      Inventory[eid] = { capacity: 4, slots: [{ kind: "t9-k1", count: 1 }, null, null, null] };
    };
    give(pa);
    give(pb);

    // 同一目标坐标（40, 24 = 格 (2,1) 中心）：A 的阻挡格拒绝、B 的同格放行
    expect(placeEntity(world, pa, 0, 40, 24)).toBe(false);
    expect(placeEntity(world, pb, 0, 40, 24)).toBe(true);
    const walls = query(world, [Placeable]);
    expect(walls.length).toBe(1);
    expect(EntityMap[walls[0]]).toBe("b");
    expect(GridOccupancy.cellX[walls[0]]).toBe(2);
    expect(GridOccupancy.cellY[walls[0]]).toBe(1);
  });

  it("b2) deconstruct 同图才可拆：跨图即便所有权+距离通过也拒", () => {
    const world = createBareWorld();
    clearEntityMap();
    ensureRuntimeArchetypes(world);
    setupPlaceRule(world);
    installMap(world, "a", { width: 4, height: 4, player: { x: 0, y: 0 } });
    installMap(world, "b", { width: 4, height: 4, player: { x: 0, y: 0 } });

    const pa = spawn(world, "t9-player", { x: 0, y: 0, mapId: "a" });
    // 手工制造"pa 所有但落在 b 图"的墙：owner+距离都满足，仅地图不同 → 必须拒
    const foreignWall = spawn(world, "t9-wall", { x: 40, y: 24, mapId: "b" });
    Placeable.ownerNetworkId[foreignWall] = NetworkId.value[pa];
    expect(deconstructEntity(world, pa, NetworkId.value[foreignWall])).toBe(false);
    expect(query(world, [Placeable]).length).toBe(1);

    // 同图基线：pa 在 a 图放置一墙 → 可拆（跨图的 foreignWall 不受影响仍在）
    Inventory[pa] = { capacity: 4, slots: [{ kind: "t9-k1", count: 1 }, null, null, null] };
    expect(placeEntity(world, pa, 0, 40, 24)).toBe(true);
    const ownWall = query(world, [Placeable]).find((e) => EntityMap[e] === "a")!;
    expect(deconstructEntity(world, pa, NetworkId.value[ownWall])).toBe(true);
    expect(query(world, [Placeable])).toEqual([foreignWall]);
  });

  it("c) AI 边界按自己图钳制：同位置 A 贴边回弹、B 照常前进", () => {
    const world = createBareWorld();
    clearEntityMap();
    ensureRuntimeArchetypes(world);
    // a 是 4×4（64px）窄图，b 是 8×8（128px）宽图——(60, 32) 在 a 近右缘、在 b 距离右缘尚远
    installMap(world, "a", { width: 4, height: 4, player: { x: 0, y: 0 } });
    installMap(world, "b", { width: 8, height: 8, player: { x: 0, y: 0 } });

    const target = spawn(world, "t9-enemy", { x: 40, y: 32, mapId: "a" });
    const selfA = spawn(world, "t9-enemy", { x: 60, y: 32, mapId: "a" });
    const selfB = spawn(world, "t9-enemy", { x: 60, y: 32, mapId: "b" });

    const registry = createActionRegistry();
    registerBuiltinActions(registry);
    const inst = createNpcTree({ type: "root", child: { type: "action", call: "Flee" } }, registry);
    for (const self of [selfA, selfB]) {
      const bb = createBlackboard(self);
      bbSet(bb, BB_PERCEPTION_TARGET, { eid: target, dist: 10 });
      stepBehaviourTree(inst, { world, self, bb });
    }

    // A：60 > 64-16 → 向 +x 被回弹成 -x；B：60 < 128-16 → 保持 +x（同一位置不同图结果不同）
    expect(Velocity.vx[selfA]).toBeLessThan(0);
    expect(Velocity.vx[selfB]).toBeGreaterThan(0);
    expect(Velocity.vy[selfA]).toBe(0);
    expect(Velocity.vy[selfB]).toBe(0);
  });

  it("d) 对话同图才可开始：跨图拒、同图放行", () => {
    const world = createBareWorld();
    clearEntityMap();
    ensureRuntimeArchetypes(world);
    setupDialogue(world);
    installMap(world, "a", { width: 8, height: 8, player: { x: 0, y: 0 } });
    installMap(world, "b", { width: 8, height: 8, player: { x: 0, y: 0 } });

    const player = spawn(world, "t9-player", { x: 0, y: 0, mapId: "a" });
    const npcA = spawn(world, "t9-npc", { x: 10, y: 0, mapId: "a" });
    const npcB = spawn(world, "t9-npc", { x: 10, y: 0, mapId: "b" });
    Dialogue[player] = undefined;

    // 跨图拒（NPC 在同范围距离内，仅地图不同）
    expect(startDialogue(world, player, npcB)).toBe(false);
    expect(Dialogue[player]).toBeUndefined();
    // 同图放行
    expect(startDialogue(world, player, npcA)).toBe(true);
    expect(Dialogue[player]!.npcId).toBe(NetworkId.value[npcA]);
  });
});
