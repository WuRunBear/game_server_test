/**
 * CC-09 UI Data Projection：`/content` 只读数据投影测试。
 *
 * 目标：客户端 UI 需要的机制字段（物品效果/暴击/伤害类型/抗性/腐烂去向、
 * 配方时长/解锁、任务全定义/奖励、成就结构化条件、技能曲线、势力、站点、
 * 伤害类型）都能从 `/content` 的构建函数直接拿到，且不破坏旧字段。
 *
 * 测试直接调用 `buildContentCatalog(loadGameDefinition("game/game.json"))`：
 * 不启动 HTTP/房间，保持快速；HTTP 形状由 http-content-maps.test.ts 覆盖。
 * 展示名注册表在用例间清空，验证「未注册 → 回退 id 原文」。
 */
import { beforeAll, beforeEach, describe, expect, it } from "vitest";

import { bootstrapFramework, loadGameDefinition } from "framework";
import { buildContentCatalog, type ContentCatalog } from "framework/content/catalog";
import { registerContentLabel, resetContentLabels } from "framework/content/labels";
import type { LoadedGameDefinition } from "framework/config/schema/GameDefinitionSchema";

let gameDef: LoadedGameDefinition;
let catalog: ContentCatalog;

beforeAll(() => {
  bootstrapFramework();
  gameDef = loadGameDefinition({ gameJsonPath: "game/game.json" });
});

beforeEach(() => {
  resetContentLabels();
  catalog = buildContentCatalog(gameDef);
});

/** 按 kind/id 取条目（缺失即失败，避免非空断言散落）。 */
function itemOf(kind: string) {
  const item = catalog.items.find((entry) => entry.kind === kind);
  if (!item) throw new Error(`missing content item: ${kind}`);
  return item;
}

function recipeOf(id: string) {
  const recipe = catalog.recipes.find((entry) => entry.id === id);
  if (!recipe) throw new Error(`missing content recipe: ${id}`);
  return recipe;
}

function questOf(id: string) {
  const quest = catalog.quests.find((entry) => entry.id === id);
  if (!quest) throw new Error(`missing content quest: ${id}`);
  return quest;
}

function achievementOf(id: string) {
  const achievement = catalog.achievements.find((entry) => entry.id === id);
  if (!achievement) throw new Error(`missing content achievement: ${id}`);
  return achievement;
}

describe("CC-09 items：机制字段投影（只输出配置存在的字段）", () => {
  it("旧字段保持：kind/label/maxStack/maxDurability/toolType/equip/value", () => {
    expect(catalog.items.map((item) => item.kind)).toEqual(
      gameDef.resolvedItems.map((item) => item.kind),
    );
    const axe = itemOf("axe");
    expect(axe).toMatchObject({
      kind: "axe",
      label: "axe",
      maxStack: 1,
      maxDurability: 60,
      wearPerUse: 1,
      toolType: "axe",
      value: 5,
      equip: { slot: "tool" },
    });
    // 未配置的字段不出现（不输出 undefined 键，也不编造缺省值）。
    for (const key of ["consume", "effects", "place", "throw", "critChance", "resist", "keepOnDeath"]) {
      expect(key in axe, `axe should omit ${key}`).toBe(false);
    }
  });

  it("补齐效果/腐烂/投掷/暴击/伤害类型/抗性", () => {
    const berry = itemOf("berry");
    expect(berry.spoilTicks).toBe(3600);
    expect(berry.spoilInto).toBe("rotten");
    expect(berry.consume).toEqual([{ need: "hunger", amount: 20 }]);

    const cookedMeat = itemOf("cooked_meat");
    expect(cookedMeat.effects).toEqual([{ name: "heal", params: { amount: 5 } }]);

    const throwingSpear = itemOf("throwing_spear");
    expect(throwingSpear.throw).toEqual({
      speed: 320,
      lifeMs: 1000,
      radius: 5,
      cooldownMs: 900,
      damage: 16,
    });
    expect(throwingSpear.critChance).toBe(0.1);
    expect(throwingSpear.critMultiplier).toBe(2);
    expect(throwingSpear.damageType).toBe("pierce");
    expect(throwingSpear.maxDurability).toBe(30);
    expect(throwingSpear.wearPerUse).toBe(1);

    const shellArmor = itemOf("shell_armor");
    expect(shellArmor.resist).toEqual({ pierce: 0.3, slash: 0.1 });
    expect(shellArmor.equip).toEqual({ slot: "armor", defenseBonus: 4 });
  });

  it("keepOnDeath 等可选机制字段按配置原样投影（当前真实配置未使用该字段）", () => {
    const synthetic = {
      ...gameDef,
      resolvedItems: [
        ...gameDef.resolvedItems,
        { kind: "test_relic", maxStack: 1, keepOnDeath: true, value: 3 },
      ],
    } as unknown as LoadedGameDefinition;
    const projected = buildContentCatalog(synthetic);
    expect(projected.items.find((item) => item.kind === "test_relic")).toMatchObject({
      kind: "test_relic",
      label: "test_relic",
      maxStack: 1,
      keepOnDeath: true,
      value: 3,
    });
  });
});

