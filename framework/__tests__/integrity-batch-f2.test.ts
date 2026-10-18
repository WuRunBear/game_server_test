/**
 * 批次 F2 回归：桩/死组件清理、死事件求值器、商店库存/资金。
 *
 * - F-38：已删除的零消费者组件不再注册（防止配置/编辑器继续引用死组件）。
 * - F-39：`on-item-break` / `on-achievement` 内建求值器可被实体 Triggers 配置消费。
 * - F-44：商贩实体挂 Ledger 时 = 有限库存/资金；无 Ledger = 无限货架旧语义；
 *   库存/资金随实体入档，重启后保留。
 */
import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { query } from "bitecs";
import {
  bootstrapFramework,
  createGameInstance,
  createDefaultGameDefinition,
  getRegistries,
  spawnEntity,
  serializeWorld,
  restoreWorld,
  startDialogue,
  advanceDialogue,
  queueEvent,
  drainEvents,
  triggerSystem,
  initTriggers,
} from "framework/index";
import { Health } from "framework/components/combat";
import { NetworkId } from "framework/components/network";
import { Player } from "framework/components/tags";
import { Inventory } from "framework/components/inventory";
import { Ledger } from "framework/components/ledger";
import { Dialogue } from "framework/components/dialogue";
import { Triggers } from "framework/simulation/triggers/triggers";
import { hasTrigger } from "framework/simulation/triggers/triggerRegistry";
import type { DialogueTreeJson } from "framework/config/schema/DialogueSchema";
import type { GameWorld } from "framework/world";

beforeAll(() => {
  bootstrapFramework();
});

/** 构造最小世界（默认配置；规则/物品表由用例自行注入）。 */
function createBareWorld(): GameWorld {
  return createGameInstance(createDefaultGameDefinition()).world;
}

/** 清理本文件涉及的 AoS 模块级单例（测试间 eid 复用防串扰）。 */
function clearAos(): void {
  for (let i = 0; i < Inventory.length; i++) Inventory[i] = undefined;
  for (let i = 0; i < Ledger.length; i++) Ledger[i] = undefined;
  for (let i = 0; i < Triggers.length; i++) Triggers[i] = undefined;
  for (let i = 0; i < Dialogue.length; i++) Dialogue[i] = undefined;
}

beforeEach(() => {
  clearAos();
});

/** 生成测试玩家（注册 f2-player 原型，保证存档恢复可按 kind 重建）。 */
function spawnPlayer(world: GameWorld, capacity = 8): number {
  if (!world.archetypes.has("f2-player")) {
    world.archetypes.register({
      kind: "f2-player",
      tags: ["Player"],
      components: {
        Health: { current: 100, max: 100 },
        Inventory: { capacity },
      },
    });
  }
  const eid = spawnEntity(world, world.archetypes.get("f2-player"), getRegistries().componentRegistry, {
    x: 0,
    y: 0,
  });
  Inventory[eid] = { capacity, slots: Array.from({ length: capacity }, () => null) };
  return eid;
}

/** 背包中 kind 总数。 */
function countOf(eid: number, kind: string): number {
  const inv = Inventory[eid];
  if (!inv) return 0;
  return inv.slots.reduce((sum, slot) => sum + (slot?.kind === kind ? slot.count : 0), 0);
}

const SHOP_TREE: DialogueTreeJson = {
  id: "merchant-f2",
  start: "start",
  nodes: {
    start: { text: "hi", options: [{ label: "shop", to: "shop" }] },
    shop: {
      text: "trade",
      options: [
        { label: "buy axe", effect: { type: "buy", kind: "axe", count: 1, currency: "shell" }, to: "shop" },
        { label: "sell wood x5", effect: { type: "sell", kind: "wood", count: 5, currency: "shell", price: 1 }, to: "shop" },
      ],
    },
  },
};

/** 商店世界：物品表 + 对话树 + 玩家 + 商贩（可选 Ledger 初始账本）。 */
function setupShop(
  world: GameWorld,
  ledger?: Record<string, number>,
): { player: number; npc: number } {
  world.gameDef.dialoguesByKind = new Map([[SHOP_TREE.id, SHOP_TREE]]);
  world.gameDef.itemsByKind = new Map(
    [
      { kind: "shell", maxStack: 50, value: 1 },
      { kind: "axe", maxStack: 1, value: 5 },
      { kind: "wood", maxStack: 50, value: 1 },
    ].map((item) => [item.kind, item]),
  );

  if (!world.archetypes.has("merchant-f2")) {
    world.archetypes.register({
      kind: "merchant-f2",
      tags: ["NPC"],
      components: {
        Size: { w: 16, h: 16 },
        Health: { current: 50, max: 50 },
        DialogueSource: { treeId: SHOP_TREE.id },
      },
    });
  }

  const player = spawnPlayer(world);
  const npc = spawnEntity(world, world.archetypes.get("merchant-f2"), getRegistries().componentRegistry, {
    x: 10,
    y: 0,
  });
  if (ledger) Ledger[npc] = { ...ledger };
  return { player, npc };
}

function openShop(world: GameWorld, player: number, npc: number): void {
  expect(startDialogue(world, player, npc)).toBe(true);
  expect(advanceDialogue(world, player, 0)).toBe(true); // → shop
}

describe("F-38：零消费者组件已清理", () => {
  it("AIState / Target / BlackboardRef / Duration / LastSynced 不再注册", () => {
    const registry = getRegistries().componentRegistry;
    for (const name of ["AIState", "Target", "BlackboardRef", "Duration", "LastSynced"]) {
      expect(registry.has(name)).toBe(false);
    }
    // Perception 只保留 visionRadius
    expect(registry.has("Perception")).toBe(true);
  });
});

