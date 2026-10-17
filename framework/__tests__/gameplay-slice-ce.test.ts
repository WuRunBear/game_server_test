/**
 * 玩法切片 C+E 测试：配方解锁 / 制作时长与燃料 / 经济商店。
 *
 * 覆盖（验证清单）：
 * ① 解锁条件：未满足拒绝（零副作用）、满足后可制作；带参条件 inPhase 驱动的
 *    季节配方（environment 相位程序联动）；
 * ② 制作时长：材料即扣 → 进度推进 → 完成入包；满包挂起语义（不丢产出、
 *    可恢复）；取消退料（放不下拒绝取消）；即时配方回归；
 * ③ 燃料：燃烧推进、耗尽后燃料型站点失效、加燃料恢复；无 LightSource 站点
 *    不受燃料门影响；
 * ④ 买卖端到端：对话 buy/sell 效果（settle 单方条款原子交换）——默认价走
 *    item value、余额不足拒、满包整单回滚、未定价拒；GameSimulation 命令
 *    通道全链路（延时制作/refuel/craft-cancel/dialogue）；
 * ⑤ 非法解锁/时长/燃料配置构造期 fail-fast 报错（含 createGameSimulation 入口）；
 * ⑥ 真实 game 配置接线（加工链/季节配方/燃料/商店内容）+ 真实配置端到端演示。
 */
import { describe, it, expect, beforeAll } from "vitest";
import { addComponent, addEntity, query } from "bitecs";
import {
  bootstrapFramework,
  createGameInstance,
  createGameSimulation,
  createDefaultGameDefinition,
  loadGameDefinition,
  spawnEntity,
  getRegistries,
  startDialogue,
} from "framework/index";
import { Transform } from "framework/components/transform";
import { Health } from "framework/components/combat";
import { NetworkId } from "framework/components/network";
import { Player } from "framework/components/tags";
import { Dialogue } from "framework/components/dialogue";
import { Inventory, type InventoryEntry } from "framework/components/inventory";
import { CraftingStation } from "framework/components/craftingStation";
import { LightSource } from "framework/components/lightSource";
import { EntityMap } from "framework/components/entityMap";
import { EntityLevel } from "framework/components/entityLevel";
import { PHASE_DAY, PHASE_NIGHT, type GameWorld } from "framework/world";
import { setEntityKind } from "framework/systems/gameplay/aiSystem";
import {
  craftRecipe,
  stepCraftingJobs,
  cancelCrafting,
  craftingProgressOf,
  validateCraftingRules,
} from "framework/systems/gameplay/craftingSystem";
import {
  stepFuelBurn,
  refuelStation,
  validateFuelRules,
} from "framework/systems/gameplay/fuelSystem";
import { advanceDialogue } from "framework/systems/gameplay/dialogueSystem";
import type { DialogueTreeJson } from "framework/config/schema/DialogueSchema";
import type { SimulationPort } from "framework/simulation/SimulationPort";

beforeAll(() => {
  bootstrapFramework();
});

/** 构造最小世界（默认配置；规则/物品表由用例自行注入）。 */
function createBareWorld(): GameWorld {
  return createGameInstance(createDefaultGameDefinition()).world;
}

/** 清理本文件涉及的 AoS 模块级单例（仅用于无实体的 bare world 测试）。 */
function clearAos(): void {
  for (let i = 0; i < Inventory.length; i++) Inventory[i] = undefined;
  for (let i = 0; i < EntityMap.length; i++) EntityMap[i] = undefined;
  for (let i = 0; i < EntityLevel.length; i++) EntityLevel[i] = undefined;
}

/** 生成测试玩家（Transform/NetworkId/Health/Player/Inventory）。 */
function spawnPlayer(world: GameWorld, opts: { x?: number; y?: number; capacity?: number } = {}): number {
  const eid = addEntity(world);
  addComponent(world, eid, Transform);
  addComponent(world, eid, NetworkId);
  addComponent(world, eid, Player);
  addComponent(world, eid, Health);
  Health.current[eid] = 100;
  Health.max[eid] = 100;
  Transform.x[eid] = opts.x ?? 0;
  Transform.y[eid] = opts.y ?? 0;
  const capacity = opts.capacity ?? 8;
  Inventory[eid] = { capacity, slots: Array.from({ length: capacity }, () => null) };
  NetworkId.value[eid] = world.nextNetworkId++;
  setEntityKind(world, eid, "test-player");
  // legacy AoS 数组跨 world 共享 eid：显式重置，防跨用例残留串扰
  EntityMap[eid] = world.defaultMapId;
  EntityLevel[eid] = 0;
  Dialogue[eid] = undefined;
  return eid;
}

