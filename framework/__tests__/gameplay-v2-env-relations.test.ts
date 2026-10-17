/**
 * 玩法补齐测试：环境调制需求 + 好感交易折扣。
 *
 * 覆盖：
 * ① 环境修饰值变化 → 对应 Need 衰减速率按系数变化（同实体两个 Need 对比相位）；
 * ② 系数缺省 / 非法极值钳制（无配置恒 1、缺键恒 1、乘子钳到 [0.1, 10]）；
 * ③ 好感折扣纯函数：relation 0 原价、正好感打折、负好感涨价、最低价 1；
 * ④ 买卖端到端（真实 game 配置：rules/dialogue.json + items value + villager 对话树）；
 * ⑤ schema 校验（非法 needs/dialogue 规则配置报错）；
 * ⑥ 真实配置接线（loadGameDefinition 读取 environmentFactors / trade 段）。
 */
import { beforeAll, describe, expect, it } from "vitest";
import { addComponent, addEntity } from "bitecs";
import {
  bootstrapFramework,
  createDefaultGameDefinition,
  createGameInstance,
  EnvironmentRuleSchema,
  getRegistries,
  getRuleSchema,
  loadGameDefinition,
  spawnEntity,
  type GameWorld,
} from "framework/index";
import { Transform } from "framework/components/transform";
import { Health } from "framework/components/combat";
import { NetworkId } from "framework/components/network";
import { Player } from "framework/components/tags";
import { Inventory } from "framework/components/inventory";
import { Needs, type Need } from "framework/components/needs";
import { Dialogue } from "framework/components/dialogue";
import { EntityMap } from "framework/components/entityMap";
import { EntityLevel } from "framework/components/entityLevel";
import {
  NEED_ENVIRONMENT_SCALE_MAX,
  NEED_ENVIRONMENT_SCALE_MIN,
  environmentDecayMultiplier,
  needDecaySystem,
} from "framework/systems/gameplay/needDecaySystem";
import {
  advanceDialogue,
  discountedUnitPrice,
  startDialogue,
} from "framework/systems/gameplay/dialogueSystem";
import { addRelation } from "framework/systems/gameplay/relation";
import {
  DialogueRuleSchema,
  NeedsRuleSchema,
  type EnvironmentRule,
} from "framework/config/schema/RuleSchema";

beforeAll(() => {
  bootstrapFramework();
});

function createBareWorld(): GameWorld {
  return createGameInstance(createDefaultGameDefinition()).world;
}

/** 生成只带 Health + Needs 的最小活物（needDecaySystem 的 query 目标）。 */
function spawnNeedsEntity(world: GameWorld, needs: Need[]): number {
  const eid = addEntity(world);
  addComponent(world, eid, Health);
  Health.current[eid] = 100;
  Health.max[eid] = 100;
  Needs[eid] = needs;
  return eid;
}

/** 测试相位程序：cold[0,10) 温度 0；hot[10,20) 温度 10（一周期 20 tick）。 */
const PHASE_RULE: EnvironmentRule = EnvironmentRuleSchema.parse({
  seed: 7,
  weatherSlotTicks: 10,
  phases: [
    { id: "cold", durationTicks: 10, modifiers: { temperatureOffset: 0 } },
    { id: "hot", durationTicks: 10, modifiers: { temperatureOffset: 10 } },
  ],
});

describe("① 环境调制需求", () => {
  it("温度升高时只加速配置了系数的 Need（hunger 1.5× / thirst 1×）", () => {
    const world = createBareWorld();
    world.gameDef.resolvedRules["environment"] = PHASE_RULE;
    world.gameDef.resolvedRules["needs"] = {
      decayScale: 1,
      environmentFactors: { hunger: { temperatureOffset: 0.05 } },
    };
    const eid = spawnNeedsEntity(world, [
      { name: "hunger", current: 100, max: 100, decayPerSec: 1, depletionDmg: 0 },
      { name: "thirst", current: 100, max: 100, decayPerSec: 1, depletionDmg: 0 },
    ]);
    world.time.dtMs = 1000;

    // cold：temperatureOffset = 0 → 两者均 1×
    world.time.tick = 0;
    needDecaySystem(world);
    expect(Needs[eid]![0].current).toBeCloseTo(99, 6);
    expect(Needs[eid]![1].current).toBeCloseTo(99, 6);

    // hot：temperatureOffset = 10 → hunger 1 + 0.05×10 = 1.5×，thirst 无配置恒 1×
    world.time.tick = 10;
    needDecaySystem(world);
    expect(Needs[eid]![0].current).toBeCloseTo(97.5, 6);
    expect(Needs[eid]![1].current).toBeCloseTo(98, 6);
  });

  it("相位内线性修饰值同样生效（进度中点温度 5 → 1.25×）", () => {
    const world = createBareWorld();
    world.gameDef.resolvedRules["environment"] = EnvironmentRuleSchema.parse({
      weatherSlotTicks: 10,
      phases: [
        { id: "heatwave", durationTicks: 20, modifiers: { temperatureOffset: { from: 0, to: 10 } } },
      ],
    });
    world.gameDef.resolvedRules["needs"] = {
      environmentFactors: { hunger: { temperatureOffset: 0.05 } },
    };
    const eid = spawnNeedsEntity(world, [
      { name: "hunger", current: 100, max: 100, decayPerSec: 1, depletionDmg: 0 },
    ]);
    world.time.dtMs = 1000;
    world.time.tick = 10; // progress = 0.5 → offset = 5
    needDecaySystem(world);
    expect(Needs[eid]![0].current).toBeCloseTo(98.75, 6);
  });
});

