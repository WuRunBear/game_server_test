/**
 * CC-06 `/query/affordances` 查询模块测试。
 *
 * 覆盖：同图/同层/半径候选、gather/attack/talk/open/loot/deconstruct 的
 * 可用性与机器可读 reason、玩家坐标覆盖、空结果、未知玩家/地图、无副作用。
 */
import { addComponent, addEntity } from "bitecs";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  bootstrapFramework,
  createDefaultGameDefinition,
  createGameInstance,
} from "framework/index";
import {
  Attack,
  Container,
  DialogueSource,
  Enemy,
  EntityMap,
  Health,
  Inventory,
  Kind,
  Ledger,
  NetworkId,
  NPC,
  Passage,
  Placeable,
  Player,
  Progression,
  Quest,
  Relation,
  Resource,
  ResourceNode,
  Achievements,
  Transform,
} from "components";
import { EntityLevel } from "framework/components/entityLevel";
import { queryAffordances } from "framework/query/affordances";
import { makeTestGeometry } from "framework/__tests__/helpers/mapGeometry";
import type { GameWorld } from "world";

beforeAll(() => {
  bootstrapFramework();
});

/** 清理 AoS 模块级单例（跨世界 eid 复用防串扰）。 */
function clearAos(): void {
  for (const arr of [
    Inventory,
    ResourceNode,
    DialogueSource,
    Ledger,
    Quest,
    Achievements,
    Progression,
    Relation,
    EntityMap,
    EntityLevel,
    Kind,
  ]) {
    for (let i = 0; i < arr.length; i++) (arr as unknown[])[i] = undefined;
  }
}

beforeEach(clearAos);

function makeWorld(): GameWorld {
  const world = createGameInstance(createDefaultGameDefinition()).world;
  world.defaultMapId = "test-map";
  world.maps["test-map"] = makeTestGeometry({ key: "test-map", width: 64, height: 64 });
  world.maps["other-map"] = makeTestGeometry({ key: "other-map", width: 64, height: 64 });
  world.gameDef.systems = [{ id: "interaction", config: { range: 24 } }];
  world.gameDef.itemsByKind = new Map([["wood", { kind: "wood", maxStack: 50 }]]);
  world.gameDef.dialoguesByKind = new Map([
    [
      "shop-tree",
      { id: "shop-tree", start: "start", nodes: { start: { text: "hi", options: [] } } },
    ],
  ]);
  return world;
}

function spawnBase(
  world: GameWorld,
  opts: { x?: number; y?: number; mapId?: string; level?: number; kind?: string } = {},
): number {
  const eid = addEntity(world);
  addComponent(world, eid, Transform);
  addComponent(world, eid, NetworkId);
  Transform.x[eid] = opts.x ?? 0;
  Transform.y[eid] = opts.y ?? 0;
  NetworkId.value[eid] = world.nextNetworkId++;
  EntityMap[eid] = opts.mapId ?? "test-map";
  EntityLevel[eid] = opts.level ?? 0;
  Kind[eid] = opts.kind ?? "test";
  return eid;
}

function spawnPlayer(world: GameWorld, x = 100, y = 100): number {
  const eid = spawnBase(world, { x, y, kind: "player" });
  addComponent(world, eid, Player);
  addComponent(world, eid, Health);
  addComponent(world, eid, Attack);
  Health.current[eid] = 100;
  Health.max[eid] = 100;
  Attack.value[eid] = 10;
  Attack.range[eid] = 32;
  Inventory[eid] = { capacity: 8, slots: Array.from({ length: 8 }, () => null) };
  return eid;
}

function spawnResource(
  world: GameWorld,
  opts: { x: number; y: number; remaining?: number; requiredToolType?: string; mapId?: string; level?: number },
): number {
  const eid = spawnBase(world, {
    x: opts.x,
    y: opts.y,
    kind: "tree",
    mapId: opts.mapId,
    level: opts.level,
  });
  addComponent(world, eid, Resource);
  ResourceNode[eid] = {
    remaining: opts.remaining ?? 3,
    max: 3,
    amountPerHit: 1,
    regenMs: 0,
    yieldsKind: "wood",
    directConsume: false,
    depletedSinceMs: null,
    ...(opts.requiredToolType ? { requiredToolType: opts.requiredToolType } : {}),
  };
  return eid;
}

