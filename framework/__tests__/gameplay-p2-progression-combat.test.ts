/**
 * 玩法 P2 测试：经验/技能成长 + 暴击/克制（真实 game 配置）。
 *
 * 覆盖：
 * ① XP 获取（击杀 / 采集）累加、角色与技能等级阈值；
 * ② 技能加成影响真实数值（战斗攻击 / 采集产量）；
 * ③ 暴击确定性（同 tick/attacker/target 结果一致）与倍率；
 * ④ 克制减伤按 damageType 生效、抗性钳制边界；
 * ⑤ 无配置零回归（伤害与现状逐值一致）；
 * ⑥ Progression 序列化往返（AoS 自动入档）；
 * ⑦ 真实配置端到端：击杀 4 只野猪升到 2 级并观察技能加成。
 */
import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { addComponent, hasComponent, query } from "bitecs";
import {
  bootstrapFramework,
  createGameInstance,
  createGameSimulation,
  loadGameDefinition,
  serializeWorld,
  restoreWorld,
  spawnEntity,
} from "framework/index";
import type { GameWorld } from "framework/world";
import { Transform } from "framework/components/transform";
import { Health, Attack } from "framework/components/combat";
import { Cooldown } from "framework/components/timer";
import { Equipment } from "framework/components/equipment";
import { Inventory } from "framework/components/inventory";
import { Intent } from "framework/components/intent";
import { Player } from "framework/components/tags";
import { ResourceNode } from "framework/components/resourceNode";
import { Progression } from "framework/components/progression";
import { initInventory } from "framework/components/inventory";
import { attackTarget } from "framework/systems/gameplay/combatSystem";
import { interactionSystem } from "framework/systems/gameplay/interactionSystem";
import { tickActionStates } from "framework/simulation/actions/actionSystem";
import { ActionInput, ActionState } from "framework/simulation/actions/actionState";
import {
  progressionSystem,
  addXp,
  levelForXp,
  getSkillAdd,
  getProgressionRules,
  parseProgressionRules,
} from "framework/systems/gameplay/progression";
import { getEquipModifiers } from "framework/systems/gameplay/equipmentSystem";
import {
  computeStandardDamage,
  applyCritAndResist,
  isCriticalRoll,
  clampDamageResist,
  MAX_DAMAGE_RESIST,
} from "framework/systems/gameplay/damageFormula";
import { rngFrom } from "framework/simulation/rng";
import { STAT_ATTACK } from "framework/simulation/modifiers/modifiers";
import type { LoadedGameDefinition } from "framework/config/schema/GameDefinitionSchema";

let def: LoadedGameDefinition;

beforeAll(() => {
  bootstrapFramework();
  def = loadGameDefinition({ gameJsonPath: "game/game.json" });
});

/** AoS 数组是模块级单例：清空 Progression，防跨用例 eid 复用串扰。 */
beforeEach(() => {
  for (let i = 0; i < Progression.length; i++) Progression[i] = undefined;
  // 动作状态同为模块级 AoS 瞬态：清空防上一 world 的同 eid 动作残留
  for (let i = 0; i < ActionState.length; i++) ActionState[i] = undefined;
  for (let i = 0; i < ActionInput.length; i++) ActionInput[i] = undefined;
  // Cooldown 是 legacy SoA 全局数组：清 0 防跨 world 同 eid 冷却残留
  for (let i = 0; i < Cooldown.remainingMs.length; i++) Cooldown.remainingMs[i] = 0;
});

function newWorld(): GameWorld {
  return createGameInstance(def).world;
}

/**
 * 动作时间轴语义：interact 启动 gather，harvest 在 swing 阶段（elapsed 3）
 * 才结算。手动推进完整动作（10 tick，含 recovery）并运行 actionSystem，
 * 供不经过 GameSimulation 的真实配置用例复用。
 */
function runGatherSwing(world: GameWorld): void {
  for (let i = 0; i < 10; i++) {
    world.time.tick += 1;
    tickActionStates(world);
  }
}

function spawn(world: GameWorld, kind: string, x = 0, y = 0): number {
  return spawnEntity(world, world.archetypes.get(kind), world.components_registry, { x, y });
}