describe("F-39：on-item-break / on-achievement 触发器求值", () => {
  it("两个事件名已注册内建求值器，实体 Triggers 配置的效果被执行", () => {
    expect(hasTrigger("on-item-break")).toBe(true);
    expect(hasTrigger("on-achievement")).toBe(true);

    const world = createBareWorld();
    const eid = spawnPlayer(world);
    Health.current[eid] = 10;
    initTriggers(world, eid, [
      { trigger: "on-item-break", effects: [{ name: "heal", params: { amount: 3 } }] },
      { trigger: "on-achievement", effects: [{ name: "add-progress", params: { key: "f2-achievement", value: 2 } }] },
    ]);

    queueEvent(world, "on-item-break", { eid, kind: "axe", slot: "weapon" });
    triggerSystem(world);
    expect(Health.current[eid]).toBe(13);
    expect(drainEvents(world)).toEqual([]);

    queueEvent(world, "on-achievement", { eid, id: "first" });
    triggerSystem(world);
    expect(world.progress["f2-achievement"]).toBe(2);
  });
});

describe("F-44：商店库存 / 资金", () => {
  it("买光库存后拒绝（玩家货币与商贩账本零副作用）", () => {
    const world = createBareWorld();
    const { player, npc } = setupShop(world, { shell: 100, axe: 2 });
    Inventory[player]!.slots[0] = { kind: "shell", count: 20 };
    openShop(world, player, npc);

    expect(advanceDialogue(world, player, 0)).toBe(true);
    expect(advanceDialogue(world, player, 0)).toBe(true);
    expect(countOf(player, "axe")).toBe(2);
    expect(countOf(player, "shell")).toBe(10);
    expect(Ledger[npc]!.axe).toBeUndefined();

    // 库存已空：拒绝且停留 shop
    expect(advanceDialogue(world, player, 0)).toBe(false);
    expect(Dialogue[player]!.nodeId).toBe("shop");
    expect(countOf(player, "axe")).toBe(2);
    expect(countOf(player, "shell")).toBe(10);
    expect(Ledger[npc]!.shell).toBe(110);
  });

  it("资金不足拒绝卖单；资金充足后卖出增加商贩库存", () => {
    const world = createBareWorld();
    const { player, npc } = setupShop(world, { shell: 4 });
    Inventory[player]!.slots[0] = { kind: "wood", count: 5 };
    openShop(world, player, npc);

    // 商贩只有 4 贝壳，卖 5 件总价 5 → 拒绝
    expect(advanceDialogue(world, player, 1)).toBe(false);
    expect(countOf(player, "wood")).toBe(5);
    expect(countOf(player, "shell")).toBe(0);
    expect(Ledger[npc]!.wood).toBeUndefined();

    // 补足资金后成交：商贩 shell 4+1 → 0，wood 0 → 5
    Ledger[npc]!.shell = 5;
    expect(advanceDialogue(world, player, 1)).toBe(true);
    expect(countOf(player, "wood")).toBe(0);
    expect(countOf(player, "shell")).toBe(5);
    expect(Ledger[npc]!.wood).toBe(5);
    expect(Ledger[npc]!.shell).toBeUndefined();
  });

  it("无 Ledger 配置 = 无限货架/钱箱（旧行为）", () => {
    const world = createBareWorld();
    const { player, npc } = setupShop(world);
    Inventory[player]!.slots[0] = { kind: "shell", count: 15 };
    openShop(world, player, npc);

    // 3 次买入（15 贝壳）全成功；无 Ledger 被创建
    for (let i = 0; i < 3; i++) expect(advanceDialogue(world, player, 0)).toBe(true);
    expect(countOf(player, "axe")).toBe(3);
    expect(countOf(player, "shell")).toBe(0);
    expect(Ledger[npc]).toBeUndefined();

    // 无限钱箱：卖 5 木头仍成功
    Inventory[player]!.slots[1] = { kind: "wood", count: 5 };
    expect(advanceDialogue(world, player, 1)).toBe(true);
    expect(countOf(player, "shell")).toBe(5);
  });

  it("库存/资金随商贩实体入档，重启后保留并继续生效", () => {
    const world = createBareWorld();
    const { player, npc } = setupShop(world, { shell: 100, axe: 2 });
    Inventory[player]!.slots[0] = { kind: "shell", count: 20 };
    const npcNetworkId = NetworkId.value[npc];
    openShop(world, player, npc);
    expect(advanceDialogue(world, player, 0)).toBe(true); // 买 1 把 → 库存 1

    const record = serializeWorld(world, "f2-shop");
    const saved = record.entities.find((entity) => entity.networkId === npcNetworkId)!;
    expect(saved.components.Ledger).toEqual({ shell: 105, axe: 1 });

    // 模拟重启：清掉模块级 AoS 单例后恢复
    clearAos();
    const world2 = createBareWorld();
    restoreWorld(world2, record);
    const restoredNpc = query(world2, [NetworkId]).find(
      (eid) => NetworkId.value[eid] === npcNetworkId,
    )!;
    expect(Ledger[restoredNpc]).toEqual({ shell: 105, axe: 1 });

    const restoredPlayer = query(world2, [Player])[0];
    world2.gameDef.dialoguesByKind = new Map([[SHOP_TREE.id, SHOP_TREE]]);
    world2.gameDef.itemsByKind = world.gameDef.itemsByKind;
    openShop(world2, restoredPlayer, restoredNpc);
    expect(advanceDialogue(world2, restoredPlayer, 0)).toBe(true); // 最后 1 把
    expect(advanceDialogue(world2, restoredPlayer, 0)).toBe(false); // 库存空
    expect(Ledger[restoredNpc]!.axe).toBeUndefined();
  });
});