function spawnEnemy(world: GameWorld, x: number, y: number, hp = 10): number {
  const eid = spawnBase(world, { x, y, kind: "boar" });
  addComponent(world, eid, Enemy);
  addComponent(world, eid, Health);
  Health.current[eid] = hp;
  Health.max[eid] = 10;
  return eid;
}

function spawnNpc(world: GameWorld, x: number, y: number, treeId?: string): number {
  const eid = spawnBase(world, { x, y, kind: "villager" });
  addComponent(world, eid, NPC);
  if (treeId !== undefined) DialogueSource[eid] = { treeId };
  return eid;
}

describe("queryAffordances", () => {
  it("同图/同层/半径候选 + 六类动作的可用性与 reason", () => {
    const world = makeWorld();
    const player = spawnPlayer(world);
    const tree = spawnResource(world, { x: 110, y: 100 });
    const farTree = spawnResource(world, { x: 300, y: 100 });
    const toolTree = spawnResource(world, { x: 104, y: 100, requiredToolType: "axe" });
    const depleted = spawnResource(world, { x: 106, y: 100, remaining: 0 });
    const enemy = spawnEnemy(world, 120, 100);
    const corpse = spawnEnemy(world, 125, 100, 0);
    const npc = spawnNpc(world, 100, 140, "shop-tree");
    const muteNpc = spawnNpc(world, 100, 144);
    const passage = spawnBase(world, { x: 100, y: 120, kind: "door" });
    addComponent(world, passage, Passage);
    const container = spawnBase(world, { x: 150, y: 100, kind: "chest" });
    addComponent(world, container, Container);
    Inventory[container] = { capacity: 2, slots: [{ kind: "wood", count: 1 }, null] };
    const emptyContainer = spawnBase(world, { x: 152, y: 100, kind: "chest" });
    addComponent(world, emptyContainer, Container);
    Inventory[emptyContainer] = { capacity: 2, slots: [null, null] };
    const wall = spawnBase(world, { x: 160, y: 100, kind: "wall" });
    addComponent(world, wall, Placeable);
    Placeable.ownerNetworkId[wall] = 999;
    // 干扰项：异图/异层不可作为候选
    spawnResource(world, { x: 103, y: 100, mapId: "other-map" });
    spawnResource(world, { x: 103, y: 100, level: 1 });

    const result = queryAffordances(world, {
      playerNetworkId: NetworkId.value[player],
      radius: 250,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const byId = new Map(result.data.entities.map((entity) => [entity.networkId, entity]));
    expect(byId.size).toBe(12);
    expect(result.data.entities.some((e) => e.kind === "tree" && e.level === 1)).toBe(false);
    expect(result.data.entities.some((e) => e.x === 103 && e.y === 100 && e.distance === 3)).toBe(false);

    const gather = byId.get(NetworkId.value[tree])!.actions.find((a) => a.id === "gather")!;
    expect(gather).toMatchObject({ available: true, range: 24 });

    const tooFar = byId.get(NetworkId.value[farTree])!.actions.find((a) => a.id === "gather")!;
    expect(tooFar).toMatchObject({ available: false, reason: "out_of_range" });

    const noTool = byId.get(NetworkId.value[toolTree])!.actions.find((a) => a.id === "gather")!;
    expect(noTool).toMatchObject({ available: false, reason: "no_tool" });

    const gone = byId.get(NetworkId.value[depleted])!.actions.find((a) => a.id === "gather")!;
    expect(gone).toMatchObject({ available: false, reason: "depleted" });

    const hit = byId.get(NetworkId.value[enemy])!.actions.find((a) => a.id === "attack")!;
    expect(hit).toMatchObject({ available: true, range: 32 });

    const dead = byId.get(NetworkId.value[corpse])!.actions.find((a) => a.id === "attack")!;
    expect(dead).toMatchObject({ available: false, reason: "dead" });

    const talk = byId.get(NetworkId.value[npc])!.actions.find((a) => a.id === "talk")!;
    expect(talk).toMatchObject({ available: true, range: 48 });

    const mute = byId.get(NetworkId.value[muteNpc])!.actions.find((a) => a.id === "talk")!;
    expect(mute).toMatchObject({ available: false, reason: "invalid" });

    const open = byId.get(NetworkId.value[passage])!.actions.find((a) => a.id === "open")!;
    expect(open).toMatchObject({ available: true, range: 24 });

    const loot = byId.get(NetworkId.value[container])!.actions.find((a) => a.id === "loot")!;
    expect(loot).toMatchObject({ available: true, range: 64 });

    const empty = byId.get(NetworkId.value[emptyContainer])!.actions.find((a) => a.id === "loot")!;
    expect(empty).toMatchObject({ available: false, reason: "empty" });

    const deconstruct = byId.get(NetworkId.value[wall])!.actions.find((a) => a.id === "deconstruct")!;
    expect(deconstruct).toMatchObject({ available: false, reason: "not_owner" });

    // 响应不含 eid
    expect(JSON.stringify(result.data)).not.toContain("eid");
  });

  it("缺省 x/y 用玩家当前位置；空半径结果为空", () => {
    const world = makeWorld();
    const player = spawnPlayer(world, 100, 100);
    spawnResource(world, { x: 110, y: 100 });

    const fromPlayer = queryAffordances(world, { playerNetworkId: NetworkId.value[player] });
    expect(fromPlayer.ok && fromPlayer.data.entities).toHaveLength(1);

    const empty = queryAffordances(world, {
      playerNetworkId: NetworkId.value[player],
      radius: 1,
    });
    expect(empty).toEqual({ ok: true, data: { entities: [] } });

    const atPoint = queryAffordances(world, {
      playerNetworkId: NetworkId.value[player],
      x: 500,
      y: 500,
      level: 0,
      radius: 10,
    });
    expect(atPoint).toEqual({ ok: true, data: { entities: [] } });
  });

  it("未知玩家 / 归属图不存在 → 错误信封；查询前后 tick/背包/任务不变", () => {
    const world = makeWorld();
    const player = spawnPlayer(world);
    Quest[player] = [{ questId: "q1", state: 1, count: 2 }];
    const tick = world.time.tick;
    const invBefore = JSON.stringify(Inventory[player]);
    const questBefore = JSON.stringify(Quest[player]);

    expect(queryAffordances(world, { playerNetworkId: 999999 })).toEqual({
      ok: false,
      error: "player_not_found",
    });

    const ok = queryAffordances(world, { playerNetworkId: NetworkId.value[player] });
    expect(ok.ok).toBe(true);
    expect(world.time.tick).toBe(tick);
    expect(JSON.stringify(Inventory[player])).toBe(invBefore);
    expect(JSON.stringify(Quest[player])).toBe(questBefore);

    EntityMap[player] = "missing-map";
    expect(queryAffordances(world, { playerNetworkId: NetworkId.value[player] })).toEqual({
      ok: false,
      error: "map_not_found",
    });
  });

  it("死亡玩家所有动作 reason=dead", () => {
    const world = makeWorld();
    const player = spawnPlayer(world);
    Health.current[player] = 0;
    spawnResource(world, { x: 110, y: 100 });

    const result = queryAffordances(world, { playerNetworkId: NetworkId.value[player] });
    const actions = result.ok ? result.data.entities.flatMap((e) => e.actions) : [];
    expect(actions.length).toBeGreaterThan(0);
    expect(actions.every((a) => a.available === false && a.reason === "dead")).toBe(true);
  });
});