/** 给实体建背包并穿戴指定物品（测试夹具，模拟客户端 equip 命令后的状态）。 */
function equip(world: GameWorld, eid: number, kind: string, slot: "weapon" | "armor" | "tool"): void {
  if (!Inventory[eid]) initInventory(world, eid, { capacity: 4 });
  if (!hasComponent(world, eid, Equipment)) {
    addComponent(world, eid, Equipment);
    Equipment.weaponSlot[eid] = -1;
    Equipment.toolSlot[eid] = -1;
    Equipment.armorSlot[eid] = -1;
  }
  Inventory[eid]!.slots[0] = { kind, count: 1 };
  if (slot === "weapon") Equipment.weaponSlot[eid] = 0;
  else if (slot === "armor") Equipment.armorSlot[eid] = 0;
  else Equipment.toolSlot[eid] = 0;
}

/** 找一个不暴击 / 暴击的 tick（与 combatSystem 同一确定性随机流）。 */
function findCritTick(attacker: number, target: number, wantCrit: boolean, chance: number): number {
  for (let tick = 0; tick < 100000; tick++) {
    const crit = rngFrom(tick, attacker, target, "crit").next() < chance;
    if (crit === wantCrit) return tick;
  }
  throw new Error("no matching crit tick");
}

describe("P2 ① 经验与等级阈值", () => {
  it("击杀/采集经验累加；100 XP 时角色与对应技能同时升到 2 级", () => {
    const world = newWorld();
    const player = spawn(world, "player");

    expect(Progression[player]).toEqual({
      totalXp: 0,
      level: 1,
      skills: {
        combat: { xp: 0, level: 1 },
        gathering: { xp: 0, level: 1 },
      },
    });

    // 99 XP：仍在 1 级
    addXp(world, player, 99, "combat");
    expect(Progression[player]!.totalXp).toBe(99);
    expect(Progression[player]!.level).toBe(1);
    expect(Progression[player]!.skills.combat).toEqual({ xp: 99, level: 1 });

    // 跨过 100 阈值：角色 2 级 + 战斗技能 2 级
    addXp(world, player, 1, "combat");
    expect(Progression[player]!.totalXp).toBe(100);
    expect(Progression[player]!.level).toBe(2);
    expect(Progression[player]!.skills.combat).toEqual({ xp: 100, level: 2 });

    // 下一阈值 = 100 + round(100 × 1.5) = 250
    addXp(world, player, 149, "combat");
    expect(Progression[player]!.level).toBe(2);
    addXp(world, player, 1, "combat");
    expect(Progression[player]!.level).toBe(3);
    expect(Progression[player]!.skills.combat.level).toBe(3);
  });

  it("采集成功按资源节点 xpValue/xpSkill 结算（真实 interaction 路径）", () => {
    const world = newWorld();
    const player = spawn(world, "player");
    const rock = spawn(world, "rock", 8, 0);

    Intent[player] = "interact";
    interactionSystem(world);
    runGatherSwing(world);

    expect(ResourceNode[rock]!.remaining).toBe(4);
    expect(Progression[player]!.totalXp).toBe(4);
    expect(Progression[player]!.skills.gathering).toEqual({ xp: 4, level: 1 });
    expect(Progression[player]!.skills.combat.xp).toBe(0);
  });

  it("击杀事件按目标原型 xpValue/xpSkill 结算，且不消费事件（questSystem 可继续用）", () => {
    const world = newWorld();
    const player = spawn(world, "player");
    world.runtimeEvents.push({
      type: "killed",
      data: { killer: player, victim: 999, kind: "boar" },
    });

    progressionSystem(world);

    expect(Progression[player]!.totalXp).toBe(25);
    expect(Progression[player]!.skills.combat.xp).toBe(25);
    // peek 语义：事件仍在队列里
    expect(world.runtimeEvents.filter((e) => e.type === "killed")).toHaveLength(1);
  });
});

