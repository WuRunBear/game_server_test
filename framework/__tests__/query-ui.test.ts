/**
 * CC-06 `/query/quests|achievements|skills` 测试。
 *
 * 静态定义来自 catalog（/content 同一投影），运行时进度来自玩家 AoS 组件与
 * 世界进度账本；覆盖正常/空结果/未知玩家/无副作用。
 */
import { query } from "bitecs";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  bootstrapFramework,
  createDefaultGameDefinition,
  createGameSimulation,
  loadGameDefinition,
} from "framework/index";
import {
  Achievements,
  EntityMap,
  Inventory,
  Player,
  Progression,
  Quest,
  Relation,
} from "components";
import { EntityLevel } from "framework/components/entityLevel";
import { Kind } from "framework/components/kind";
import type { GameWorld } from "world";
import type { SimulationPort } from "framework/simulation/SimulationPort";

beforeAll(() => {
  bootstrapFramework();
});

beforeEach(() => {
  for (const arr of [Inventory, Quest, Achievements, Progression, Relation, EntityMap, EntityLevel, Kind]) {
    for (let i = 0; i < arr.length; i++) (arr as unknown[])[i] = undefined;
  }
});

function simWorld(sim: SimulationPort): GameWorld {
  return (sim as unknown as { world: GameWorld }).world;
}

async function realSetup() {
  const def = loadGameDefinition({ gameJsonPath: "game/game.json" });
  const sim = await createGameSimulation(def);
  const world = simWorld(sim);
  const join = sim.addPlayer("s1");
  const playerEid = query(world, [Player])[0]!;
  return { sim, world, playerEid, playerNetworkId: join.networkId };
}

