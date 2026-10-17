/**
 * P2 玩法测试：价格波动 + 势力声望 + 成就。
 *
 * 覆盖：
 * ① 季节/相位因子导致同一商品价格差异（端到端买卖）；
 * ② 供需：买入若干后价格上升、卖出后下降、按 tick 衰减后回落；
 * ③ 好感折扣与势力声望折扣叠加 + maxFactor/minPrice 钳制；
 * ④ 声望来源（任务提交 relationDelta 映射势力 + 交易累计）并生效于
 *    factionRepAtLeast 条件；
 * ⑤ 成就条件满足 → 只解锁一次（幂等）+ world.progress 入档往返；
 * ⑥ 非法 schema 配置报错；
 * ⑦ 真实 game 配置接线（factions/achievements 规则 + achievement 系统注册）。
 */
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { addComponent, addEntity } from "bitecs";
import {
  bootstrapFramework,
  createDefaultGameDefinition,
  createGameInstance,
  getRegistries,
  getRuleSchema,
  ItemKindSchema,
  loadGameDefinition,
  restoreWorld,
  serializeWorld,
  type GameWorld,
} from "framework/index";
import { Transform } from "framework/components/transform";
import { Health } from "framework/components/combat";
import { NetworkId } from "framework/components/network";
import { Player } from "framework/components/tags";
import { Inventory, Kind, Quest, QUEST_READY, Relation } from "framework/components";
import { applyDialogueEffect } from "framework/systems/gameplay/dialogueSystem";
import { submitQuest } from "framework/systems/gameplay/questSystem";
import {
  addFactionRep,
  getFactionRep,
} from "framework/systems/gameplay/factions";
import { getSpawnCondition } from "framework/systems/gameplay/spawnConditions";
import {
  createAchievementSystem,
  isAchievementUnlocked,
} from "framework/systems/gameplay/achievementSystem";
import {
  decayedTradeVolume,
  recordTradeVolume,
  tradeUnitPrice,
} from "framework/systems/gameplay/pricing";
import {
  AchievementRuleSchema,
  DialogueTradeRuleSchema,
  EnvironmentRuleSchema,
  FactionRuleSchema,
  type DialogueTradeRule,
} from "framework/config/schema/RuleSchema";
import type { QuestDefinitionJson } from "framework/config/schema/QuestSchema";

beforeAll(() => {
  bootstrapFramework();
});

beforeEach(() => {
  // AoS 组件是模块级数组：清空防跨用例 eid 复用串扰
  for (let i = 0; i < Inventory.length; i++) Inventory[i] = undefined;
  for (let i = 0; i < Relation.length; i++) Relation[i] = undefined;
  for (let i = 0; i < Quest.length; i++) Quest[i] = undefined;
  for (let i = 0; i < Kind.length; i++) Kind[i] = "";
});

function item(kind: string, value: number, maxStack = 1) {
  return ItemKindSchema.parse({ kind, value, maxStack });
}

interface WorldOptions {
  rules?: Record<string, unknown>;
  items?: ReturnType<typeof item>[];
  quests?: QuestDefinitionJson[];
}

/** 最小世界：默认 gameDef + 指定规则/物品/任务（不生成地图）。 */
function createWorld(options: WorldOptions = {}): GameWorld {
  const def = createDefaultGameDefinition();
  def.resolvedRules = options.rules ?? {};
  def.resolvedItems = options.items ?? [];
  def.resolvedQuests = options.quests ?? [];
  return createGameInstance(def).world;
}

/** 生成测试玩家（Player 标签 + 背包 + 满血）。 */
function spawnPlayer(world: GameWorld, currency = 0, currencyKind = "coin"): number {
  const eid = addEntity(world);
  addComponent(world, eid, Transform);
  addComponent(world, eid, NetworkId);
  addComponent(world, eid, Player);
  addComponent(world, eid, Health);
  Health.current[eid] = 100;
  Health.max[eid] = 100;
  Inventory[eid] = { capacity: 20, slots: Array.from({ length: 20 }, () => null) };
  if (currency > 0) Inventory[eid]!.slots[0] = { kind: currencyKind, count: currency };
  Relation[eid] = undefined;
  Quest[eid] = undefined;
  return eid;
}