describe("② 系数缺省 / 极值钳制", () => {
  it("未配置 environmentFactors / 未配置该 Need / 环境缺键 → 乘子恒 1", () => {
    expect(environmentDecayMultiplier("hunger", { temperatureOffset: 10 }, undefined)).toBe(1);
    expect(environmentDecayMultiplier("thirst", { temperatureOffset: 10 }, { hunger: { temperatureOffset: 0.05 } })).toBe(1);
    expect(environmentDecayMultiplier("hunger", { otherKey: 10 }, { hunger: { temperatureOffset: 0.05 } })).toBe(1);
    expect(environmentDecayMultiplier("hunger", {}, { hunger: { temperatureOffset: 0.05 } })).toBe(1);
  });

  it("极端系数钳到 [0.1, 10]", () => {
    expect(
      environmentDecayMultiplier("hunger", { temperatureOffset: 100 }, { hunger: { temperatureOffset: 100 } }),
    ).toBe(NEED_ENVIRONMENT_SCALE_MAX);
    expect(
      environmentDecayMultiplier("hunger", { temperatureOffset: 100 }, { hunger: { temperatureOffset: -100 } }),
    ).toBe(NEED_ENVIRONMENT_SCALE_MIN);
    expect(NEED_ENVIRONMENT_SCALE_MIN).toBe(0.1);
    expect(NEED_ENVIRONMENT_SCALE_MAX).toBe(10);
  });
});

describe("③ 好感折扣定价", () => {
  it("relation 0 原价；正好感打折；负好感对称涨价", () => {
    expect(discountedUnitPrice(15, 0, 0.02, 1)).toBe(15);
    expect(discountedUnitPrice(15, 10, 0.02, 1)).toBe(12); // 15 × 0.8
    expect(discountedUnitPrice(15, -10, 0.02, 1)).toBe(18); // 15 × 1.2
  });

  it("最低价恒 ≥1（含 minPrice 配置与折扣压到 0 的情况）", () => {
    expect(discountedUnitPrice(1, 100, 0.02, 1)).toBe(1);
    expect(discountedUnitPrice(5, 50, 0.02, 3)).toBe(3); // 折后 0 → 配置下限 3
    expect(discountedUnitPrice(5, 10, 0.02, 1)).toBe(4);
    // 未配置折扣率 → 原价（无 Relation 行为不变）
    expect(discountedUnitPrice(5, 10, 0)).toBe(5);
  });
});

/** 用真实 game 配置（规则/对话/原型/物品）搭 bare world；跳过地图生成。 */
function createRealConfigWorld(): { world: GameWorld; player: number; npc: number } {
  const real = loadGameDefinition({ gameJsonPath: "game/game.json" });
  const def = createDefaultGameDefinition();
  def.resolvedRules = real.resolvedRules;
  def.resolvedEntities = real.resolvedEntities;
  def.resolvedItems = real.resolvedItems;
  def.resolvedDialogues = real.resolvedDialogues;
  def.resolvedQuests = real.resolvedQuests;
  const world = createGameInstance(def).world;

  const player = addEntity(world);
  addComponent(world, player, Transform);
  addComponent(world, player, NetworkId);
  addComponent(world, player, Player);
  addComponent(world, player, Health);
  Health.current[player] = 100;
  Health.max[player] = 100;
  Inventory[player] = { capacity: 12, slots: Array.from({ length: 12 }, () => null) };
  Inventory[player]!.slots[0] = { kind: "shell", count: 40 };
  NetworkId.value[player] = world.nextNetworkId++;
  EntityMap[player] = world.defaultMapId;
  EntityLevel[player] = 0;
  Dialogue[player] = undefined;

  const villager = world.archetypes.get("villager");
  if (!villager) throw new Error("real config missing villager archetype");
  const npc = spawnEntity(world, villager, getRegistries().componentRegistry, { x: 10, y: 0 });
  return { world, player, npc };
}