/** 生成站点实体（CraftingStation；可选 LightSource 燃料型站点）。 */
function spawnStation(
  world: GameWorld,
  opts: { x?: number; stationType?: number; fuelMs?: number; light?: boolean } = {},
): number {
  const eid = addEntity(world);
  addComponent(world, eid, Transform);
  addComponent(world, eid, NetworkId);
  addComponent(world, eid, CraftingStation);
  CraftingStation.stationType[eid] = opts.stationType ?? 1;
  Transform.x[eid] = opts.x ?? 30;
  Transform.y[eid] = 0;
  if (opts.light) {
    addComponent(world, eid, LightSource);
    LightSource.radius[eid] = 80;
    LightSource.fuelRemainingMs[eid] = opts.fuelMs ?? 1_000_000;
  }
  NetworkId.value[eid] = world.nextNetworkId++;
  EntityMap[eid] = world.defaultMapId;
  EntityLevel[eid] = 0;
  return eid;
}

/** 注入物品表（测试用 kind → maxStack/value 简表）。 */
function setItems(world: GameWorld, items: { kind: string; maxStack?: number; value?: number }[]): void {
  world.gameDef.itemsByKind = new Map(
    items.map((i) => [i.kind, { kind: i.kind, maxStack: i.maxStack ?? 1, value: i.value }]),
  );
}

/** 背包中 kind 的合计数量。 */
function countOf(inv: InventoryEntry, kind: string): number {
  return inv.slots.reduce((total, slot) => (slot && slot.kind === kind ? total + slot.count : total), 0);
}

/** 取仿真内部 world（镜像既有测试的私有访问器）。 */
function simWorld(sim: SimulationPort): GameWorld {
  return (sim as unknown as { world: GameWorld }).world;
}

/* ------------------------------------------------------------------ */
/* ① 解锁条件（科技树 / 季节配方）                                        */
/* ------------------------------------------------------------------ */

describe("切片 C：配方解锁条件", () => {
  it("解锁未满足拒绝（零副作用）；满足后可制作；inPhase 季节配方随相位开合", () => {
    const world = createBareWorld();
    world.gameDef.resolvedRules["crafting"] = {
      recipes: [
        { id: "free", inputs: [{ kind: "m", count: 1 }], outputs: [{ kind: "out", count: 1 }] },
        { id: "night_only", unlock: { condition: "isNight" }, inputs: [{ kind: "m", count: 1 }], outputs: [{ kind: "out_n", count: 1 }] },
        { id: "seasonal", unlock: { condition: "inPhase:storm" }, inputs: [{ kind: "m", count: 1 }], outputs: [{ kind: "out_s", count: 1 }] },
      ],
    };
    // 相位程序：calm 100 tick → storm 100 tick（绝对槽对齐循环）
    world.gameDef.resolvedRules["environment"] = {
      weatherSlotTicks: 10,
      phases: [
        { id: "calm", durationTicks: 100 },
        { id: "storm", durationTicks: 100 },
      ],
    };
    setItems(world, [
      { kind: "m", maxStack: 50 },
      { kind: "out", maxStack: 5 },
      { kind: "out_n", maxStack: 5 },
      { kind: "out_s", maxStack: 5 },
    ]);
    const player = spawnPlayer(world);
    const inv = Inventory[player]!;
    inv.slots[0] = { kind: "m", count: 5 };

    // 无解锁配方：直接可制（即时，回归语义）
    expect(craftRecipe(world, player, "free")).toBe(true);
    expect(countOf(inv, "out")).toBe(1);

    // 夜间配方：白天拒（零副作用——材料不变）→ 夜晚可制
    world.time.timeOfDay.phase = PHASE_DAY;
    expect(craftRecipe(world, player, "night_only")).toBe(false);
    expect(countOf(inv, "m")).toBe(4);
    expect(countOf(inv, "out_n")).toBe(0);
    world.time.timeOfDay.phase = PHASE_NIGHT;
    expect(craftRecipe(world, player, "night_only")).toBe(true);
    expect(countOf(inv, "out_n")).toBe(1);

    // 季节配方（inPhase:storm）：calm 相位拒 → storm 相位可制
    world.time.tick = 50; // calm
    expect(craftRecipe(world, player, "seasonal")).toBe(false);
    expect(countOf(inv, "m")).toBe(3); // 零副作用（free -1、night -1 后余 3）
    world.time.tick = 150; // storm（第二相位槽 100..199）
    expect(craftRecipe(world, player, "seasonal")).toBe(true);
    expect(countOf(inv, "out_s")).toBe(1);
  });
});

/* ------------------------------------------------------------------ */
/* ② 制作时长：进度 / 完成产出 / 满包挂起 / 取消退料                       */
/* ------------------------------------------------------------------ */