/** 生成测试 NPC（只需 Kind 让交易定价读到商贩 kind）。 */
function spawnMerchant(world: GameWorld, kind = "merchant"): number {
  const eid = addEntity(world);
  Kind[eid] = kind;
  return eid;
}

function countOf(world: GameWorld, eid: number, kind: string): number {
  const inv = Inventory[eid];
  if (!inv) return 0;
  return inv.slots.reduce((sum, slot) => sum + (slot?.kind === kind ? slot.count : 0), 0);
}

function trade(
  world: GameWorld,
  player: number,
  npc: number,
  type: "buy" | "sell",
  kind: string,
  count: number,
  price?: number,
): boolean {
  return applyDialogueEffect(world, player, npc, {
    type,
    kind,
    count,
    currency: "coin",
    ...(price !== undefined ? { price } : {}),
  });
}

describe("① 季节/相位价格因子", () => {
  it("同一商品在 cheap 相位 10 币、pricey 相位 20 币（2×）", () => {
    const world = createWorld({
      rules: {
        dialogue: { trade: { minPrice: 1, phaseFactors: { cheap: 1, pricey: 2 } } },
        environment: EnvironmentRuleSchema.parse({
          weatherSlotTicks: 10,
          phases: [
            { id: "cheap", durationTicks: 10 },
            { id: "pricey", durationTicks: 10 },
          ],
        }),
      },
      items: [item("coin", 1, 9999), item("gadget", 10)],
    });
    const player = spawnPlayer(world, 100);
    const npc = spawnMerchant(world);

    world.time.tick = 0; // cheap
    expect(trade(world, player, npc, "buy", "gadget", 1)).toBe(true);
    expect(countOf(world, player, "coin")).toBe(90);

    world.time.tick = 10; // pricey：10 × 2 = 20
    expect(trade(world, player, npc, "buy", "gadget", 1)).toBe(true);
    expect(countOf(world, player, "coin")).toBe(70);
    expect(countOf(world, player, "gadget")).toBe(2);
  });
});

describe("② 供需：买入抬价 / 卖出压价 / 衰减回落", () => {
  it("连续买入价格递增，卖出后下降，tick 衰减后回到基准", () => {
    const supplyDemand = { perUnit: 0.1, decayPerTick: 0.05, volumeKeyPrefix: "vol" };
    const world = createWorld({
      rules: {
        dialogue: { trade: { minPrice: 1, maxFactor: 5, supplyDemand } },
      },
      items: [item("coin", 1, 9999), item("gadget", 100)],
    });
    const player = spawnPlayer(world, 10000);
    const npc = spawnMerchant(world);
    world.time.tick = 0;

    // 买 1：100；买 2：100×1.1=110；买 3：100×1.2=120
    expect(trade(world, player, npc, "buy", "gadget", 1)).toBe(true);
    expect(trade(world, player, npc, "buy", "gadget", 1)).toBe(true);
    expect(trade(world, player, npc, "buy", "gadget", 1)).toBe(true);
    expect(countOf(world, player, "coin")).toBe(9670);
    expect(world.progress["vol:gadget"]).toBeCloseTo(3, 10);

    // 衰减读数：tick 20 → 3 - 0.05×20 = 2；tick 60 → 0
    world.time.tick = 20;
    expect(decayedTradeVolume(world, "gadget", supplyDemand)).toBeCloseTo(2, 10);
    world.time.tick = 60;
    expect(decayedTradeVolume(world, "gadget", supplyDemand)).toBeCloseTo(0, 10);

    // 卖 2 件（衰减后基准价 100）：coin +200，成交量变 -2
    expect(trade(world, player, npc, "sell", "gadget", 2)).toBe(true);
    expect(countOf(world, player, "coin")).toBe(9870);
    expect(world.progress["vol:gadget"]).toBeCloseTo(-2, 10);

    // 紧接着买 1 件：100×(1-0.2)=80（卖压仍在）
    expect(trade(world, player, npc, "buy", "gadget", 1)).toBe(true);
    expect(countOf(world, player, "coin")).toBe(9790);
    expect(world.progress["vol:gadget"]).toBeCloseTo(-1, 10);

    // 再衰减 20 tick（-1 + 0.05×20 = 0）→ 成交量归零
    world.time.tick = 80;
    expect(decayedTradeVolume(world, "gadget", supplyDemand)).toBeCloseTo(0, 10);
  });

  it("recordTradeVolume 遵守账本键与 tick 对齐（纯原子）", () => {
    const world = createWorld({
      rules: { dialogue: { trade: { supplyDemand: { perUnit: 0.1, decayPerTick: 1 } } } },
    });
    world.time.tick = 5;
    recordTradeVolume(world, "x", 4, { perUnit: 0.1, decayPerTick: 1 });
    expect(world.progress["trade:x"]).toBe(4);
    expect(world.progress["trade:x:lastTick"]).toBe(5);
    world.time.tick = 7; // 衰减 2
    expect(decayedTradeVolume(world, "x", { perUnit: 0.1, decayPerTick: 1 })).toBeCloseTo(2, 10);
  });
});

