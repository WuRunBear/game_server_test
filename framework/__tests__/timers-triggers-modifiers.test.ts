/**
 * 定时器、修饰符与触发器子系统测试。
 *
 * 覆盖：ExpiresAt 一次性定时（触发一次/清理/未到期不动）、Interval 周期
 * 定时（N 次/耗尽清理/无限重复）、Modifiers 条目合成（乘加顺序/叠加/
 * 过期失效/布尔取或）、triggerRegistry、on-timer / on-command 触发器
 * 闭环（定时器/命令事件 → 触发器 → 效果执行）。
 */
import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { addComponent, addEntity, hasComponent } from "bitecs";
import {
  bootstrapFramework,
  createGameInstance,
  createDefaultGameDefinition,
  timerSystem,
  triggerSystem,
  setExpiresAt,
  setIntervalTimer,
  clearTimers,
  computeStat,
  addModifier,
  addTrigger,
  registerTrigger,
  getTrigger,
  hasTrigger,
  queueEvent,
  drainEvents,
  Modifiers,
  ExpiresAt,
  Interval,
  Triggers,
} from "framework/index";
import { Transform } from "framework/components/transform";
import { NetworkId } from "framework/components/network";
import { Health } from "framework/components/combat";
import { EntityMap } from "framework/components/entityMap";
import type { GameWorld } from "framework/world";

beforeAll(() => {
  bootstrapFramework();
});

/** 构造测试世界（默认配置）。 */
function createBareWorld(): GameWorld {
  return createGameInstance(createDefaultGameDefinition()).world;
}

/** 清空本文件涉及的 AoS 模块级单例（防跨用例 eid 复用串扰）。 */
function clearAos(): void {
  for (let i = 0; i < Modifiers.length; i++) Modifiers[i] = undefined;
  for (let i = 0; i < ExpiresAt.length; i++) ExpiresAt[i] = undefined;
  for (let i = 0; i < Interval.length; i++) Interval[i] = undefined;
  for (let i = 0; i < Triggers.length; i++) Triggers[i] = undefined;
}

beforeEach(() => {
  clearAos();
});

/** 手工生成测试实体。 */
function spawnTestEntity(world: GameWorld, opts: { hp?: number } = {}): number {
  const eid = addEntity(world);
  addComponent(world, eid, Transform);
  addComponent(world, eid, NetworkId);
  if (opts.hp !== undefined) {
    addComponent(world, eid, Health);
    Health.current[eid] = opts.hp;
    Health.max[eid] = opts.hp;
  }
  NetworkId.value[eid] = world.nextNetworkId++;
  EntityMap[eid] = world.defaultMapId;
  return eid;
}