describe("P2 ② 技能加成影响真实数值", () => {
  it("战斗技能加法加成进入攻击基础值（10 → 12）", () => {
    const world = newWorld();
    const player = spawn(world, "player");
    const dummy = spawn(world, "rabbit");

    Attack.value[player] = 10;
    Cooldown.remainingMs[player] = 0;
    Health.current[dummy] = 100;
    Health.max[dummy] = 100;

    // 1 级技能无加成
    expect(getSkillAdd(world, player, STAT_ATTACK)).toBe(0);
    expect(attackTarget(world, player, dummy)).toBe(true);
    expect(Health.current[dummy]).toBe(90);

    // 升到 2 级 → +2 攻击
    addXp(world, player, 100, "combat");
    expect(getSkillAdd(world, player, STAT_ATTACK)).toBe(2);
    Cooldown.remainingMs[player] = 0;
    expect(attackTarget(world, player, dummy)).toBe(true);
    expect(Health.current[dummy]).toBe(78);
  });

  it("采集技能乘法加成放大产量（1 → round(1 × 1.5) = 2）", () => {
    const world = newWorld();
    const player = spawn(world, "player");
    const rock = spawn(world, "rock", 8, 0);

    // 1 级：基线 1 个
    Intent[player] = "interact";
    interactionSystem(world);
    runGatherSwing(world);
    expect(Inventory[player]!.slots.filter((s) => s?.kind === "stone").length).toBe(1);
    expect(Inventory[player]!.slots[0]).toMatchObject({ kind: "stone", count: 1 });

    // 2 级：gatherMult = 1 × (1 + 0.5) = 1.5
    addXp(world, player, 100, "gathering");
    expect(getEquipModifiers(world, player).gatherMult).toBeCloseTo(1.5);
    ResourceNode[rock]!.remaining = 5;
    Cooldown.remainingMs[player] = 0; // 动作级冷却重置（等价时间自然流逝）
    Intent[player] = "interact";
    interactionSystem(world);
    runGatherSwing(world);
    expect(Inventory[player]!.slots[0]).toMatchObject({ kind: "stone", count: 3 });
  });
});

describe("P2 ③ 暴击确定性", () => {
  it("同 tick/attacker/target 的暴击判定与伤害一致（含武器倍率）", () => {
    const world = newWorld();
    const player = spawn(world, "player");
    const dummy = spawn(world, "rabbit");
    equip(world, player, "spear", "weapon");
    Attack.value[player] = 10;
    Health.current[dummy] = 1000;
    Health.max[dummy] = 1000;

    const tick = findCritTick(player, dummy, true, 0.15);
    world.time.tick = tick;

    Cooldown.remainingMs[player] = 0;
    expect(attackTarget(world, player, dummy)).toBe(true);
    const first = 1000 - Health.current[dummy];
    // 基础 = 10（Attack）+ 15（spear） = 25；暴击 ×2 = 50
    expect(first).toBe(50);

    // 重置生命/冷却，同 tick 再打：完全相同
    Health.current[dummy] = 1000;
    Cooldown.remainingMs[player] = 0;
    expect(attackTarget(world, player, dummy)).toBe(true);
    expect(1000 - Health.current[dummy]).toBe(first);
  });

  it("暴击纯函数边界：chance 0 不暴击、chance 1 必暴击、倍率钳制 ≥1", () => {
    expect(isCriticalRoll(0.0, 0)).toBe(false);
    expect(isCriticalRoll(0.999, 1)).toBe(true);
    expect(isCriticalRoll(0.1, 0.15)).toBe(true);
    expect(isCriticalRoll(0.2, 0.15)).toBe(false);
    expect(applyCritAndResist(10, true, 0.5, 0)).toBe(10); // 倍率 <1 归一为 1
    expect(applyCritAndResist(10, true, 2, 0)).toBe(20);
  });
});

describe("P2 ④ 克制减伤", () => {
  it("按 damageType 匹配护甲 resist；不匹配不减伤", () => {
    const world = newWorld();
    const player = spawn(world, "player");
    const dummy = spawn(world, "rabbit");

    equip(world, player, "spear", "weapon");
    equip(world, dummy, "shell_armor", "armor");
    Attack.value[player] = 10;
    Health.current[dummy] = 1000;
    Health.max[dummy] = 1000;

    // 无暴击 tick：标准伤害 = 25 - 4（护甲防御）= 21；pierce 抗性 0.3 → round(14.7) = 15
    world.time.tick = findCritTick(player, dummy, false, 0.15);
    Cooldown.remainingMs[player] = 0;
    expect(attackTarget(world, player, dummy)).toBe(true);
    expect(1000 - Health.current[dummy]).toBe(15);

    // 换成只抗 fire 的护甲：pierce 无匹配 → 只吃防御 4，伤害 21
    world.gameDef.itemsByKind!.set("test_fire_armor", {
      kind: "test_fire_armor",
      equip: { slot: "armor", defenseBonus: 4 },
      resist: { fire: 0.5 },
    });
    equip(world, dummy, "test_fire_armor", "armor");
    Health.current[dummy] = 1000;
    Cooldown.remainingMs[player] = 0;
    expect(attackTarget(world, player, dummy)).toBe(true);
    expect(1000 - Health.current[dummy]).toBe(21);
  });

  it("抗性钳制：负值按 0、超过上限按 0.9", () => {
    expect(clampDamageResist(-1)).toBe(0);
    expect(clampDamageResist(0.5)).toBe(0.5);
    expect(clampDamageResist(2)).toBe(MAX_DAMAGE_RESIST);
    expect(applyCritAndResist(100, false, undefined, 2)).toBe(10);
    expect(applyCritAndResist(100, false, undefined, -3)).toBe(100);
  });
});

