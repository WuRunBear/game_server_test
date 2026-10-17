/**
 * 玩法切片 D2：世界进度账本 + Boss 阶段行为。
 *
 * 覆盖：
 * - add-progress 效果写入 world.progress（增/缺省值/负值）；
 * - WorldRecord 进度账本往返（含旧档缺字段 → 空账本）；
 * - progressAtLeast:<key>:<n> 带参条件（满足/不满足/键缺失）；
 * - 真实 on-death 触发链：Boss 死亡 → 进度 +1 → 配方 unlock 生效；
 * - HealthBelow:<ratio> 驱动的阶段子树切换（激怒状态修饰符 + 幂等/续期）；
 * - 袭击 requireCondition 进度门控。
 */
import { describe, it, expect, beforeAll } from "vitest";
import { query } from "bitecs";

import {
  bootstrapFramework,
  createDefaultGameDefinition,
  createGameInstance,
  createGameSimulation,
  loadGameDefinition,
  serializeWorld,
  restoreWorld,
  applyEffectSpecs,
  getSpawnCondition,
  hasSpawnCondition,
  craftRecipe,
  spawnEntity,
  triggerSystem,
  Modifiers,
  computeStat,
  STAT_MOVE_SPEED,
  type SimulationPort,
} from "framework/index";
import { deathSystem } from "framework/systems/gameplay/deathSystem";
import { raidSystem } from "framework/systems/gameplay/raidSystem";
import { createBehaviourTree } from "framework/ai/btFactory";
import { stepBehaviourTree } from "framework/ai/btRunner";
import { createBlackboard } from "framework/ai/blackboard";
import { Health } from "framework/components/combat";
import { Kind, NetworkId, Player, Transform } from "components";
import { Inventory } from "framework/components/inventory";
import type { LoadedGameDefinition } from "framework/config/schema/GameDefinitionSchema";
import type { GameWorld } from "framework/world";

beforeAll(() => {
  bootstrapFramework();
});

function bareWorld(): GameWorld {
  return createGameInstance(createDefaultGameDefinition()).world;
}

/** 按 Kind（AoS）筛选实体——query 只用于遍历真实组件集合。 */
function eidsOfKind(world: GameWorld, kind: string): number[] {
  return [...query(world, [Transform])].filter((eid) => Kind[eid] === kind);
}

describe("世界进度账本", () => {
  it("add-progress 效果写入 progress（value 缺省 1、支持负值）", () => {
    const world = bareWorld();

    expect(
      applyEffectSpecs(world, 0, [], [{ name: "add-progress", params: { key: "alpha", value: 2 } }]),
    ).toBe(true);
    expect(world.progress).toEqual({ alpha: 2 });

    applyEffectSpecs(world, 0, [], [{ name: "add-progress", params: { key: "alpha" } }]);
    expect(world.progress.alpha).toBe(3);

    applyEffectSpecs(world, 0, [], [{ name: "add-progress", params: { key: "alpha", value: -1 } }]);
    expect(world.progress.alpha).toBe(2);

    // 缺 key / 零增量 = 无实际作用
    expect(applyEffectSpecs(world, 0, [], [{ name: "add-progress", params: { value: 1 } }])).toBe(false);
    expect(applyEffectSpecs(world, 0, [], [{ name: "add-progress", params: { key: "alpha", value: 0 } }])).toBe(false);
  });

  it("WorldRecord 往返保真；旧档缺 progress → 空账本", () => {
    const world = bareWorld();
    world.progress = { boss_alpha: 2, season: 7.5 };
    const record = serializeWorld(world, "progress-roundtrip");
    expect(record.progress).toEqual({ boss_alpha: 2, season: 7.5 });

    // 纯 JSON 往返（文件仓储负载前提）
    const revived = JSON.parse(JSON.stringify(record)) as typeof record;
    const world2 = bareWorld();
    restoreWorld(world2, revived);
    expect(world2.progress).toEqual({ boss_alpha: 2, season: 7.5 });

    // 旧档（无 progress 字段）：按空账本恢复
    const legacy = { ...record } as { progress?: Record<string, number> };
    delete legacy.progress;
    const world3 = bareWorld();
    restoreWorld(world3, legacy as typeof record);
    expect(world3.progress).toEqual({});
  });
});