// 定时器组件与系统
describe("定时器（ExpiresAt / Interval / timerSystem）", () => {
  it("一次性到期：触发一次效果 + 发 on-timer 事件 + 条目清理", () => {
    const world = createBareWorld();
    world.time.tick = 5;
    const target = spawnTestEntity(world, { hp: 10 });
    setExpiresAt(target, 7, { name: "damage", params: { amount: 3 } });

    // 未到期：不动
    timerSystem(world);
    expect(Health.current[target]).toBe(10);
    expect(ExpiresAt[target]).toBeDefined();
    expect(drainEvents(world).length).toBe(0);

    // 到期：扣血 + 事件 + 清理
    world.time.tick = 7;
    timerSystem(world);
    expect(Health.current[target]).toBe(7); // 无 Defense → max(1, 3-0) = 3
    expect(ExpiresAt[target]).toBeUndefined();
    const events = drainEvents(world);
    expect(events.length).toBe(1);
    expect(events[0].name).toBe("on-timer");
    expect(events[0].payload).toEqual({ eid: target, phase: "expired" });
  });

  it("无效果引用的一次性定时器：仅发事件并清理", () => {
    const world = createBareWorld();
    const target = spawnTestEntity(world);
    setExpiresAt(target, 1);
    world.time.tick = 1;
    timerSystem(world);
    expect(ExpiresAt[target]).toBeUndefined();
    expect(drainEvents(world)[0].name).toBe("on-timer");
  });

  it("周期定时器：触发 N 次后耗尽清理", () => {
    const world = createBareWorld();
    const target = spawnTestEntity(world, { hp: 100 });
    // 周期 2 tick，共 3 次，首次触发在第 2 tick
    setIntervalTimer(target, 2, 2, 3, { name: "damage", params: { amount: 1 } });

    world.time.tick = 5; // 第 2/4 tick 触发两次，第 5 tick 未到第 6 次
    timerSystem(world);
    expect(Health.current[target]).toBe(98);
    expect(Interval[target]).toBeDefined();
    expect(Interval[target]!.remaining).toBe(1);
    expect(Interval[target]!.nextTick).toBe(6);
    drainEvents(world);

    world.time.tick = 6; // 第三次触发后耗尽
    timerSystem(world);
    expect(Health.current[target]).toBe(97);
    expect(Interval[target]).toBeUndefined();
    drainEvents(world);

    // 清理后不再触发
    world.time.tick = 8;
    timerSystem(world);
    expect(Health.current[target]).toBe(97);
    expect(drainEvents(world).length).toBe(0);
  });

  it("周期定时器无限模式（remaining < 0）持续触发；单 tick 补触发有上限", () => {
    const world = createBareWorld();
    const target = spawnTestEntity(world);
    setIntervalTimer(target, 1, 1, -1); // 每 tick 一次，无限

    world.time.tick = 10;
    timerSystem(world);
    // tick 1..10 共 10 次到期（< 64 上限），追帧全部补齐
    expect(Interval[target]).toBeDefined();
    expect(Interval[target]!.nextTick).toBe(11);
    const events = drainEvents(world);
    expect(events.length).toBe(10);
  });

  it("clearTimers 清除全部定时器；非法周期条目被防御性清理", () => {
    const world = createBareWorld();
    const a = spawnTestEntity(world);
    const b = spawnTestEntity(world);
    setExpiresAt(a, 1);
    setIntervalTimer(a, 2, 2, 5);
    clearTimers(a);
    expect(ExpiresAt[a]).toBeUndefined();
    expect(Interval[a]).toBeUndefined();

    // 非法周期（0）：直接清理不触发
    setIntervalTimer(b, 0, 1, 5);
    world.time.tick = 5;
    timerSystem(world);
    expect(Interval[b]).toBeUndefined();
    expect(drainEvents(world).length).toBe(0);
  });
});

// 属性修饰符
describe("修饰符（Modifiers / computeStat）", () => {
  it("乘加顺序：base × (1+Σmul) + Σadd", () => {
    const world = createBareWorld();
    const eid = spawnTestEntity(world);
    addModifier(world, eid, "stat", { mul: 0.5 });
    addModifier(world, eid, "stat", { add: 5 });
    // 10 × 1.5 + 5 = 20（先乘后加）
    expect(computeStat(world, eid, "stat", 10)).toBe(20);
  });

  it("多条叠加：Σmul / Σadd 求和", () => {
    const world = createBareWorld();
    const eid = spawnTestEntity(world);
    addModifier(world, eid, "stat", { mul: 0.5 });
    addModifier(world, eid, "stat", { mul: 1.0 });
    addModifier(world, eid, "stat", { add: 2 });
    expect(computeStat(world, eid, "stat", 10)).toBe(27); // 10 × (1+1.5) + 2
  });

  it("过期条目自然失效（expiresTick 时刻起）", () => {
    const world = createBareWorld();
    world.time.tick = 10;
    const eid = spawnTestEntity(world);
    addModifier(world, eid, "stat", { mul: 0.5, expiresTick: 12 }); // 12 起失效
    addModifier(world, eid, "stat", { add: 1 }); // 永久

    world.time.tick = 11;
    expect(computeStat(world, eid, "stat", 10)).toBe(16); // 10×1.5+1

    world.time.tick = 12; // expiresTick 时刻已失效
    expect(computeStat(world, eid, "stat", 10)).toBe(11); // 10×1+1
  });

  it("bool 条目取或：任一 true 即 true；全部 false 为 false", () => {
    const world = createBareWorld();
    const eid = spawnTestEntity(world);
    addModifier(world, eid, "stunned", { bool: false });
    addModifier(world, eid, "stunned", { bool: true });
    expect(computeStat(world, eid, "stunned", 0)).toBe(true);

    addModifier(world, eid, "slowed", { bool: false });
    expect(computeStat(world, eid, "slowed", 0)).toBe(false);

    // 无任何条目 → 返回 base
    expect(computeStat(world, eid, "other", 7)).toBe(7);
  });
});

