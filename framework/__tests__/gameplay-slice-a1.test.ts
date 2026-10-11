/**
 * 玩法切片 A1 测试：激活状态效果闭环（Modifiers 接线 + 过期清理 + timer/trigger）。
 *
 * 覆盖：
 * ① Modifiers 接线——移动速度（movementSystem）与攻击/防御（attackTarget）按
 *    施加的 stat 修饰符改变；
 * ② 过期清理——modifierSystem 每 tick 剔除过期条目并回收空集合，行为回基线；
 * ③ 持续伤害按 tick 结算——真实 game 配置的 set-timer 周期 + on-timer 触发器；
 * ④ 真实配置示例有效——game.json 启用 timer/trigger/modifier，raw_meat 的
 *    状态/定时效果与 player 的 Triggers 声明真的按 tick 被求值；
 * ⑤ 入档恢复——Modifiers 随存档持久化，恢复后 computeStat 结果一致。
 */
import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { addComponent, addEntity, hasComponent, query } from "bitecs";
import {
  bootstrapFramework,
  createGameInstance,
  createDefaultGameDefinition,
  createGameSimulation,
  loadGameDefinition,
  modifierSystem,
  timerSystem,
  triggerSystem,
  addModifier,
  computeStat,
  computeNumericStat,
  Modifiers,
  Triggers,
  Interval,
  initTriggers,
  applyEffectSpecs,
  serializeWorld,
  restoreWorld,
  spawnEntity,
  getRegistries,
} from "framework/index";
import { movementSystem } from "framework/systems/core/movementSystem";
import { attackTarget } from "framework/systems/gameplay/combatSystem";
import { Transform } from "framework/components/transform";
import { Velocity } from "framework/components/physics";
import { Attack, Defense, Health } from "framework/components/combat";
import { Cooldown } from "framework/components/timer";
import { NetworkId } from "framework/components/network";
import { EntityMap } from "framework/components/entityMap";
import { Player } from "framework/components/tags";
import { Inventory } from "framework/components/inventory";
import type { GameWorld } from "framework/world";
import type { EffectSpec } from "framework/index";

beforeAll(() => {
  bootstrapFramework();
});

/** 清空本文件涉及的 AoS 模块级单例（防跨用例 eid 复用串扰）。 */
function clearAos(): void {
  for (let i = 0; i < Modifiers.length; i++) Modifiers[i] = undefined;
  for (let i = 0; i < Triggers.length; i++) Triggers[i] = undefined;
}

beforeEach(() => {
  clearAos();
});

function createBareWorld(): GameWorld {
  return createGameInstance(createDefaultGameDefinition()).world;
}

/** 手工生成测试实体（Transform + NetworkId + 归属）。 */
function spawnTestEntity(world: GameWorld, opts: { hp?: number; defense?: number } = {}): number {
  const eid = addEntity(world);
  addComponent(world, eid, Transform);
  addComponent(world, eid, NetworkId);
  if (opts.hp !== undefined) {
    addComponent(world, eid, Health);
    Health.current[eid] = opts.hp;
    Health.max[eid] = opts.hp;
  }
  if (opts.defense !== undefined) {
    addComponent(world, eid, Defense);
    Defense.value[eid] = opts.defense;
  }
  NetworkId.value[eid] = world.nextNetworkId++;
  EntityMap[eid] = world.defaultMapId;
  return eid;
}