describe("③ 声望折扣与好感折扣叠加 + 钳制", () => {
  const tradeRule: DialogueTradeRule = {
    discountPerRelation: 0.02,
    factionDiscountPerRep: 0.01,
    minPrice: 1,
    minFactor: 0.3,
    maxFactor: 2,
    phaseFactors: { dry: 1.5 },
    supplyDemand: { perUnit: 0.1 },
  };

  it("四因子按固定顺序叠乘：1.5×1.5×0.8×0.9 = 1.62 → 162", () => {
    expect(
      tradeUnitPrice({
        basePrice: 100,
        relation: 10,
        factionRep: 10,
        phaseId: "dry",
        weatherId: "",
        volume: 5,
        trade: tradeRule,
      }),
    ).toBe(162);
  });

  it("高好感/高声望仍受 maxFactor 上限钳制（合成因子 2.97 → 2）", () => {
    expect(
      tradeUnitPrice({
        basePrice: 100,
        relation: 10,
        factionRep: 10,
        phaseId: "dry",
        weatherId: "",
        volume: 5,
        trade: { ...tradeRule, discountPerRelation: -0.02, factionDiscountPerRep: -0.01 },
      }),
    ).toBe(200);
  });

  it("minPrice 优先于折后价（基础 10、最低 50 → 50）；未配置因子恒原价", () => {
    expect(
      tradeUnitPrice({
        basePrice: 10,
        relation: 10,
        factionRep: 10,
        phaseId: "dry",
        weatherId: "",
        volume: 5,
        trade: { ...tradeRule, minPrice: 50 },
      }),
    ).toBe(50);
    expect(
      tradeUnitPrice({
        basePrice: 10,
        relation: 999,
        factionRep: 999,
        phaseId: "dry",
        weatherId: "",
        volume: 999,
      }),
    ).toBe(10);
  });
});