describe("切片 C：制作时长与挂起", () => {
  const SLOW_RULES = {
    recipes: [
      { id: "slow", durationTicks: 10, inputs: [{ kind: "m", count: 2 }], outputs: [{ kind: "out", count: 1 }] },
    ],
  };

  it("延时制作：材料即扣 → 进度推进 → 到点产出入包", () => {
    const world = createBareWorld();
    world.gameDef.resolvedRules["crafting"] = SLOW_RULES;
    setItems(world, [{ kind: "m", maxStack: 50 }, { kind: "out", maxStack: 1 }]);
    const player = spawnPlayer(world);
    const inv = Inventory[player]!;
    inv.slots[0] = { kind: "m", count: 6 };

    expect(craftRecipe(world, player, "slow")).toBe(true);
    expect(countOf(inv, "m")).toBe(4); // 材料即刻消耗
    expect(countOf(inv, "out")).toBe(0); // 产出未到点

    const progress = craftingProgressOf(world, player);
    expect(progress.length).toBe(1);
    expect(progress[0]!.recipeId).toBe("slow");
    expect(progress[0]!.remainingTicks).toBe(10);
    expect(progress[0]!.progress).toBe(0);

    // 逐 tick 推进 9 次：仍未完成
    for (let i = 0; i < 9; i++) {
      world.time.tick += 1;
      stepCraftingJobs(world);
    }
    expect(countOf(inv, "out")).toBe(0);
    expect(craftingProgressOf(world, player)[0]!.progress).toBeCloseTo(0.9);

    // 第 10 tick：产出入包，任务清空
    world.time.tick += 1;
    stepCraftingJobs(world);
    expect(countOf(inv, "out")).toBe(1);
    expect(craftingProgressOf(world, player)).toEqual([]);
  });

  it("满包挂起：完成时不吞产出（任务保留重试），腾位后下一 tick 产出", () => {
    const world = createBareWorld();
    world.gameDef.resolvedRules["crafting"] = SLOW_RULES;
    setItems(world, [
      { kind: "m", maxStack: 50 },
      { kind: "out", maxStack: 1 },
      { kind: "filler", maxStack: 50 },
    ]);
    const player = spawnPlayer(world, { capacity: 2 });
    const inv = Inventory[player]!;
    inv.slots[0] = { kind: "m", count: 5 }; // slot1 空 → 开工时 dry-run 通过

    expect(craftRecipe(world, player, "slow")).toBe(true);
    // 开工后塞满背包：out 届时无处可入
    inv.slots[1] = { kind: "filler", count: 9 };

    world.time.tick += 10;
    stepCraftingJobs(world);
    // 挂起：不产出、任务保留（材料已扣不回吐、产出不丢）
    expect(countOf(inv, "out")).toBe(0);
    expect(craftingProgressOf(world, player).length).toBe(1);

    // 腾出 slot1 → 下一 tick 完成产出
    inv.slots[1] = null;
    world.time.tick += 1;
    stepCraftingJobs(world);
    expect(countOf(inv, "out")).toBe(1);
    expect(craftingProgressOf(world, player)).toEqual([]);
  });

  it("取消：退料入包、任务移除；退料放不下拒绝取消（任务保留）；未命中拒绝", () => {
    const world = createBareWorld();
    world.gameDef.resolvedRules["crafting"] = SLOW_RULES;
    setItems(world, [
      { kind: "m", maxStack: 50 },
      { kind: "out", maxStack: 1 },
      { kind: "y", maxStack: 50 },
      { kind: "z", maxStack: 50 },
    ]);

    // 未开工取消 / 未知配方拒绝
    const player = spawnPlayer(world, { capacity: 2 });
    expect(cancelCrafting(world, player, "slow")).toBe(false);

    // 场景 A：退料放不下 → 拒绝取消、任务保留
    // （cancel 拒绝路径按快照整体替换 InventoryEntry：背包一律重读当前容器）
    const inv = () => Inventory[player]!;
    inv().slots[0] = { kind: "m", count: 4 }; // slot1 空：开工 dry-run 可过
    expect(craftRecipe(world, player, "slow")).toBe(true); // m 4 → 2
    inv().slots[0] = { kind: "z", count: 9 }; // 开工后塞满：退料 m 无处可入
    inv().slots[1] = { kind: "y", count: 3 };
    world.time.tick += 3;
    expect(cancelCrafting(world, player, "slow")).toBe(false);
    expect(craftingProgressOf(world, player).length).toBe(1); // 任务保留
    expect(countOf(inv(), "m")).toBe(0);

    // 场景 B：腾位后退料成功
    inv().slots[0] = null;
    expect(cancelCrafting(world, player, "slow")).toBe(true);
    expect(countOf(inv(), "m")).toBe(2); // 材料回退
    expect(craftingProgressOf(world, player)).toEqual([]);
  });

  it("即时配方（durationTicks 缺省/0）保持原子即时语义（回归）", () => {
    const world = createBareWorld();
    world.gameDef.resolvedRules["crafting"] = {
      recipes: [
        { id: "instant", inputs: [{ kind: "m", count: 1 }], outputs: [{ kind: "out", count: 1 }] },
        { id: "zero", durationTicks: 0, inputs: [{ kind: "m", count: 1 }], outputs: [{ kind: "out", count: 1 }] },
      ],
    };
    setItems(world, [{ kind: "m", maxStack: 50 }, { kind: "out", maxStack: 5 }]);
    const player = spawnPlayer(world);
    const inv = Inventory[player]!;
    inv.slots[0] = { kind: "m", count: 4 };

    expect(craftRecipe(world, player, "instant")).toBe(true);
    expect(countOf(inv, "out")).toBe(1);
    expect(craftRecipe(world, player, "zero")).toBe(true);
    expect(countOf(inv, "out")).toBe(2);
    expect(craftingProgressOf(world, player)).toEqual([]);
  });
});