// ① Modifiers 接线：移动 / 攻击 / 防御
describe("Slice A1：Modifiers 接线", () => {
  it("移动速度：无修饰符按基础位移，减速状态按 mul 缩放位移", () => {
    const world = createBareWorld();
    world.time.dtMs = 1000; // dt=1s，位移 = 速度
    const eid = spawnTestEntity(world);
    addComponent(world, eid, Velocity);
    Velocity.vx[eid] = 100;
    Velocity.vy[eid] = 0;

    // 基线：无修饰符 → 100
    Transform.x[eid] = 0;
    movementSystem(world);
    expect(Transform.x[eid]).toBe(100);

    // 施加 -50% 减速 → 位移减半
    addModifier(world, eid, "moveSpeed", { mul: -0.5, source: "slow" });
    Transform.x[eid] = 0;
    movementSystem(world);
    expect(Transform.x[eid]).toBe(50);
  });

  it("攻击力：attack 修饰符叠加在 Attack 组件基础值上", () => {
    const world = createBareWorld();
    const attacker = spawnTestEntity(world);
    const target = spawnTestEntity(world, { hp: 100, defense: 0 });
    addComponent(world, attacker, Attack);
    Attack.value[attacker] = 10;
    Attack.range[attacker] = 100;
    addComponent(world, attacker, Cooldown);

    // 基线：10 攻 → 10 伤害
    Cooldown.remainingMs[attacker] = 0;
    expect(attackTarget(world, attacker, target)).toBe(true);
    expect(Health.current[target]).toBe(90);

    // +5 攻击修饰符 → 15 伤害
    addModifier(world, attacker, "attack", { add: 5 });
    Cooldown.remainingMs[attacker] = 0;
    expect(attackTarget(world, attacker, target)).toBe(true);
    expect(Health.current[target]).toBe(75);
  });

  it("防御力：defense 修饰符降低实际伤害（computeStandardDamage 共用路径）", () => {
    const world = createBareWorld();
    const attacker = spawnTestEntity(world);
    const target = spawnTestEntity(world, { hp: 100, defense: 0 });
    addComponent(world, attacker, Attack);
    Attack.value[attacker] = 10;
    Attack.range[attacker] = 100;
    addComponent(world, attacker, Cooldown);

    addModifier(world, target, "defense", { add: 4 });
    Cooldown.remainingMs[attacker] = 0;
    expect(attackTarget(world, attacker, target)).toBe(true);
    expect(Health.current[target]).toBe(94); // max(1, 10 - 4)
  });

  it("computeNumericStat：bool 条目存在时折算为 1/0", () => {
    const world = createBareWorld();
    const eid = spawnTestEntity(world);
    addModifier(world, eid, "attack", { bool: true });
    expect(computeNumericStat(world, eid, "attack", 10)).toBe(1);
    addModifier(world, eid, "attack", { mul: 0.5, add: 3 });
    expect(computeNumericStat(world, eid, "attack", 10)).toBe(1); // bool 优先
  });
});

// ② 过期清理
describe("Slice A1：修饰符过期清理", () => {
  it("未到期保留；到期被清理并回收空集合，行为回基线", () => {
    const world = createBareWorld();
    const eid = spawnTestEntity(world);
    world.time.tick = 10;
    addModifier(world, eid, "moveSpeed", { mul: -0.5, expiresTick: 12 });
    addModifier(world, eid, "moveSpeed", { mul: 0.25 }); // 永久条目

    modifierSystem(world);
    expect(Modifiers[eid]!["moveSpeed"].length).toBe(2);
    expect(computeStat(world, eid, "moveSpeed", 1)).toBe(0.75); // 1×(1-0.5+0.25)

    world.time.tick = 12; // 过期时刻起失效
    modifierSystem(world);
    expect(Modifiers[eid]!["moveSpeed"].length).toBe(1); // 仅永久条目
    expect(computeStat(world, eid, "moveSpeed", 1)).toBe(1.25);

    // 移除唯一剩余条目 → 空键与集合一并回收，行为完全回基线
    delete Modifiers[eid]!["moveSpeed"];
    modifierSystem(world);
    expect(Modifiers[eid]).toBeUndefined();
    expect(computeStat(world, eid, "moveSpeed", 1)).toBe(1);
  });
});