function countOf(inv: NonNullable<(typeof Inventory)[number]>, kind: string): number {
  return inv.slots.reduce((sum, slot) => sum + (slot?.kind === kind ? slot.count : 0), 0);
}

describe("④ 买卖端到端（真实配置）", () => {
  it("任务好感 +10 后贝壳长矛 15 → 12；负好感 -10 → 18；最低价不为负", () => {
    const { world, player, npc } = createRealConfigWorld();
    const inv = Inventory[player]!;

    // 好感 0：默认价（显式 price 15）——shell 40 → 25
    expect(startDialogue(world, player, npc)).toBe(true);
    expect(advanceDialogue(world, player, 1)).toBe(true); // → shop
    expect(advanceDialogue(world, player, 0)).toBe(true);
    expect(countOf(inv, "shell_spear")).toBe(1);
    expect(countOf(inv, "shell")).toBe(25);

    // 好感 +10（规则 discountPerRelation=0.02）→ 15 × 0.8 = 12；shell 25 → 13
    addRelation(world, player, "villager", 10);
    expect(advanceDialogue(world, player, 0)).toBe(true);
    expect(countOf(inv, "shell_spear")).toBe(2);
    expect(countOf(inv, "shell")).toBe(13);

    // 好感降到 -10 → 15 × 1.2 = 18；补足 shell 后再买一枚，shell 33 → 15
    addRelation(world, player, "villager", -20);
    inv.slots[0] = { kind: "shell", count: 33 };
    expect(advanceDialogue(world, player, 0)).toBe(true);
    expect(countOf(inv, "shell_spear")).toBe(3);
    expect(countOf(inv, "shell")).toBe(15);
  });

  it("卖方向同样按好感调制（木头 1 贝壳/个，+10 好感仍为 1，-10 好感 → 1）", () => {
    const { world, player, npc } = createRealConfigWorld();
    const inv = Inventory[player]!;
    inv.slots[1] = { kind: "wood", count: 10 };

    expect(startDialogue(world, player, npc)).toBe(true);
    expect(advanceDialogue(world, player, 1)).toBe(true); // → shop
    addRelation(world, player, "villager", -10); // 负好感：基础价 1 × 1.2 → round = 1（最低价兜底）
    expect(advanceDialogue(world, player, 2)).toBe(true); // 卖木头 ×5 @1
    expect(countOf(inv, "wood")).toBe(5);
    expect(countOf(inv, "shell")).toBe(45);
  });
});

describe("⑤ schema 校验", () => {
  it("needs：合法 environmentFactors 通过；非数值系数拒绝", () => {
    expect(() =>
      NeedsRuleSchema.parse({ environmentFactors: { hunger: { temperatureOffset: 0.05 } } }),
    ).not.toThrow();
    expect(() =>
      NeedsRuleSchema.parse({ environmentFactors: { hunger: { temperatureOffset: "hot" } } }),
    ).toThrow();
    expect(() =>
      NeedsRuleSchema.parse({ environmentFactors: { hunger: { temperatureOffset: true } } }),
    ).toThrow();
  });

  it("dialogue：discountPerRelation 限定 [0,1]，minPrice ≥1", () => {
    expect(() =>
      DialogueRuleSchema.parse({ trade: { discountPerRelation: 0.02, minPrice: 1 } }),
    ).not.toThrow();
    expect(() => DialogueRuleSchema.parse({ trade: { discountPerRelation: 1.5 } })).toThrow();
    expect(() => DialogueRuleSchema.parse({ trade: { discountPerRelation: -0.1 } })).toThrow();
    expect(() => DialogueRuleSchema.parse({ trade: { minPrice: 0 } })).toThrow();
  });

  it("内建注册表已注册 dialogue 规则 schema", () => {
    expect(getRuleSchema("needs")).toBeDefined();
    expect(getRuleSchema("dialogue")).toBeDefined();
  });
});

describe("⑥ 真实配置接线", () => {
  it("game/rules/needs.json 与 game/rules/dialogue.json 被加载校验", () => {
    const real = loadGameDefinition({ gameJsonPath: "game/game.json" });
    expect(real.resolvedRules["needs"]).toMatchObject({
      decayScale: 1,
      environmentFactors: {
        hunger: { temperatureOffset: 0.05 },
        thirst: { temperatureOffset: 0.08 },
      },
    });
    expect(real.resolvedRules["dialogue"]).toMatchObject({
      trade: { discountPerRelation: 0.02, minPrice: 1 },
    });
  });
});