/* ------------------------------------------------------------------ */
/* ③ 站点燃料：燃烧 / 耗尽失效 / 加燃料恢复                               */
/* ------------------------------------------------------------------ */

describe("切片 C：站点燃料", () => {
  const FUEL_RULES = {
    recipes: [{ id: "cook", stationType: 1, inputs: [{ kind: "raw", count: 1 }], outputs: [{ kind: "cooked", count: 1 }] }],
    stationRange: 64,
    fuel: { burnMsPerTick: 100, items: { wood: 30000 } },
  };

  it("燃烧推进 → 耗尽后燃料型站点失效 → 加燃料恢复可用", () => {
    const world = createBareWorld();
    world.gameDef.resolvedRules["crafting"] = FUEL_RULES;
    setItems(world, [{ kind: "raw", maxStack: 20 }, { kind: "cooked", maxStack: 20 }, { kind: "wood", maxStack: 50 }]);
    const player = spawnPlayer(world);
    const inv = Inventory[player]!;
    inv.slots[0] = { kind: "raw", count: 3 };
    inv.slots[1] = { kind: "wood", count: 2 };
    const fire = spawnStation(world, { x: 30, stationType: 1, light: true, fuelMs: 150 });

    expect(craftRecipe(world, player, "cook")).toBe(true); // 有燃料：可用

    stepFuelBurn(world); // 150 - 100 = 50
    expect(LightSource.fuelRemainingMs[fire]).toBe(50);
    stepFuelBurn(world); // 50 - 100 → 钳制 0（熄灭）
    expect(LightSource.fuelRemainingMs[fire]).toBe(0);
    stepFuelBurn(world); // 熄灭后不再变化（不为负）
    expect(LightSource.fuelRemainingMs[fire]).toBe(0);

    // 熄火：站点失效 → 合成拒绝（缺料式零副作用）
    expect(craftRecipe(world, player, "cook")).toBe(false);

    // 加燃料：消耗 1 wood → 恢复可用
    expect(refuelStation(world, player)).toBe(true);
    expect(LightSource.fuelRemainingMs[fire]).toBe(30000);
    expect(countOf(inv, "wood")).toBe(1);
    expect(craftRecipe(world, player, "cook")).toBe(true);
    expect(countOf(inv, "cooked")).toBe(2);

    // 无燃料物品：加油拒绝
    inv.slots[1] = null;
    expect(refuelStation(world, player)).toBe(false);
  });

  it("无 LightSource 的站点不受燃料门影响；加油目标可按 networkId 指定；超距拒", () => {
    const world = createBareWorld();
    world.gameDef.resolvedRules["crafting"] = FUEL_RULES;
    setItems(world, [{ kind: "raw", maxStack: 20 }, { kind: "cooked", maxStack: 20 }, { kind: "wood", maxStack: 50 }]);
    const player = spawnPlayer(world);
    const inv = Inventory[player]!;
    inv.slots[0] = { kind: "raw", count: 5 };
    inv.slots[1] = { kind: "wood", count: 5 };

    // 无光源站点：无燃料门（不熄火）
    spawnStation(world, { x: 30, stationType: 1 });
    expect(craftRecipe(world, player, "cook")).toBe(true);

    // 两座燃料型站点：指定 networkId 加油 → 命中指定目标
    const near = spawnStation(world, { x: 10, stationType: 1, light: true, fuelMs: 0 });
    const far = spawnStation(world, { x: 50, stationType: 1, light: true, fuelMs: 0 });
    expect(refuelStation(world, player, NetworkId.value[far])).toBe(true);
    expect(LightSource.fuelRemainingMs[far]).toBe(30000);
    expect(LightSource.fuelRemainingMs[near]).toBe(0);

    // 超距（stationRange 之外）：拒
    const world3 = createBareWorld();
    world3.gameDef.resolvedRules["crafting"] = FUEL_RULES;
    const p3 = spawnPlayer(world3);
    spawnStation(world3, { x: 500, stationType: 1, light: true, fuelMs: 0 });
    expect(refuelStation(world3, p3)).toBe(false);

    // 未配置 fuel 段：机制关闭（燃烧空转、加油拒绝）
    const world2 = createBareWorld();
    world2.gameDef.resolvedRules["crafting"] = { recipes: FUEL_RULES.recipes, stationRange: 64 };
    const p2 = spawnPlayer(world2);
    spawnStation(world2, { x: 10, stationType: 1, light: true, fuelMs: 100 });
    stepFuelBurn(world2);
    expect(refuelStation(world2, p2)).toBe(false);
  });
});