describe("④ 势力声望来源与条件", () => {
  const rules = {
    factions: {
      factions: [
        { id: "guild", name: "商会", initialRep: 0, members: ["merchant"], repPerTradeUnit: 0.5 },
      ],
    },
    dialogue: {
      trade: {
        discountPerRelation: 0.02,
        factionDiscountPerRep: 0.02,
        minPrice: 1,
      },
    },
  };
  const quest: QuestDefinitionJson = {
    id: "q1",
    type: "kill",
    goal: 1,
    victimKind: "merchant",
    submit: { rewards: [], relationDelta: 10 },
  };

  it("任务 relationDelta 映射到势力 + 交易累计；factionRepAtLeast 可读玩家声望", () => {
    const world = createWorld({ rules, items: [item("coin", 1, 9999), item("gadget", 100)], quests: [quest] });
    const player = spawnPlayer(world, 1000);
    const npc = spawnMerchant(world);
    Quest[player] = [{ questId: "q1", state: QUEST_READY, count: 1 }];

    expect(submitQuest(world, player, "q1", "merchant")).toBe(true);
    expect(getFactionRep(world, player, "guild")).toBe(10);

    // 条件：主体玩家 10 满足、11 不满足；世界级调用按任一玩家满足
    expect(getSpawnCondition("factionRepAtLeast:guild:10")(world, player)).toBe(true);
    expect(getSpawnCondition("factionRepAtLeast:guild:11")(world, player)).toBe(false);
    expect(getSpawnCondition("factionRepAtLeast:guild:10")(world)).toBe(true);

    // 交易 2 件 → 声望 +0.5×2 = +1 → 11
    expect(trade(world, player, npc, "buy", "gadget", 2)).toBe(true);
    expect(getFactionRep(world, player, "guild")).toBeCloseTo(11, 10);
    expect(getSpawnCondition("factionRepAtLeast:guild:11")(world, player)).toBe(true);

    // 定价叠加：100 × (1-0.02×10) × (1-0.02×10) = 64（成交后才把本次交易声望 +1）
    expect(countOf(world, player, "gadget")).toBe(2);
    expect(countOf(world, player, "coin")).toBe(1000 - 64 * 2);
  });

  it("addFactionRep 以 initialRep 为基准；未归属 NPC 的交易不产生势力声望", () => {
    const world = createWorld({
      rules: {
        factions: {
          factions: [{ id: "guild", initialRep: 3, members: ["merchant"], repPerTradeUnit: 1 }],
        },
      },
      items: [item("coin", 1, 9999), item("gadget", 10)],
    });
    const player = spawnPlayer(world, 100);
    const stranger = spawnMerchant(world, "stranger");

    expect(getFactionRep(world, player, "guild")).toBe(3);
    addFactionRep(world, player, "guild", 2);
    expect(getFactionRep(world, player, "guild")).toBe(5);

    expect(trade(world, player, stranger, "buy", "gadget", 1)).toBe(true);
    expect(getFactionRep(world, player, "guild")).toBe(5);
  });
});

describe("⑤ 成就检查与幂等", () => {
  it("条件满足只解锁一次；world.progress 入档往返；未满足不解锁", () => {
    const world = createWorld({
      rules: {
        achievements: {
          achievements: [
            { id: "a1", name: "第一桶金", condition: "progressAtLeast:foo:1" },
            { id: "a2", condition: "progressAtLeast:bar:1" },
          ],
        },
      },
    });
    const system = createAchievementSystem({ checkIntervalTicks: 1 });
    world.time.tick = 0;
    world.progress.foo = 1;

    system(world);
    expect(isAchievementUnlocked(world, "a1")).toBe(true);
    expect(isAchievementUnlocked(world, "a2")).toBe(false);
    expect(world.progress["achievement:a1"]).toBe(1);

    // 只发一次 on-achievement 事件
    const achievementEvents = () =>
      world.eventBus.queue.filter((evt) => evt.name === "on-achievement");
    expect(achievementEvents()).toHaveLength(1);

    // 再次检查（同 tick / 后续 tick）不重复发事件、不重复写
    system(world);
    world.time.tick = 1;
    system(world);
    expect(achievementEvents()).toHaveLength(1);
    expect(world.progress["achievement:a1"]).toBe(1);

    // 入档往返：成就标记随 world.progress 一起恢复
    const record = serializeWorld(world, "achievement-roundtrip");
    expect(record.progress?.["achievement:a1"]).toBe(1);
    const restored = createWorld();
    restoreWorld(restored, record);
    expect(isAchievementUnlocked(restored, "a1")).toBe(true);
  });

  it("factionRepAtLeast 条件 + 奖励只发给触发玩家", () => {
    const world = createWorld({
      rules: {
        factions: { factions: [{ id: "guild", members: ["merchant"], initialRep: 0 }] },
        achievements: {
          achievements: [
            {
              id: "rep10",
              condition: "factionRepAtLeast:guild:10",
              reward: {
                items: [{ kind: "coin", count: 7 }],
                factionRep: [{ factionId: "guild", delta: 2 }],
              },
            },
          ],
        },
      },
      items: [item("coin", 1, 9999)],
    });
    const player = spawnPlayer(world, 0);
    addFactionRep(world, player, "guild", 10);

    const system = createAchievementSystem({ checkIntervalTicks: 1 });
    world.time.tick = 0;
    system(world);

    expect(isAchievementUnlocked(world, "rep10")).toBe(true);
    expect(countOf(world, player, "coin")).toBe(7);
    expect(getFactionRep(world, player, "guild")).toBe(12);
  });
});

