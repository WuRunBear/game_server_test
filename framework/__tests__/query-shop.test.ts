/**
 * CC-06 `/query/shop` 测试。
 *
 * 重点：价格与真实对话购买扣款一致（同一 `shopUnitPrice`），库存读 Ledger；
 * 关系折扣参与实价；无商店/未定价/无限货架/未知 NPC 的形状。
 */
import { addComponent, addEntity, query } from "bitecs";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  bootstrapFramework,
  createDefaultGameDefinition,
  createGameSimulation,
} from "framework/index";
import {
  Dialogue,
  DialogueSource,
  EntityMap,
  Inventory,
  Ledger,
  NetworkId,
  Player,
  Relation,
  Transform,
} from "components";
import { EntityLevel } from "framework/components/entityLevel";
import { Kind } from "framework/components/kind";
import { queryShop } from "framework/query/shop";
import {
  advanceDialogue,
  startDialogue,
} from "framework/systems/gameplay/dialogueSystem";
import type { DialogueTreeJson } from "framework/config/schema/DialogueSchema";
import type { GameWorld } from "world";
import type { SimulationPort } from "framework/simulation/SimulationPort";

beforeAll(() => {
  bootstrapFramework();
});

beforeEach(() => {
  for (let i = 0; i < Inventory.length; i++) Inventory[i] = undefined;
  for (let i = 0; i < Ledger.length; i++) Ledger[i] = undefined;
  for (let i = 0; i < DialogueSource.length; i++) DialogueSource[i] = undefined;
  for (let i = 0; i < Dialogue.length; i++) Dialogue[i] = undefined;
  for (let i = 0; i < Relation.length; i++) Relation[i] = undefined;
  for (let i = 0; i < EntityMap.length; i++) EntityMap[i] = undefined;
  for (let i = 0; i < EntityLevel.length; i++) EntityLevel[i] = undefined;
  for (let i = 0; i < Kind.length; i++) Kind[i] = undefined as unknown as string;
});

function simWorld(sim: SimulationPort): GameWorld {
  return (sim as unknown as { world: GameWorld }).world;
}

function shopTree(): DialogueTreeJson {
  return {
    id: "shop-tree",
    start: "start",
    nodes: {
      start: { text: "hi", options: [{ label: "shop", to: "shop" }] },
      shop: {
        text: "welcome",
        options: [
          {
            label: "buy axe",
            effect: { type: "buy", kind: "axe", count: 1, currency: "shell" },
            to: "shop",
          },
          {
            label: "buy mystery",
            effect: { type: "buy", kind: "mystery", count: 1, currency: "shell" },
            to: "shop",
          },
        ],
      },
    },
  };
}

async function setup() {
  const sim = await createGameSimulation(createDefaultGameDefinition());
  const world = simWorld(sim);
  world.gameDef.itemsByKind = new Map([
    ["axe", { kind: "axe", maxStack: 1, value: 5 }],
    ["shell", { kind: "shell", maxStack: 50, value: 1 }],
    ["mystery", { kind: "mystery", maxStack: 5 }],
  ]);
  world.gameDef.resolvedRules["dialogue"] = {
    talkRange: 48,
    trade: {
      discountPerRelation: 0.1,
      minPrice: 1,
      minFactor: 0.1,
      maxFactor: 3,
    },
  };
  const tree = shopTree();
  world.gameDef.resolvedDialogues = [tree];
  world.gameDef.dialoguesByKind = new Map([[tree.id, tree]]);

  const join = sim.addPlayer("s1");
  const playerEid = query(world, [Player])[0]!;
  Inventory[playerEid] = {
    capacity: 8,
    slots: [{ kind: "shell", count: 20 }, null, null, null, null, null, null, null],
  };
  Relation[playerEid] = [{ npcKind: "npc1", value: 2 }];

  const npc = addEntity(world);
  addComponent(world, npc, Transform);
  addComponent(world, npc, NetworkId);
  Transform.x[npc] = 10;
  Transform.y[npc] = 0;
  NetworkId.value[npc] = world.nextNetworkId++;
  EntityMap[npc] = world.defaultMapId;
  EntityLevel[npc] = 0;
  Kind[npc] = "npc1";
  DialogueSource[npc] = { treeId: "shop-tree" };
  Ledger[npc] = { shell: 100, axe: 2 };

  return {
    sim,
    world,
    playerEid,
    playerNetworkId: join.networkId,
    npcEid: npc,
    npcNetworkId: NetworkId.value[npc],
  };
}

function countOf(world: GameWorld, eid: number, kind: string): number {
  const inv = Inventory[eid];
  if (!inv) return 0;
  return inv.slots.reduce((total, slot) => (slot && slot.kind === kind ? total + slot.count : total), 0);
}

describe("queryShop", () => {
  it("实价走关系折扣；与真实购买扣款一致；库存读 Ledger", async () => {
    const { sim, world, playerEid, playerNetworkId, npcEid, npcNetworkId } = await setup();

    const result = sim.getQueryShop!({ playerNetworkId, npcNetworkId });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.data.currency).toBe("shell");
    const axe = result.data.items.find((item) => item.kind === "axe")!;
    // value=5，relation=2，discountPerRelation=0.1 → round(5 × 0.8) = 4
    expect(axe).toMatchObject({
      count: 2,
      price: 4,
      unlimited: false,
      packCount: 1,
      packPrice: 4,
    });
    // 未定价物品保留条目但 price/packPrice = null（不编造价格）
    expect(result.data.items.find((item) => item.kind === "mystery")).toMatchObject({
      price: null,
      packPrice: null,
    });

    expect(startDialogue(world, playerEid, npcEid)).toBe(true);
    expect(advanceDialogue(world, playerEid, 0)).toBe(true); // → shop
    expect(advanceDialogue(world, playerEid, 0)).toBe(true); // 买 axe
    expect(countOf(world, playerEid, "shell")).toBe(16);
    expect(countOf(world, playerEid, "axe")).toBe(1);
    expect(Ledger[npcEid]!.axe).toBe(1);
    expect(world.time.tick).toBe(0);
  });

  it("无限货架（无 Ledger）count=-1；无商店对话 items=[]；未知玩家/NPC → 404 语义", async () => {
    const { sim, world, playerEid, playerNetworkId, npcEid, npcNetworkId } = await setup();

    Ledger[npcEid] = undefined;
    const infinite = queryShop(world, { playerNetworkId, npcNetworkId });
    expect(infinite.ok).toBe(true);
    if (infinite.ok) {
      expect(infinite.data.items.find((item) => item.kind === "axe")).toMatchObject({
        count: -1,
        unlimited: true,
        price: 4,
      });
    }

    // 去掉对话源 → 空结果（不是 404）
    DialogueSource[npcEid] = undefined;
    expect(queryShop(world, { playerNetworkId, npcNetworkId })).toEqual({
      ok: true,
      data: { currency: "", items: [] },
    });

    expect(queryShop(world, { playerNetworkId: 999999, npcNetworkId })).toEqual({
      ok: false,
      error: "player_not_found",
    });
    expect(queryShop(world, { playerNetworkId, npcNetworkId: 999999 })).toEqual({
      ok: false,
      error: "npc_not_found",
    });

    // 非玩家实体不能当 player
    expect(queryShop(world, { playerNetworkId: npcNetworkId, npcNetworkId })).toEqual({
      ok: false,
      error: "player_not_found",
    });

    const before = JSON.stringify(Inventory[playerEid]);
    expect(sim.getQueryShop!({ playerNetworkId, npcNetworkId }).ok).toBe(true);
    expect(JSON.stringify(Inventory[playerEid])).toBe(before);
  });
});