describe("progressAtLeast 带参条件", () => {
  it("满足 / 不满足 / 键缺失（缺键按 0 计）", () => {
    expect(hasSpawnCondition("progressAtLeast:boss_alpha:1")).toBe(true);
    const gate = getSpawnCondition("progressAtLeast:boss_alpha:1");
    const world = bareWorld();

    expect(gate(world)).toBe(false); // 键缺失
    world.progress.boss_alpha = 0;
    expect(gate(world)).toBe(false); // 不满足
    world.progress.boss_alpha = 1;
    expect(gate(world)).toBe(true); // 恰好满足
    world.progress.boss_alpha = 2;
    expect(getSpawnCondition("progressAtLeast:boss_alpha:3")(world)).toBe(false);

    // 阈值可为小数
    world.progress.charge = 0.5;
    expect(getSpawnCondition("progressAtLeast:charge:0.5")(world)).toBe(true);
  });

  it("参数结构非法在取条件时抛错（配置笔误早暴露）", () => {
    expect(() => getSpawnCondition("progressAtLeast:boss_alpha")).toThrow(/requires parameter/);
    expect(() => getSpawnCondition("progressAtLeast::1")).toThrow(/requires parameter/);
  });
});

describe("Boss 阶段行为 + 真实进度链", () => {
  const suite: { def: LoadedGameDefinition; sim: SimulationPort; world: GameWorld; boss: number } =
    {} as never;

  beforeAll(async () => {
    suite.def = loadGameDefinition({ gameJsonPath: "game/game.json" });
    suite.sim = await createGameSimulation(suite.def);
    suite.world = (suite.sim as unknown as { world: GameWorld }).world;
  });

  it("Boss 原型按世界唯一 exact 规则布置在 island/rocky", () => {
    const bosses = eidsOfKind(suite.world, "boss_alpha");
    expect(bosses).toHaveLength(1);
    const eid = bosses[0]!;
    suite.boss = eid;
    expect(suite.world.maps.island).toBeDefined();
    expect(Transform.x[eid]).toBe((70 + 0.5) * 16);
    expect(Transform.y[eid]).toBe((100 + 0.5) * 16);
  });

  it("HealthBelow:<ratio> 驱动阶段子树：跌破 50% 后施加激怒修饰符（幂等/到期续期）", () => {
    const world = suite.world;

    // 第二只 Boss（不影响世界唯一布置的那只）。不给感知目标：行为树不会走到
    // Chase，阶段差异由激怒子树的 ApplyStatus 体现。
    const boss = spawnEntity(world, world.archetypes.get("boss_alpha"), world.components_registry, {
      x: 100,
      y: 100,
      mapId: "island",
    });
    const behavior = suite.def.resolvedBehaviors.find((b) => b.id === "boss-two-phase");
    expect(behavior).toBeDefined();
    const bt = createBehaviourTree(behavior!.definition as never, world.actions);
    const bb = createBlackboard(boss);

    const step = (): void => {
      stepBehaviourTree(bt, { world, self: boss, bb });
    };

    // 常规阶段：满血 → 不施加激怒修饰符
    world.time.tick = 10;
    step();
    expect(Modifiers[boss]?.moveSpeed ?? []).toHaveLength(0);

    // 跌破 50% → 下一次 step 先由 Wander 的 until 守卫中止旧分支（root 失败
    // → 自动 reset），随后重选到激怒子树并施加带来源的修饰符
    world.time.tick = 11;
    Health.current[boss] = Health.max[boss] * 0.4;
    step();
    world.time.tick = 12;
    step();
    const enraged = Modifiers[boss]?.moveSpeed ?? [];
    expect(enraged).toHaveLength(1);
    expect(enraged[0]!.source).toBe("boss_enrage");
    expect(computeStat(world, boss, STAT_MOVE_SPEED, 1)).toBeCloseTo(1.6);

    // 子树每 tick 再次执行 → 幂等，不叠加
    world.time.tick = 13;
    step();
    expect(Modifiers[boss]?.moveSpeed ?? []).toHaveLength(1);

    // 回到阈值以上：while 守卫再次切换回常规子树（阶段可逆）
    world.time.tick = 14;
    Health.current[boss] = Health.max[boss];
    step();
    step();
    expect(Modifiers[boss]?.moveSpeed ?? []).toHaveLength(1); // 已施加的修饰符保留（本配置无时限）
  });

  it("ApplyStatus 支持 durationTicks：生效期幂等，到期后可重新施加", () => {
    const world = suite.world;
    const boss = spawnEntity(world, world.archetypes.get("boss_alpha"), world.components_registry, {
      x: 120,
      y: 120,
      mapId: "island",
    });
    const factory = world.actions.get("ApplyStatus");
    const action = factory({ stat: "moveSpeed", mul: 0.5, durationTicks: 5, source: "ktest" });
    const ctx = { world, self: boss, bb: createBlackboard(boss) };

    world.time.tick = 20;
    action.call({ ctx } as never);
    action.call({ ctx } as never); // 幂等：同一来源生效期内不叠加
    expect(Modifiers[boss]?.moveSpeed ?? []).toHaveLength(1);
    expect(computeStat(world, boss, STAT_MOVE_SPEED, 1)).toBeCloseTo(1.5);

    world.time.tick = 25; // expiresTick 时刻起失效
    expect(computeStat(world, boss, STAT_MOVE_SPEED, 1)).toBe(1);
    action.call({ ctx } as never); // 到期后可续期
    expect(computeStat(world, boss, STAT_MOVE_SPEED, 1)).toBeCloseTo(1.5);
  });

  it("Boss 死亡（真实 deathSystem → on-death 触发器）→ 进度 +1 → 配方解锁", () => {
    const world = suite.world;
    const { networkId } = suite.sim.addPlayer("loot-player");
    const playerEid = [...query(world, [Player, NetworkId])].find(
      (eid) => NetworkId.value[eid] === networkId,
    )!;
    const inv = Inventory[playerEid]!;
    inv.slots[0] = { kind: "boss_core", count: 1 };
    inv.slots[1] = { kind: "stone", count: 5 };
    inv.slots[2] = { kind: "plank", count: 2 };

    // 进度为空：配方解锁门拒绝（材料不被扣）
    expect(world.progress.boss_alpha ?? 0).toBe(0);
    expect(craftRecipe(world, playerEid, "boss_cleaver")).toBe(false);
    expect(inv.slots[0]?.kind).toBe("boss_core");

    // 真实死亡链：血量归零 → deathSystem 入队 on-death 并销毁实体 →
    // triggerSystem 消费入队快照 → add-progress 写入世界账本
    const boss = suite.boss;
    Health.current[boss] = 0;
    deathSystem(world);
    expect(eidsOfKind(world, "boss_alpha")).toHaveLength(2); // 阶段/修饰符用例手工生成的另两只
    triggerSystem(world);
    expect(world.progress.boss_alpha).toBe(1);

    // 解锁生效：同一材料/同一配方现在可合成
    expect(craftRecipe(world, playerEid, "boss_cleaver")).toBe(true);
    expect(inv.slots[0]).toBeNull();
  });

  it("袭击 requireCondition 进度门控：未达成不刷波，达成后同槽刷波", () => {
    const world = suite.world;
    world.gameDef.resolvedRules["raid"] = {
      intervalTicks: 1,
      waveSize: 1,
      kinds: ["wolf"],
      radiusTiles: 3,
      requireCondition: "progressAtLeast:boss_alpha:1",
    } as never;

    const before = eidsOfKind(world, "wolf").length;
    world.progress = {};
    world.time.tick = 100;
    raidSystem(world);
    expect(eidsOfKind(world, "wolf").length - before).toBe(0);

    world.progress.boss_alpha = 1;
    world.time.tick = 101;
    raidSystem(world);
    expect(eidsOfKind(world, "wolf").length - before).toBeGreaterThan(0);
  });
});