describe("CC-09 recipes：时长/站点/解锁按 craftingSystem 实际语义投影", () => {
  it("未声明 durationTicks → 0；声明时原样输出", () => {
    expect(recipeOf("wood_axe").durationTicks).toBe(0);
    expect(recipeOf("throwing_spear").durationTicks).toBe(30);
    expect(recipeOf("shell_spear").durationTicks).toBe(40);
    for (const recipe of catalog.recipes) {
      expect(typeof recipe.durationTicks).toBe("number");
    }
  });

  it("stationType 只在声明时输出；unlock 原样保留；inputs/outputs 保持旧形状", () => {
    const woodAxe = recipeOf("wood_axe");
    expect("stationType" in woodAxe).toBe(false);
    expect("unlock" in woodAxe).toBe(false);
    expect(woodAxe.inputs).toEqual([["wood", 2]]);
    expect(woodAxe.outputs).toEqual([["axe", 1]]);

    const shellSpear = recipeOf("shell_spear");
    expect(shellSpear.stationType).toBe(1);
    expect(shellSpear.unlock).toEqual({ condition: "inPhase:storm" });

    const bossCleaver = recipeOf("boss_cleaver");
    expect(bossCleaver.unlock).toEqual({ condition: "progressAtLeast:boss_alpha:1" });
    expect(typeof bossCleaver.desc).toBe("string");
  });
});

describe("CC-09 quests：静态定义 + 模板 state/count", () => {
  it("collect 任务：type/goal/rewards；state/count 保持模板 0", () => {
    const quest = questOf("collect_axe");
    expect(quest.state).toBe(0);
    expect(quest.count).toBe(0);
    expect(quest.title).toBe("collect_axe"); // 未注册展示名 → id 原文
    expect(quest.type).toBe("collect");
    expect(quest.goal).toEqual({ itemKind: "axe", count: 1 });
    expect(quest.rewards).toEqual({ items: [{ kind: "spear", count: 1 }], relationDelta: 10 });
    expect(quest.desc.length).toBeGreaterThan(0);
  });

  it("kill 任务：victimKind 与 relationDelta", () => {
    const quest = questOf("hunt_task");
    expect(quest.type).toBe("kill");
    expect(quest.goal).toEqual({ victimKind: "wolf", count: 2 });
    expect(quest.rewards).toEqual({
      items: [{ kind: "cooked_meat", count: 1 }],
      relationDelta: 15,
    });
    // 当前 QuestSchema 没有 prerequisites 字段 → 不输出、不编造。
    expect("prerequisites" in quest).toBe(false);
  });
});