/* ------------------------------------------------------------------ */
/* ④ 经济商店：对话 buy/sell（settle 单方条款原子交换）                    */
/* ------------------------------------------------------------------ */

/** 商店对话树（买默认价 / 卖显式价 / 满包拒单 / 未定价拒）。 */
function shopTree(): DialogueTreeJson {
  return {
    id: "shop-tree",
    start: "start",
    nodes: {
      start: { text: "hi", options: [{ label: "shop", to: "shop" }] },
      shop: {
        text: "贝壳说话。",
        options: [
          { label: "买斧头（默认价 value=5）", effect: { type: "buy", kind: "axe", count: 1, currency: "shell" }, to: "shop" },
          { label: "卖木头×5（price=1）", effect: { type: "sell", kind: "wood", count: 5, currency: "shell", price: 1 }, to: "shop" },
          { label: "买宝石×2（maxStack=1）", effect: { type: "buy", kind: "gem", count: 2, currency: "shell", price: 1 }, to: "shop" },
          { label: "买未定价物", effect: { type: "buy", kind: "mystery", count: 1, currency: "shell" }, to: "shop" },
        ],
      },
    },
  };
}

describe("切片 E：对话买卖", () => {
  function setupShopWorld(world: GameWorld, opts: { capacity?: number } = {}): { player: number; npc: number } {
    const tree = shopTree();
    world.gameDef.resolvedDialogues = [tree];
    world.gameDef.dialoguesByKind = new Map([[tree.id, tree]]);
    setItems(world, [
      { kind: "shell", maxStack: 50, value: 1 },
      { kind: "axe", maxStack: 1, value: 5 },
      { kind: "wood", maxStack: 50 },
      { kind: "gem", maxStack: 1 },
      { kind: "mystery", maxStack: 5 },
    ]);
    if (!world.archetypes.has("npc1")) {
      world.archetypes.register({
        kind: "npc1",
        tags: ["NPC"],
        components: { Size: { w: 16, h: 16 }, Health: { current: 50, max: 50 }, DialogueSource: { treeId: "shop-tree" } },
      });
    }
    const player = spawnPlayer(world, { capacity: opts.capacity });
    const npc = spawnEntity(world, world.archetypes.get("npc1"), getRegistries().componentRegistry, { x: 10, y: 0 });
    return { player, npc };
  }

  it("买：默认价取 item.value；余额不足拒（零副作用，停留原节点）", () => {
    const world = createBareWorld();
    const { player, npc } = setupShopWorld(world);
    const inv = Inventory[player]!;
    inv.slots[0] = { kind: "shell", count: 10 };

    expect(startDialogue(world, player, npc)).toBe(true);
    expect(advanceDialogue(world, player, 0)).toBe(true); // → shop

    // 买斧头（默认价 5）：shell 10 → 5，axe +1
    expect(advanceDialogue(world, player, 0)).toBe(true);
    expect(countOf(inv, "axe")).toBe(1);
    expect(countOf(inv, "shell")).toBe(5);

    // 再买一枚（够）：shell 0
    expect(advanceDialogue(world, player, 0)).toBe(true);
    expect(countOf(inv, "shell")).toBe(0);

    // 余额不足：拒（停留 shop，零副作用）
    expect(advanceDialogue(world, player, 0)).toBe(false);
    expect(Dialogue[player]!.nodeId).toBe("shop");
    expect(countOf(inv, "axe")).toBe(2);
    expect(countOf(inv, "shell")).toBe(0);
  });

  it("卖：货物 → 货币（显式 price）；原子性：满包整单回滚；未定价拒", () => {
    const world = createBareWorld();
    const { player, npc } = setupShopWorld(world, { capacity: 2 });
    const inv = Inventory[player]!;
    inv.slots[0] = { kind: "shell", count: 2 };
    inv.slots[1] = { kind: "wood", count: 6 };

    expect(startDialogue(world, player, npc)).toBe(true);
    expect(advanceDialogue(world, player, 0)).toBe(true); // → shop

    // 卖木头×5 @1：wood 6 → 1，shell 2 → 7
    expect(advanceDialogue(world, player, 1)).toBe(true);
    expect(countOf(inv, "wood")).toBe(1);
    expect(countOf(inv, "shell")).toBe(7);

    // 未定价（mystery 无 value 且未声明 price）：拒
    expect(advanceDialogue(world, player, 3)).toBe(false);
    expect(countOf(inv, "mystery")).toBe(0);

    // 原子性：满包买 gem×2（maxStack 1 需 2 空槽，只有 0）→ 整单回滚，货币不动
    // （settle 回滚按快照整体替换 InventoryEntry：断言须重读当前容器）
    inv.slots[0] = { kind: "shell", count: 7 };
    inv.slots[1] = { kind: "wood", count: 1 }; // 背包满（capacity 2）
    expect(advanceDialogue(world, player, 2)).toBe(false);
    expect(countOf(Inventory[player]!, "gem")).toBe(0);
    expect(countOf(Inventory[player]!, "shell")).toBe(7);
  });

  it("GameSimulation 命令通道：延时制作 + craft-cancel + refuel + 对话买卖端到端", async () => {
    const def = createDefaultGameDefinition();
    def.resolvedRules["crafting"] = {
      recipes: [{ id: "slow", durationTicks: 5, inputs: [{ kind: "m", count: 1 }], outputs: [{ kind: "out", count: 1 }] }],
      stationRange: 64,
      fuel: { burnMsPerTick: 10, items: { wood: 1000 } },
    };
    def.resolvedDialogues = [shopTree()];
    const sim = await createGameSimulation(def);
    const world = simWorld(sim);
    clearAos(); // bare world（无地图实体）安全
    sim.addPlayer("s1");
    const player = query(world, [Player])[0];
    // 内建 player 原型无 Inventory：显式挂背包（真实 game 的 player 原型自带）
    Inventory[player] = { capacity: 6, slots: Array.from({ length: 6 }, () => null) };
    const inv = Inventory[player]!;
    setItems(world, [
      { kind: "m", maxStack: 50 },
      { kind: "out", maxStack: 5 },
      { kind: "wood", maxStack: 50 },
      { kind: "shell", maxStack: 50, value: 1 },
      { kind: "axe", maxStack: 1, value: 5 },
      { kind: "gem", maxStack: 1 },
      { kind: "mystery", maxStack: 5 },
    ]);
    inv.slots[0] = { kind: "m", count: 3 };
    inv.slots[1] = { kind: "wood", count: 2 };

    // 延时制作：命令即刻受理，5 tick 后产出（m 3 → 2）
    expect(sim.submitCommand("s1", { type: "craft", recipe: "slow" })).toBe(true);
    expect(countOf(inv, "out")).toBe(0);
    for (let i = 0; i < 6; i++) sim.tick(50);
    expect(countOf(inv, "out")).toBe(1);

    // craft-cancel：第二单受理后取消退料（m 2 → 1 → 退 +1 → 2）
    expect(sim.submitCommand("s1", { type: "craft", recipe: "slow" })).toBe(true);
    expect(countOf(inv, "m")).toBe(1);
    expect(sim.submitCommand("s1", { type: "craft-cancel", recipe: "slow" })).toBe(true);
    expect(countOf(inv, "m")).toBe(2);
    expect(craftingProgressOf(world, player)).toEqual([]);

    // refuel：玩家旁生成燃料型站点 → 命令加油（wood 2 → 1）
    const fireEid = spawnStation(world, { x: 10, stationType: 1, light: true, fuelMs: 0 });
    expect(sim.submitCommand("s1", { type: "refuel" })).toBe(true);
    expect(LightSource.fuelRemainingMs[fireEid]).toBe(1000);
    expect(countOf(inv, "wood")).toBe(1);

    // 对话买卖（命令通道）：默认价买斧头（shell 6 → 1）
    if (!world.archetypes.has("npc1")) {
      world.archetypes.register({
        kind: "npc1",
        tags: ["NPC"],
        components: { Size: { w: 16, h: 16 }, Health: { current: 50, max: 50 }, DialogueSource: { treeId: "shop-tree" } },
      });
    }
    const npc = spawnEntity(world, world.archetypes.get("npc1"), getRegistries().componentRegistry, { x: 5, y: 0 });
    inv.slots[3] = { kind: "shell", count: 6 };
    expect(startDialogue(world, player, npc)).toBe(true);
    expect(sim.submitCommand("s1", { type: "dialogue", option: 0 })).toBe(true); // → shop
    expect(sim.submitCommand("s1", { type: "dialogue", option: 0 })).toBe(true); // 买斧头（-5 shell）
    expect(countOf(inv, "axe")).toBe(1);
    expect(countOf(inv, "shell")).toBe(1);
  });
});

