/**
 * CC-06 `/query/craft` 测试。
 *
 * 重点：解锁/站点/缺料/满包判定与 `craft` 命令同源（previewCraft），
 * reason 与 command-result 错误码在可归因时一致；查询无副作用。
 */
import { addComponent, addEntity, query } from "bitecs";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  bootstrapFramework,
  createDefaultGameDefinition,
  createGameSimulation,
} from "framework/index";
import {
  CraftingStation,
  EntityMap,
  Inventory,
  NetworkId,
  Player,
  Transform,
} from "components";
import { EntityLevel } from "framework/components/entityLevel";
import { Kind } from "framework/components/kind";
import { queryCraft } from "framework/query/craftPreview";
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

async function setup() {
  const sim = await createGameSimulation(createDefaultGameDefinition());
  const world = simWorld(sim);
  world.gameDef.itemsByKind = new Map([
    ["wood", { kind: "wood", maxStack: 50 }],
    ["axe", { kind: "axe", maxStack: 1 }],
    ["raw", { kind: "raw", maxStack: 10 }],
    ["cooked", { kind: "cooked", maxStack: 10 }],
  ]);
  world.gameDef.resolvedRules["crafting"] = {
    recipes: [
      { id: "free", inputs: [{ kind: "wood", count: 2 }], outputs: [{ kind: "axe", count: 1 }] },
      {
        id: "locked",
        unlock: { condition: "isNight" },
        inputs: [{ kind: "wood", count: 1 }],
        outputs: [{ kind: "axe", count: 1 }],
      },
      {
        id: "cook",
        stationType: 1,
        inputs: [{ kind: "raw", count: 1 }],
        outputs: [{ kind: "cooked", count: 1 }],
      },
      {
        id: "slow",
        durationTicks: 10,
        inputs: [{ kind: "wood", count: 1 }],
        outputs: [{ kind: "axe", count: 1 }],
      },
    ],
    stationRange: 64,
  };

  const join = sim.addPlayer("s1");
  const playerEid = query(world, [Player])[0]!;
  Inventory[playerEid] = {
    capacity: 4,
    slots: [
      { kind: "wood", count: 2 },
      { kind: "raw", count: 1 },
      null,
      null,
    ],
  };
  return { sim, world, playerEid, playerNetworkId: join.networkId };
}

function spawnStation(world: GameWorld, x: number, stationType = 1): number {
  const eid = addEntity(world);
  addComponent(world, eid, Transform);
  addComponent(world, eid, NetworkId);
  addComponent(world, eid, CraftingStation);
  Transform.x[eid] = x;
  Transform.y[eid] = 0;
  CraftingStation.stationType[eid] = stationType;
  NetworkId.value[eid] = world.nextNetworkId++;
  EntityMap[eid] = world.defaultMapId;
  EntityLevel[eid] = 0;
  return eid;
}

async function expectCraftConsistent(
  sim: SimulationPort,
  playerEid: number,
  playerNetworkId: number,
  recipeId: string,
  expected: { available: boolean; reason?: string; commandCode?: string },
) {
  const invBefore = JSON.stringify(Inventory[playerEid]);
  const tickBefore = simWorld(sim).time.tick;

  const preview = sim.getQueryCraft!({ playerNetworkId, recipeId });
  expect(preview.ok).toBe(true);
  if (!preview.ok) return;
  expect(preview.data.available).toBe(expected.available);
  if (expected.reason !== undefined) expect(preview.data.reason).toBe(expected.reason);
  expect(JSON.stringify(Inventory[playerEid])).toBe(invBefore);
  expect(simWorld(sim).time.tick).toBe(tickBefore);

  const command = sim.submitCommand("s1", { type: "craft", recipe: recipeId });
  expect(command.ok).toBe(expected.available);
  if (expected.commandCode !== undefined) expect(command).toEqual({ ok: false, code: expected.commandCode });
  return preview.data;
}

describe("queryCraft", () => {
  it("可用/缺料/未解锁/站点不符/满包：预览与 craft 命令一致", async () => {
    const { sim, world, playerEid, playerNetworkId } = await setup();

    const free = await expectCraftConsistent(sim, playerEid, playerNetworkId, "free", {
      available: true,
    });
    expect(free).toMatchObject({
      unlocked: true,
      missing: [],
      durationTicks: 0,
      station: { required: 0, available: true, range: 64 },
    });

    // 成功后木头 2 → 0；补料测缺料
    Inventory[playerEid]!.slots[0] = { kind: "wood", count: 1 };
    const missing = await expectCraftConsistent(sim, playerEid, playerNetworkId, "free", {
      available: false,
      reason: "no_item",
      commandCode: "no_item",
    });
    expect(missing!.missing).toEqual([{ kind: "wood", count: 1 }]);

    const locked = await expectCraftConsistent(sim, playerEid, playerNetworkId, "locked", {
      available: false,
      reason: "locked",
      // unlock 条件在命令通道无法精确归因 → unknown（不编造）
      commandCode: "unknown",
    });
    expect(locked!.unlocked).toBe(false);

    const noStation = await expectCraftConsistent(sim, playerEid, playerNetworkId, "cook", {
      available: false,
      reason: "out_of_range",
      commandCode: "out_of_range",
    });
    expect(noStation!.station).toMatchObject({ required: 1, available: false, range: 64 });

    spawnStation(world, 10, 1);
    const withStation = await expectCraftConsistent(sim, playerEid, playerNetworkId, "cook", {
      available: true,
    });
    expect(withStation!.station).toMatchObject({ required: 1, available: true });

    // 满包：capacity 1 且唯一槽位被占 → 产出放不下（先验后耗，命令也失败）
    Inventory[playerEid] = { capacity: 1, slots: [{ kind: "wood", count: 2 }] };
    const full = await expectCraftConsistent(sim, playerEid, playerNetworkId, "free", {
      available: false,
      reason: "inventory_full",
      commandCode: "inventory_full",
    });
    expect(full!.missing).toEqual([]);
  });

  it("延时配方的 durationTicks 透出；未知配方/玩家/无背包映射正确", async () => {
    const { sim, world, playerEid, playerNetworkId } = await setup();
    Inventory[playerEid] = { capacity: 4, slots: [{ kind: "wood", count: 1 }, null, null, null] };

    const slow = sim.getQueryCraft!({ playerNetworkId, recipeId: "slow" });
    expect(slow).toMatchObject({
      ok: true,
      data: { available: true, durationTicks: 10, unlocked: true },
    });

    expect(sim.getQueryCraft!({ playerNetworkId, recipeId: "nope" })).toEqual({
      ok: false,
      error: "recipe_not_found",
    });
    expect(sim.getQueryCraft!({ playerNetworkId: 999999, recipeId: "free" })).toEqual({
      ok: false,
      error: "player_not_found",
    });

    Inventory[playerEid] = undefined;
    const noInv = sim.getQueryCraft!({ playerNetworkId, recipeId: "free" });
    expect(noInv).toMatchObject({ ok: true, data: { available: false, reason: "invalid" } });
    expect(sim.submitCommand("s1", { type: "craft", recipe: "free" })).toEqual({
      ok: false,
      code: "invalid",
    });
    expect(queryCraft(world, { playerNetworkId, recipeId: "free" }).ok).toBe(true);
    expect(world.time.tick).toBe(0);
  });
});