describe("CC-09 achievements：结构化条件 + 奖励 + 模板解锁状态", () => {
  it("带参条件按冒号切分为 { kind, args }，原文保留", () => {
    const achievement = achievementOf("village_friend");
    expect(achievement.condition).toBe("factionRepAtLeast:village:10");
    expect(achievement.conditionSpec).toEqual({
      kind: "factionRepAtLeast",
      args: ["village", "10"],
    });
    expect(achievement.unlocked).toBe(false);
    expect(achievement.title).toBe("渔村的熟人");
    expect(achievement.desc).toBe("与渔村势力声望达到 10。");
    expect(achievement.reward).toEqual({
      items: [{ kind: "shell", count: 10 }],
      factionRep: [{ factionId: "village", delta: 5 }],
    });
  });

  it("无奖励成就省略 reward；条件结构仍可读", () => {
    const achievement = achievementOf("boss_slayer");
    expect(achievement.conditionSpec).toEqual({
      kind: "progressAtLeast",
      args: ["boss_alpha", "1"],
    });
    expect("reward" in achievement).toBe(false);
    expect(achievement.unlocked).toBe(false);
  });
});

describe("CC-09 skills：曲线与每技能加成", () => {
  it("curve/maxLevel 取 progression 规则（缺省补运行时缺省值）", () => {
    const combat = catalog.skills.find((skill) => skill.id === "combat")!;
    expect(combat).toMatchObject({
      id: "combat",
      label: "combat",
      stat: "attack",
      perLevel: 2,
      mode: "add",
      maxLevel: 20,
      curve: { baseXp: 100, growth: 1.5, maxLevel: 20 },
    });

    const gathering = catalog.skills.find((skill) => skill.id === "gathering")!;
    expect(gathering).toMatchObject({
      stat: "gatherMult",
      perLevel: 0.5,
      mode: "mul",
      maxLevel: 20,
    });
    expect(gathering.curve).toEqual(combat.curve);
  });
});

describe("CC-09 新段：factions / stationTypes / damageTypes", () => {
  it("factions 来自 factions 规则，名称配置优先", () => {
    expect(catalog.factions).toEqual([
      {
        id: "village",
        name: "渔村",
        initialRep: 0,
        members: ["villager"],
        repPerTradeUnit: 0.1,
      },
    ]);
  });

  it("stationTypes 只包含实际出现的类型（配方 + 实体 CraftingStation）", () => {
    expect(catalog.stationTypes.map((station) => station.id)).toEqual([1]);
    // 未注册展示名 → 回退编号原文，不编造中文名。
    expect(catalog.stationTypes[0]!.label).toBe("1");

    // 注册后即时生效（不破坏旧签名；新增 scope 仅扩展联合类型）。
    registerContentLabel("stationType", "1", "篝火");
    const labeled = buildContentCatalog(gameDef);
    expect(labeled.stationTypes[0]!.label).toBe("篝火");
  });

  it("damageTypes 从物品 damageType 与 resist 键收集去重，不编造中文名", () => {
    expect(catalog.damageTypes.map((damageType) => damageType.id)).toEqual(["pierce", "slash"]);
    for (const damageType of catalog.damageTypes) {
      expect(damageType.label).toBe(damageType.id);
    }
  });

  it("damageTypes 也收集实体配置里声明的 damageType/resist 键", () => {
    const synthetic = {
      ...gameDef,
      resolvedEntities: [
        ...gameDef.resolvedEntities,
        {
          kind: "test_enemy",
          components: {
            Attack: { value: 1, damageType: "blunt" },
            Resist: { fire: 0.5 },
          },
        },
      ],
    } as unknown as LoadedGameDefinition;
    const projected = buildContentCatalog(synthetic);
    expect(projected.damageTypes.map((damageType) => damageType.id)).toEqual([
      "blunt",
      "fire",
      "pierce",
      "slash",
    ]);
  });

  it("新增段缺展示名时回退 id/kind，并使用中性缺省", () => {
    const minimal = {
      ...gameDef,
      resolvedRules: {
        ...gameDef.resolvedRules,
        factions: { factions: [{ id: "unknown_faction" }] },
      },
    } as unknown as LoadedGameDefinition;
    const projected = buildContentCatalog(minimal);
    expect(projected.factions).toEqual([
      { id: "unknown_faction", name: "unknown_faction", initialRep: 0, members: [] },
    ]);
  });
});