/* ------------------------------------------------------------------ */
/* ⑤ 非法配置构造期报错（fail-fast）                                     */
/* ------------------------------------------------------------------ */

describe("切片 C/E：非法配置构造期报错", () => {
  const BASE = { inputs: [{ kind: "m", count: 1 }], outputs: [{ kind: "out", count: 1 }] };
  const ENV = {
    weatherSlotTicks: 10,
    phases: [
      { id: "calm", durationTicks: 100 },
      { id: "storm", durationTicks: 100 },
    ],
  };

  function rulesWorld(crafting: unknown, environment?: unknown): GameWorld {
    const world = createBareWorld();
    world.gameDef.resolvedRules["crafting"] = crafting;
    if (environment !== undefined) world.gameDef.resolvedRules["environment"] = environment;
    return world;
  }

  it("unlock：未知条件名 / 非带参条件误用 / 空参数 / 未知相位 id / 结构非法 / 时长非法", () => {
    expect(() => validateCraftingRules(rulesWorld({ recipes: [{ id: "x", ...BASE, unlock: { condition: "ghost" } }] })))
      .toThrowError(/"ghost" is not registered/);
    // 无参条件被当带参用（isNight:foo）→ 基名非带参条件
    expect(() => validateCraftingRules(rulesWorld({ recipes: [{ id: "x", ...BASE, unlock: { condition: "isNight:foo" } }] })))
      .toThrowError(/"isNight:foo" is not registered/);
    expect(() => validateCraftingRules(rulesWorld({ recipes: [{ id: "x", ...BASE, unlock: { condition: "inPhase:" } }] })))
      .toThrowError(/empty parameter/);
    expect(() => validateCraftingRules(rulesWorld({ recipes: [{ id: "x", ...BASE, unlock: { condition: "inPhase:typhoon" } }] }, ENV)))
      .toThrowError(/phase id not in the environment rule/);
    expect(() => validateCraftingRules(rulesWorld({ recipes: [{ id: "x", ...BASE, unlock: "isNight" }] })))
      .toThrowError(/unlock must be an object/);
    expect(() => validateCraftingRules(rulesWorld({ recipes: [{ id: "x", ...BASE, unlock: { condition: "" } }] })))
      .toThrowError(/non-empty string/);
    expect(() => validateCraftingRules(rulesWorld({ recipes: [{ id: "x", ...BASE, durationTicks: -1 }] })))
      .toThrowError(/durationTicks/);
    expect(() => validateCraftingRules(rulesWorld({ recipes: [{ id: "x", ...BASE, durationTicks: 1.5 }] })))
      .toThrowError(/durationTicks/);

    // 合法配置（含 inPhase:storm + 匹配相位程序）不抛
    expect(() =>
      validateCraftingRules(rulesWorld({ recipes: [{ id: "ok", ...BASE, unlock: { condition: "inPhase:storm" }, durationTicks: 5 }] }, ENV)),
    ).not.toThrow();
  });

  it("fuel 段非法：burnMsPerTick / items 结构 / 数值", () => {
    expect(() => validateFuelRules(rulesWorld({ fuel: { burnMsPerTick: 0, items: { wood: 1 } } })))
      .toThrowError(/burnMsPerTick/);
    expect(() => validateFuelRules(rulesWorld({ fuel: { burnMsPerTick: 10 } })))
      .toThrowError(/fuel.items/);
    expect(() => validateFuelRules(rulesWorld({ fuel: { burnMsPerTick: 10, items: {} } })))
      .toThrowError(/fuel.items/);
    expect(() => validateFuelRules(rulesWorld({ fuel: { burnMsPerTick: 10, items: { wood: -5 } } })))
      .toThrowError(/fuel\.items\["wood"\]/);
  });

  it("createGameSimulation 构造期入口：非法解锁配置即抛", async () => {
    const def = createDefaultGameDefinition();
    def.resolvedRules["crafting"] = { recipes: [{ id: "x", ...BASE, unlock: { condition: "ghost" } }] };
    await expect(createGameSimulation(def)).rejects.toThrowError(/"ghost" is not registered/);
  });
});