// 触发器
describe("触发器（triggerRegistry / triggerSystem）", () => {
  it("内建求值器已注册；未注册名返回 undefined；重复注册抛错", () => {
    for (const name of ["on-timer", "on-command", "on-hit", "on-contact", "on-death", "on-region-enter", "on-region-clear"]) {
      expect(hasTrigger(name)).toBe(true);
      expect(getTrigger(name)).toBeTypeOf("function");
    }
    expect(hasTrigger("no-such-trigger")).toBe(false);
    expect(() => registerTrigger("on-timer", () => undefined)).toThrow("already registered");
  });

  it("on-timer 闭环：定时器到期 → 触发器执行 Triggers 声明的效果", () => {
    const world = createBareWorld();
    const target = spawnTestEntity(world);
    // SoA 全局单例防残留：显式清零位移
    Transform.x[target] = 0;
    Transform.y[target] = 0;
    addTrigger(target, { trigger: "on-timer", effects: [{ name: "impulse", params: { dx: 5, dy: 0 } }] });
    setExpiresAt(target, 4); // 无直接效果引用——效果走 Triggers 声明

    world.time.tick = 3;
    timerSystem(world); // 未到期：无事件
    expect(Transform.x[target]).toBe(0);

    world.time.tick = 4;
    timerSystem(world); // 到期：发 on-timer 事件（无直接效果引用）
    expect(Transform.x[target]).toBe(0);

    triggerSystem(world); // 消费事件：on-timer 求值器执行 impulse
    expect(Transform.x[target]).toBe(5);
    // 事件已被消费清空
    expect(drainEvents(world).length).toBe(0);
  });

  it("on-command 闭环：命令事件 → 触发器执行效果（效果目标=owner）", () => {
    const world = createBareWorld();
    const target = spawnTestEntity(world, { hp: 10 });
    Health.current[target] = 5; // 受损状态，治疗可见
    addTrigger(target, {
      trigger: "on-command",
      effects: [{ name: "heal", params: { amount: 3 } }],
    });

    queueEvent(world, "on-command", { eid: target, type: "consume" });
    triggerSystem(world);
    expect(Health.current[target]).toBe(8);
  });

  it("事件载荷 target 优先作为效果缺省目标", () => {
    const world = createBareWorld();
    const owner = spawnTestEntity(world);
    const victim = spawnTestEntity(world, { hp: 10 });
    addTrigger(owner, {
      trigger: "on-contact",
      effects: [{ name: "damage", params: { amount: 4 } }],
    });

    queueEvent(world, "on-contact", { eid: owner, target: victim, x: 0, y: 0 });
    triggerSystem(world);
    expect(Health.current[victim]).toBe(6); // 伤害落在 target
    expect(hasComponent(world, owner, Health)).toBe(false); // owner 无 Health 未受影响
  });

  it("未知事件名/载荷缺 eid/无 Triggers 实体：安全跳过", () => {
    const world = createBareWorld();
    const target = spawnTestEntity(world);
    // bitecs legacy SoA 数组为模块级全局单例（eid 槽位跨 world 共享）：
    // 显式清零位移，防前一用例 impulse 残留干扰绝对值断言
    Transform.x[target] = 0;
    Transform.y[target] = 0;
    addTrigger(target, { trigger: "on-timer", effects: [{ name: "impulse", params: { dx: 5 } }] });

    // 未注册求值器的自定义事件名：跳过不崩（直接入队绕过类型约束）
    world.eventBus.queue.push({ name: "on-nothing", payload: { eid: target } });
    // 载荷缺 eid：跳过
    world.eventBus.queue.push({ name: "on-timer", payload: { phase: "expired" } });
    // 未挂 Triggers 的实体事件：跳过
    const stranger = spawnTestEntity(world);
    queueEvent(world, "on-timer", { eid: stranger, phase: "expired" });

    triggerSystem(world);
    // target 的 on-timer 触发器未被命中（无其事件）→ 效果未执行
    expect(Transform.x[target]).toBe(0);
    expect(drainEvents(world).length).toBe(0);
  });

  it("registerTrigger 自定义求值器可用（经 applyEffectSpecs 语义自定）", () => {
    const world = createBareWorld();
    let called = 0;
    registerTrigger("on-test-custom", (_ctx, effects) => {
      called += effects.length;
    });
    const target = spawnTestEntity(world);
    addTrigger(target, { trigger: "on-test-custom", effects: [{ name: "impulse" }, { name: "impulse" }] });
    world.eventBus.queue.push({ name: "on-test-custom", payload: { eid: target } });
    triggerSystem(world);
    expect(called).toBe(2);
  });
});