describe("⑥ schema 校验", () => {
  it("dialogue trade：因子/最低价/相位乘子非法配置报错", () => {
    expect(() =>
      DialogueTradeRuleSchema.parse({
        minPrice: 1,
        phaseFactors: { dry: 1.2 },
        supplyDemand: { perUnit: 0.01, decayPerTick: 0.001 },
      }),
    ).not.toThrow();

    expect(() => DialogueTradeRuleSchema.parse({ minPrice: 0 })).toThrow();
    expect(() => DialogueTradeRuleSchema.parse({ discountPerRelation: 1.5 })).toThrow();
    expect(() => DialogueTradeRuleSchema.parse({ factionDiscountPerRep: -0.1 })).toThrow();
    expect(() => DialogueTradeRuleSchema.parse({ maxFactor: 0 })).toThrow();
    expect(() => DialogueTradeRuleSchema.parse({ minFactor: 3, maxFactor: 2 })).toThrow();
    expect(() => DialogueTradeRuleSchema.parse({ phaseFactors: { dry: "hot" } })).toThrow();
    expect(() =>
      DialogueTradeRuleSchema.parse({ supplyDemand: { perUnit: 0.1, decayPerTick: -1 } }),
    ).toThrow();
  });

  it("factions：重复 id / 空 id / members 非字符串报错", () => {
    expect(() => FactionRuleSchema.parse({ factions: [{ id: "f" }] })).not.toThrow();
    expect(() =>
      FactionRuleSchema.parse({ factions: [{ id: "f" }, { id: "f" }] }),
    ).toThrow(/duplicate faction id/);
    expect(() => FactionRuleSchema.parse({ factions: [{ id: "" }] })).toThrow();
    expect(() => FactionRuleSchema.parse({ factions: [{ id: "f", members: [1] }] })).toThrow();
  });

  it("achievements：重复 id / 缺条件 / 奖励数量非法报错", () => {
    expect(() =>
      AchievementRuleSchema.parse({ achievements: [{ id: "a", condition: "isDay" }] }),
    ).not.toThrow();
    expect(() =>
      AchievementRuleSchema.parse({
        achievements: [{ id: "a", condition: "isDay" }, { id: "a", condition: "isNight" }],
      }),
    ).toThrow(/duplicate achievement id/);
    expect(() => AchievementRuleSchema.parse({ achievements: [{ id: "a" }] })).toThrow();
    expect(() =>
      AchievementRuleSchema.parse({
        achievements: [
          { id: "a", condition: "isDay", reward: { items: [{ kind: "coin", count: 0 }] } },
        ],
      }),
    ).toThrow();
  });
});

describe("⑦ 真实配置接线", () => {
  it("game/rules/factions.json 与 achievements.json 被加载校验；achievement 系统已注册", () => {
    const real = loadGameDefinition({ gameJsonPath: "game/game.json" });
    expect(real.resolvedRules["factions"]).toMatchObject({
      factions: [{ id: "village", members: ["villager"], repPerTradeUnit: 0.1 }],
    });
    const achievements = (real.resolvedRules["achievements"] as {
      achievements: unknown[];
    }).achievements;
    expect(achievements[0]).toMatchObject({
      id: "village_friend",
      condition: "factionRepAtLeast:village:10",
    });
    expect(achievements).toHaveLength(2);
    expect(real.resolvedRules["dialogue"]).toMatchObject({
      trade: {
        phaseFactors: { mild: 1, dry: 1.2, storm: 1 },
        supplyDemand: { perUnit: 0.01, decayPerTick: 0.001 },
      },
    });
    expect(getRegistries().systemRegistry.has("achievement")).toBe(true);
    expect(getRuleSchema("factions")).toBeDefined();
    expect(getRuleSchema("achievements")).toBeDefined();
  });
});
