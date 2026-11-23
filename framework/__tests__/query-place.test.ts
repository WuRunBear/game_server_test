/**
 * CC-06 `/query/place` 测试。
 *
 * 重点：预览 valid/reason 与真实 `place` 命令的 command-result 一致
 * （空地成功 / 已占用 blocked / 超距 out_of_range / 无物品 no_item），
 * 并验证占用投影不含 eid、查询本身不改背包/不推进 tick。
 */
import { query } from "bitecs";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  bootstrapFramework,
  createDefaultGameDefinition,
  createGameSimulation,
} from "framework/index";
import {
  Collider,
  EntityMap,
  Inventory,
  NetworkId,
  Player,
  Transform,
} from "components";
import { EntityLevel } from "framework/components/entityLevel";
import { Kind } from "framework/components/kind";
import { queryPlace } from "framework/query/placePreview";
import { makeTestGeometry } from "framework/__tests__/helpers/mapGeometry";
import type { GameWorld } from "world";
import type { SimulationPort } from "framework/simulation/SimulationPort";

beforeAll(() => {
  bootstrapFramework();
});

beforeEach(() => {
  for (let i = 0; i < Inventory.length; i++) Inventory[i] = undefined;
  for (let i = 0; i < EntityMap.length; i++) EntityMap[i] = undefined;
  for (let i = 0; i < EntityLevel.length; i++) EntityLevel[i] = undefined;
  for (let i = 0; i < Kind.length; i++) Kind[i] = undefined as unknown as string;
});

function simWorld(sim: SimulationPort): GameWorld {
  return (sim as unknown as { world: GameWorld }).world;
}

/** 建立带 128×128 全可走测试图的仿真 + 一个玩家。 */
async function setup() {
  const sim = await createGameSimulation(createDefaultGameDefinition());
  const world = simWorld(sim);
  world.defaultMapId = "test-map";
  world.maps["test-map"] = makeTestGeometry({ key: "test-map", width: 128, height: 128 });

  // 可放置目标原型（带碰撞体，便于验证“已占用”）
  world.archetypes.override({
    kind: "test_camp",
    components: {
      Placeable: { footprintW: 16, footprintH: 16, canCollide: 1 },
      Collider: { shape: 1, halfW: 8, halfH: 8 },
    },
  });
  world.gameDef.itemsByKind = new Map([
    [
      "camp_kit",
      { kind: "camp_kit", maxStack: 1, place: { archetype: "test_camp" } },
    ],
    ["plain_rock", { kind: "plain_rock", maxStack: 5 }],
  ]);

  const join = sim.addPlayer("s1");
  const playerEid = query(world, [Player])[0]!;
  EntityMap[playerEid] = "test-map";
  EntityLevel[playerEid] = 0;
  Transform.x[playerEid] = 80;
  Transform.y[playerEid] = 80;
  Inventory[playerEid] = {
    capacity: 4,
    slots: [
      { kind: "camp_kit", count: 2 },
      null,
      null,
      { kind: "plain_rock", count: 1 },
    ],
  };
  return { sim, world, playerEid, playerNetworkId: join.networkId };
}

/** 同一输入先查预览再发命令，断言 valid/reason 与 command-result 一致。 */
async function expectConsistent(
  sim: SimulationPort,
  playerEid: number,
  playerNetworkId: number,
  input: { slot: number; x: number; y: number },
  expected: { valid: boolean; reason?: string; code?: string },
) {
  const invBefore = JSON.stringify(Inventory[playerEid]);
  const tickBefore = simWorld(sim).time.tick;

  const preview = sim.getQueryPlace!({ playerNetworkId, ...input });
  expect(preview.ok).toBe(true);
  if (!preview.ok) return;

  expect(preview.data.valid).toBe(expected.valid);
  if (expected.reason !== undefined) expect(preview.data.reason).toBe(expected.reason);
  expect(JSON.stringify(Inventory[playerEid])).toBe(invBefore);
  expect(simWorld(sim).time.tick).toBe(tickBefore);

  const command = sim.submitCommand("s1", {
    type: "place",
    slot: input.slot,
    x: input.x,
    y: input.y,
  });
  expect(command.ok).toBe(expected.valid);
  if (!expected.valid) expect(command).toEqual({ ok: false, code: expected.code });
  return preview.data;
}