describe("P2 ⑤ 无配置零回归", () => {
  it("标准伤害在无暴击/无抗性时逐值不变（含小数防御）", () => {
    for (const [base, defense] of [
      [10, 0],
      [10, 4],
      [5, 10],
      [10, 0.5],
    ] as const) {
      const standard = computeStandardDamage(base, defense);
      expect(applyCritAndResist(standard, false, undefined, undefined)).toBe(standard);
    }
  });

  it("未配置暴击/克制的攻击伤害与接入前一致（10 攻 → 10 伤害）", () => {
    const world = newWorld();
    const player = spawn(world, "player");
    const dummy = spawn(world, "rabbit");
    Attack.value[player] = 10;
    Cooldown.remainingMs[player] = 0;

    expect(attackTarget(world, player, dummy)).toBe(true);
    expect(Health.current[dummy]).toBe(10);
  });
});

describe("P2 ⑥ Progression 序列化往返", () => {
  it("经验/等级/技能随世界快照入档并完整恢复", () => {
    const world = newWorld();
    const player = spawn(world, "player");
    addXp(world, player, 120, "combat");
    addXp(world, player, 40, "gathering");

    const record = serializeWorld(world, "p2");
    const saved = record.entities.find((e) => e.kind === "player");
    expect(saved?.components.Progression).toEqual({
      totalXp: 160,
      level: 2,
      skills: {
        combat: { xp: 120, level: 2 },
        gathering: { xp: 40, level: 1 },
      },
    });

    const world2 = newWorld();
    restoreWorld(world2, record);
    const restored = query(world2, [Player])[0];
    expect(restored).toBeTypeOf("number");
    expect(Progression[restored]).toEqual({
      totalXp: 160,
      level: 2,
      skills: {
        combat: { xp: 120, level: 2 },
        gathering: { xp: 40, level: 1 },
      },
    });
  });
});

describe("P2 规则 fail-fast", () => {
  it("非法曲线 / 技能表 / 未知 xpSkill 在模块内抛错", () => {
    expect(() => parseProgressionRules({ curve: { baseXp: 0 } })).toThrow(/baseXp/);
    expect(() =>
      parseProgressionRules({ skills: { combat: { stat: "", perLevel: 1 } } }),
    ).toThrow(/stat/);
    expect(() =>
      parseProgressionRules({ skills: { combat: { stat: "attack", perLevel: 1, mode: "bad" } } }),
    ).toThrow(/mode/);
  });
});

describe("P2 ⑦ 真实配置端到端：击杀 4 只野猪升到 2 级", () => {
  it("4 × 25 XP = 100 → 角色 2 级 / 战斗技能 2 级，攻击加成 +2", async () => {
    const sim = await createGameSimulation(def);
    const world = (sim as unknown as { world: GameWorld }).world;
    const player = query(world, [Player])[0] ?? spawn(world, "player");
    // 让玩家一击必杀，保证每 tick 一次有效击杀
    Attack.value[player] = 100;
    Attack.range[player] = 64;
    Transform.x[player] = 0;
    Transform.y[player] = 0;
    Health.current[player] = 100;

    for (let i = 0; i < 4; i++) {
      const boar = spawn(world, "boar", 0, 0);
      Health.current[boar] = 60;
      Cooldown.remainingMs[player] = 0;
      Intent[player] = "attack";
      // GameSimulation.tick 走完整系统链：interaction 启动动作 → active/hit
      // 事件阶段调用 attackTarget → progression 同 tick 结算击杀经验。
      sim.tick(50);
      // attack 配置：elapsed 4 进入 active 才结算（start 后第 4 个 tick）
      for (let wait = 0; wait < 4; wait++) sim.tick(50);
      expect(Health.current[boar] ?? 0).toBeLessThanOrEqual(0);
      // 等动作总时长（12 tick）结束，避免非 interruptible 动作拒绝下一轮启动
      for (let wait = 0; wait < 8; wait++) sim.tick(50);
    }

    expect(Progression[player]!.totalXp).toBe(100);
    expect(Progression[player]!.level).toBe(2);
    expect(Progression[player]!.skills.combat).toEqual({ xp: 100, level: 2 });
    expect(getSkillAdd(world, player, STAT_ATTACK)).toBe(2);
    expect(levelForXp(100, getProgressionRules(world).curve)).toBe(2);
  });
});