describe("queryQuests / queryAchievements / querySkills", () => {
  it("任务：catalog 全量 + 玩家 Quest 运行时 state/count/rewards", async () => {
    const { sim, playerNetworkId } = await realSetup();
    const playerEid = query(simWorld(sim), [Player])[0]!;
    Quest[playerEid] = [{ questId: "hunt_task", state: 2, count: 2 }];

    const result = sim.getQueryQuests!(playerNetworkId);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const byId = new Map(result.data.quests.map((quest) => [quest.id, quest]));
    expect(byId.get("collect_axe")).toMatchObject({
      type: "collect",
      state: 0,
      count: 0,
      accepted: false,
      goal: { count: 1, itemKind: "axe" },
      rewards: { items: [{ kind: "spear", count: 1 }], relationDelta: 10 },
    });
    expect(byId.get("hunt_task")).toMatchObject({
      type: "kill",
      state: 2,
      count: 2,
      accepted: true,
      goal: { count: 2, victimKind: "wolf" },
      rewards: { items: [{ kind: "cooked_meat", count: 1 }], relationDelta: 15 },
    });
    expect(result.data.quests.every((quest) => typeof quest.title === "string")).toBe(true);
  });

  it("成就：name/description/condition/conditionSpec/reward + 解锁事实", async () => {
    const { sim, world, playerEid, playerNetworkId } = await realSetup();
    world.progress["achievement:boss_slayer"] = 1;
    Achievements[playerEid] = { unlocked: { boss_slayer: 1 } };

    const result = sim.getQueryAchievements!(playerNetworkId);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const byId = new Map(result.data.achievements.map((achievement) => [achievement.id, achievement]));
    expect(byId.get("boss_slayer")).toMatchObject({
      name: "巨兽克星",
      description: "击败岛上的首领。",
      condition: "progressAtLeast:boss_alpha:1",
      conditionSpec: { kind: "progressAtLeast", args: ["boss_alpha", "1"] },
      reward: null,
      unlocked: true,
    });
    expect(byId.get("village_friend")).toMatchObject({
      name: "渔村的熟人",
      conditionSpec: { kind: "factionRepAtLeast", args: ["village", "10"] },
      reward: {
        items: [{ kind: "shell", count: 10 }],
        factionRep: [{ factionId: "village", delta: 5 }],
      },
      unlocked: false,
    });
  });

  it("技能：曲线/映射来自 catalog + 玩家 Progression 进度", async () => {
    const { sim, playerEid, playerNetworkId } = await realSetup();
    Progression[playerEid] = {
      totalXp: 150,
      level: 2,
      skills: {
        combat: { xp: 120, level: 2 },
        gathering: { xp: 0, level: 1 },
      },
    };

    const result = sim.getQuerySkills!(playerNetworkId);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.data).toMatchObject({
      curve: { baseXp: 100, growth: 1.5, maxLevel: 20 },
      totalXp: 150,
      level: 2,
    });
    const byId = new Map(result.data.skills.map((skill) => [skill.id, skill]));
    expect(byId.get("combat")).toMatchObject({
      stat: "attack",
      perLevel: 2,
      mode: "add",
      maxLevel: 20,
      xp: 120,
      level: 2,
      learned: true,
    });
    expect(byId.get("gathering")).toMatchObject({
      stat: "gatherMult",
      perLevel: 0.5,
      mode: "mul",
      xp: 0,
      level: 1,
      learned: true,
    });
  });

  it("空配置 → 空数组（skills 用框架缺省曲线）；未知玩家 → player_not_found", async () => {
    const sim = await createGameSimulation(createDefaultGameDefinition());
    const join = sim.addPlayer("s1");

    expect(sim.getQueryQuests!(join.networkId)).toEqual({ ok: true, data: { quests: [] } });
    expect(sim.getQueryAchievements!(join.networkId)).toEqual({
      ok: true,
      data: { achievements: [] },
    });
    expect(sim.getQuerySkills!(join.networkId)).toMatchObject({
      ok: true,
      data: { curve: { baseXp: 100, growth: 2, maxLevel: 99 }, totalXp: 0, level: 1, skills: [] },
    });

    expect(sim.getQueryQuests!(999999)).toEqual({ ok: false, error: "player_not_found" });
    expect(sim.getQueryAchievements!(999999)).toEqual({ ok: false, error: "player_not_found" });
    expect(sim.getQuerySkills!(999999)).toEqual({ ok: false, error: "player_not_found" });
  });

  it("查询前后 tick / 背包 / 任务 / 成就 / 技能不变（无副作用）", async () => {
    const { sim, world, playerEid, playerNetworkId } = await realSetup();
    Quest[playerEid] = [{ questId: "collect_axe", state: 1, count: 0 }];
    Achievements[playerEid] = { unlocked: {} };
    Progression[playerEid] = { totalXp: 10, level: 1, skills: { combat: { xp: 10, level: 1 } } };
    Relation[playerEid] = [{ npcKind: "villager", value: 3 }];
    Inventory[playerEid] = { capacity: 4, slots: [{ kind: "wood", count: 2 }, null, null, null] };

    const before = {
      tick: world.time.tick,
      inventory: JSON.stringify(Inventory[playerEid]),
      quest: JSON.stringify(Quest[playerEid]),
      achievements: JSON.stringify(Achievements[playerEid]),
      progression: JSON.stringify(Progression[playerEid]),
      relation: JSON.stringify(Relation[playerEid]),
      progress: JSON.stringify(world.progress),
      craftingJobs: JSON.stringify([...world.craftingJobs]),
    };

    expect(sim.getQueryQuests!(playerNetworkId).ok).toBe(true);
    expect(sim.getQueryAchievements!(playerNetworkId).ok).toBe(true);
    expect(sim.getQuerySkills!(playerNetworkId).ok).toBe(true);

    expect(world.time.tick).toBe(before.tick);
    expect(JSON.stringify(Inventory[playerEid])).toBe(before.inventory);
    expect(JSON.stringify(Quest[playerEid])).toBe(before.quest);
    expect(JSON.stringify(Achievements[playerEid])).toBe(before.achievements);
    expect(JSON.stringify(Progression[playerEid])).toBe(before.progression);
    expect(JSON.stringify(Relation[playerEid])).toBe(before.relation);
    expect(JSON.stringify(world.progress)).toBe(before.progress);
    expect(JSON.stringify([...world.craftingJobs])).toBe(before.craftingJobs);
  });
});