// ③④ 真实配置：持续伤害按 tick 结算（set-timer 周期 + on-timer 触发器）
describe("Slice A1：timer/trigger 配置驱动闭环（持续伤害）", () => {
  it("game.json 启用 timer/trigger/modifier，raw_meat 效果按 tick 触发掉血", () => {
    const def = loadGameDefinition({ gameJsonPath: "game/game.json" });
    const enabledIds = def.systems!.map((s) => s.id);
    expect(enabledIds).toContain("timer");
    expect(enabledIds).toContain("trigger");
    expect(enabledIds).toContain("modifier");

    // 配置示例：raw_meat 食用后施加减速 + 周期定时器
    const rawMeat = def.resolvedItems.find((i) => i.kind === "raw_meat")!;
    expect(rawMeat.effects?.map((e) => e.name)).toEqual(["apply-status", "set-timer"]);

    // 配置示例：player 原型声明 on-timer 触发器 → 周期伤害
    const playerArch = def.resolvedEntities.find((e) => e.kind === "player")!;
    const triggers = playerArch.components.Triggers as { trigger: string; effects: EffectSpec[] }[];
    expect(triggers[0].trigger).toBe("on-timer");
    expect(triggers[0].effects[0]).toEqual({ name: "damage", params: { amount: 3 } });

    // 用真实配置的效果/触发器在受控世界中复现（确定性，无 AI/敌人干扰）
    const world = createBareWorld();
    const eid = spawnTestEntity(world, { hp: 100, defense: 0 });
    initTriggers(world, eid, triggers);
    expect(Triggers[eid]!.length).toBe(1);

    applyEffectSpecs(world, eid, [eid], rawMeat.effects as EffectSpec[]);

    // 施加即生效：减速状态落位（moveSpeed 条目）
    expect(Modifiers[eid]!["moveSpeed"]?.length).toBe(1);
    expect(computeNumericStat(world, eid, "moveSpeed", 1)).toBe(0.5);

    // 逐 tick 推进：period=10 / delay=10 / ticks=3 → 第 10/20/30 tick 各 3 点伤害
    for (let t = 1; t <= 30; t++) {
      world.time.tick = t;
      timerSystem(world);
      triggerSystem(world);
      modifierSystem(world);
    }
    expect(Health.current[eid]).toBe(100 - 3 * 3); // 91

    // 状态到期（durationTicks=60）后：定时器已耗尽，修饰符被清理
    for (let t = 31; t <= 61; t++) {
      world.time.tick = t;
      timerSystem(world);
      triggerSystem(world);
      modifierSystem(world);
    }
    expect(Health.current[eid]).toBe(91); // 不再掉血
    expect(Modifiers[eid]).toBeUndefined(); // 过期条目已回收
    expect(computeNumericStat(world, eid, "moveSpeed", 1)).toBe(1); // 回基线
  });

  it("set-timer 一次性（expires）与嵌套效果：到期经 effectRegistry 求值", () => {
    const world = createBareWorld();
    const eid = spawnTestEntity(world, { hp: 100, defense: 0 });
    world.time.tick = 0;
    applyEffectSpecs(world, eid, [eid], [
      { name: "set-timer", params: { mode: "expires", durationTicks: 3, effect: { name: "damage", params: { amount: 7 } } } },
    ]);

    world.time.tick = 2;
    timerSystem(world);
    expect(Health.current[eid]).toBe(100); // 未到期
    world.time.tick = 3;
    timerSystem(world);
    expect(Health.current[eid]).toBe(93); // 到期结算嵌套 damage
  });

  it("真实 sim 端到端：命令通道食用 raw_meat → 状态 + 定时器落位", async () => {
    const def = loadGameDefinition({ gameJsonPath: "game/game.json" });
    const sim = await createGameSimulation(def);
    sim.addPlayer("s1");
    const world = (sim as unknown as { world: GameWorld }).world;
    const playerEid = query(world, [Player])[0];

    // 配置声明的 Triggers 经 AoS 初始化钩子落到真实玩家实体
    expect(Triggers[playerEid]!.map((t) => t.trigger)).toContain("on-timer");

    const inv = Inventory[playerEid]!;
    inv.slots[0] = { kind: "raw_meat", count: 1 };
    expect(sim.submitCommand("s1", { type: "consume", slot: 0 })).toBe(true);

    expect(Modifiers[playerEid]!["moveSpeed"]?.length).toBe(1); // 减速状态施加
    expect(Interval[playerEid]!.periodTicks).toBe(10); // 周期定时器落位
  });
});

describe("Slice A1：修饰符入档恢复", () => {
  it("Modifiers 随存档持久化，恢复后 computeStat 与施加时一致", () => {
    const world = createBareWorld();
    const { archetypeRegistry, componentRegistry } = getRegistries();
    const eid = spawnEntity(world, archetypeRegistry.get("player"), componentRegistry, { x: 0, y: 0 });
    expect(hasComponent(world, eid, Player)).toBe(true);

    world.time.tick = 5;
    addModifier(world, eid, "moveSpeed", { mul: -0.5, expiresTick: 100, source: "poison" });
    addModifier(world, eid, "attack", { add: 3 });
    const networkId = NetworkId.value[eid];

    const record = serializeWorld(world, "a1");
    const target = createBareWorld();
    restoreWorld(target, record);

    const restored = query(target, [NetworkId]).find((e) => NetworkId.value[e] === networkId);
    expect(restored).toBeDefined();
    expect(computeStat(target, restored!, "moveSpeed", 1)).toBe(0.5);
    expect(computeStat(target, restored!, "attack", 10)).toBe(13);
  });
});