/* ------------------------------------------------------------------ */
/* ⑥ 真实 game 配置：内容接线 + 端到端演示                                */
/* ------------------------------------------------------------------ */

describe("切片 C/E：真实 game 配置", () => {
  it("配置接线：加工链 / 季节解锁 / 燃料 / 商店内容全部通过校验", () => {
    const def = loadGameDefinition({ gameJsonPath: "game/game.json" });
    const worldShell = { gameDef: def } as unknown as GameWorld;
    expect(() => validateCraftingRules(worldShell)).not.toThrow();
    expect(() => validateFuelRules(worldShell)).not.toThrow();

    const items = new Map(def.resolvedItems.map((i) => [i.kind, i]));
    expect(items.get("plank")).toBeDefined();
    expect(items.get("shell")?.value).toBe(1);
    expect(items.get("axe")?.value).toBe(5);
    expect(items.get("berry")?.value).toBe(1);
    expect(items.get("shell_spear")?.equip?.attackBonus).toBe(18);

    const crafting = def.resolvedRules["crafting"] as {
      recipes: { id: string; unlock?: { condition: string }; durationTicks?: number; stationType?: number; inputs: { kind: string }[] }[];
      fuel: { burnMsPerTick: number; items: Record<string, number> };
    };
    const byId = new Map(crafting.recipes.map((r) => [r.id, r]));
    expect(byId.get("plank")?.inputs).toEqual([{ kind: "wood", count: 2 }]);
    expect(byId.get("door_kit")?.durationTicks).toBe(30);
    expect(byId.get("furniture_kit")?.inputs).toEqual([{ kind: "plank", count: 2 }, { kind: "stone", count: 1 }]);
    expect(byId.get("shell_spear")?.unlock?.condition).toBe("inPhase:storm");
    expect(byId.get("shell_spear")?.stationType).toBe(1);
    expect(crafting.fuel.items.wood).toBe(30000);

    // 商店效果（zod 已在 loadGameDefinition 校验；此处断言内容存在）
    const shopTreeDef = def.resolvedDialogues.find((t) => t.id === "villager-main")!;
    const shopEffects = Object.values(shopTreeDef.nodes)
      .flatMap((node) => node.options.map((option) => option.effect))
      .filter((effect) => effect && (effect.type === "buy" || effect.type === "sell"));
    expect(shopEffects.length).toBeGreaterThanOrEqual(4);

    // 燃料源与货币源（campfire 原型可能由并行 lane 调整初始燃料——只断言形态）
    const shellNode = def.resolvedEntities.find((e) => e.kind === "shell_node")!;
    expect((shellNode.components.ResourceNode as { yieldsKind: string }).yieldsKind).toBe("shell");
    const campfire = def.resolvedEntities.find((e) => e.kind === "campfire")!;
    const campfireLight = campfire.components.LightSource as { fuelRemainingMs: number };
    expect(campfireLight).toBeDefined();
    expect(campfireLight.fuelRemainingMs).toBeGreaterThan(0);
  });

  it("端到端演示：木→板加工链 + 季节解锁装备 + 燃料站点制作 + 商贩买/卖各一轮", async () => {
    const def = loadGameDefinition({ gameJsonPath: "game/game.json" });
    const sim = await createGameSimulation(def);
    const world = simWorld(sim);
    sim.addPlayer("s1");
    const player = query(world, [Player])[0];
    const inv = Inventory[player]!;
    const give = (slot: number, kind: string, count: number) => {
      inv.slots[slot] = { kind, count };
    };

    // ① 两级加工链：wood → plank（即时手搓）
    give(0, "wood", 10);
    give(1, "shell", 12);
    expect(sim.submitCommand("s1", { type: "craft", recipe: "plank" })).toBe(true);
    expect(countOf(inv, "plank")).toBe(1);
    expect(countOf(inv, "wood")).toBe(8);

    // ② 季节配方：非风暴期拒（解锁门，零副作用）
    expect(sim.submitCommand("s1", { type: "craft", recipe: "shell_spear" })).toBe(false);
    expect(countOf(inv, "shell")).toBe(12);

    // ③ 推进到 storm 相位（mild 24000 + dry 18000 + wet 18000 = 60000）+ 燃料站点
    world.time.tick = 60500;
    const { archetypeRegistry, componentRegistry } = getRegistries();
    const campfireEid = spawnEntity(world, archetypeRegistry.get("campfire"), componentRegistry, {
      x: Transform.x[player] + 10,
      y: Transform.y[player],
    });
    // 加一轮燃料（wood -1；站点燃料数值增加——燃料机制对真实配置生效）。
    // LightSource.fuelRemainingMs 为 f32：1e9 量级附近精度 ~64ms，用大于断言。
    const fuelBefore = LightSource.fuelRemainingMs[campfireEid];
    expect(sim.submitCommand("s1", { type: "refuel" })).toBe(true);
    expect(LightSource.fuelRemainingMs[campfireEid]).toBeGreaterThan(fuelBefore);
    expect(countOf(inv, "wood")).toBe(7);

    expect(sim.submitCommand("s1", { type: "craft", recipe: "shell_spear" })).toBe(true);
    expect(craftingProgressOf(world, player).some((job) => job.recipeId === "shell_spear")).toBe(true);

    // ④ 燃料驱动的站点制作：40 tick 后产出入包（燃料 120000ms ≫ 40 tick × 100ms）
    for (let i = 0; i < 41; i++) sim.tick(50);
    expect(countOf(inv, "shell_spear")).toBe(1);
    expect(countOf(inv, "shell")).toBe(9); // 12 - 3

    // ⑤ 商贩买/卖各一轮（拒绝路径 + 默认价 + 显式价）
    const villager = spawnEntity(world, archetypeRegistry.get("villager"), componentRegistry, {
      x: Transform.x[player] + 5,
      y: Transform.y[player],
    });
    expect(startDialogue(world, player, villager)).toBe(true);
    expect(sim.submitCommand("s1", { type: "dialogue", option: 1 })).toBe(true); // → shop
    // 买贝壳长矛（15 贝壳）：余额 9 < 15 → 拒（停留）
    expect(sim.submitCommand("s1", { type: "dialogue", option: 0 })).toBe(false);
    expect(countOf(inv, "shell_spear")).toBe(1);
    // 买斧头（默认价 5）：9 → 4
    expect(sim.submitCommand("s1", { type: "dialogue", option: 1 })).toBe(true);
    expect(countOf(inv, "axe")).toBe(1);
    expect(countOf(inv, "shell")).toBe(4);
    // 卖木头×5（price 1）：wood 7 → 2，shell 4 → 9
    expect(sim.submitCommand("s1", { type: "dialogue", option: 2 })).toBe(true);
    expect(countOf(inv, "wood")).toBe(2);
    expect(countOf(inv, "shell")).toBe(9);
  });
});