describe("queryPlace", () => {
  it("空地有效；占用 blocked；超距 out_of_range；无物品/不可放置的 reason 与命令一致", async () => {
    const { sim, playerEid, playerNetworkId } = await setup();

    const empty = await expectConsistent(
      sim,
      playerEid,
      playerNetworkId,
      { slot: 0, x: 96, y: 80 },
      { valid: true },
    );
    expect(empty).toMatchObject({
      footprint: { w: 16, h: 16 },
      occupiedBy: [],
      ownerNetworkId: playerNetworkId,
      canDeconstruct: false,
      x: 96,
      y: 80,
      level: 0,
    });
    expect(empty!.cells.length).toBeGreaterThan(0);

    // 同一位置已放置 → 占位实体可见（networkId/kind，不含 eid）
    const occupied = await expectConsistent(
      sim,
      playerEid,
      playerNetworkId,
      { slot: 0, x: 96, y: 80 },
      { valid: false, reason: "blocked", code: "blocked" },
    );
    expect(occupied!.occupiedBy).toHaveLength(1);
    expect(occupied!.occupiedBy[0]).toMatchObject({ kind: "test_camp" });
    expect(occupied!.occupiedBy[0]!.ownerNetworkId).toBe(playerNetworkId);
    expect(occupied!.canDeconstruct).toBe(true);
    expect(JSON.stringify(occupied)).not.toContain("eid");

    await expectConsistent(
      sim,
      playerEid,
      playerNetworkId,
      { slot: 0, x: 300, y: 80 },
      { valid: false, reason: "out_of_range", code: "out_of_range" },
    );

    await expectConsistent(
      sim,
      playerEid,
      playerNetworkId,
      { slot: 1, x: 96, y: 96 },
      { valid: false, reason: "no_item", code: "no_item" },
    );

    await expectConsistent(
      sim,
      playerEid,
      playerNetworkId,
      { slot: 3, x: 96, y: 96 },
      { valid: false, reason: "invalid", code: "invalid" },
    );
  });

  it("未知玩家 / 地图不存在 → 错误信封；预览不消耗物品", async () => {
    const { sim, world, playerEid, playerNetworkId } = await setup();
    const before = JSON.stringify(Inventory[playerEid]);

    expect(queryPlace(world, { playerNetworkId: 999999, slot: 0, x: 96, y: 80 })).toEqual({
      ok: false,
      error: "player_not_found",
    });
    expect(sim.getQueryPlace!({ playerNetworkId: 999999, slot: 0, x: 96, y: 80 })).toEqual({
      ok: false,
      error: "player_not_found",
    });
    expect(JSON.stringify(Inventory[playerEid])).toBe(before);

    EntityMap[playerEid] = "missing-map";
    expect(queryPlace(world, { playerNetworkId, slot: 0, x: 96, y: 80 })).toEqual({
      ok: false,
      error: "map_not_found",
    });
  });

  it("已在他人所有权下的占位实体不被标为可拆", async () => {
    const { sim, world, playerEid, playerNetworkId } = await setup();
    // 在目标点手动放一个别人的放置物
    const { spawnEntity } = await import("framework/entities/spawn");
    const { getRegistries } = await import("framework/bootstrap");
    const eid = spawnEntity(
      world,
      world.archetypes.get("test_camp"),
      getRegistries().componentRegistry,
      { x: 96, y: 80, mapId: "test-map", level: 0 },
    );
    const { Placeable } = await import("components");
    Placeable.ownerNetworkId[eid] = 42;
    // 放置物碰撞体已占位，预览失败但可拆标记应为 false
    const preview = queryPlace(world, {
      playerNetworkId,
      slot: 0,
      x: 96,
      y: 80,
    });
    expect(preview.ok).toBe(true);
    if (!preview.ok) return;
    expect(preview.data.valid).toBe(false);
    expect(preview.data.occupiedBy[0]).toMatchObject({
      networkId: NetworkId.value[eid],
      kind: "test_camp",
      ownerNetworkId: 42,
      canDeconstruct: false,
    });
    expect(preview.data.canDeconstruct).toBe(false);
    expect(Inventory[playerEid]!.slots[0]).toEqual({ kind: "camp_kit", count: 2 });
    expect(sim.getQueryPlace!({ playerNetworkId, slot: 0, x: 96, y: 80 }).ok).toBe(true);
  });
});
