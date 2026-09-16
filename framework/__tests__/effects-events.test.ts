/**
 * 类型化事件总线、效果系统与投射物子系统测试。
 *
 * 覆盖：事件总线（排队/派发顺序/订阅/隔离）、效果注册表、七个内置效果
 * （damage/heal/spawn-projectile/apply-status/impulse/ledger/spawn-entity）、
 * 伤害公式纯函数、projectileSystem（直线运动/墙阻挡/接触事件/寿命销毁）。
 */
import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { query, addComponent, addEntity, hasComponent } from "bitecs";
import {
  bootstrapFramework,
  createGameInstance,
  createDefaultGameDefinition,
  queueEvent,
  subscribeEvent,
  drainEvents,
  dispatchEvents,
  registerEffect,
  getEffect,
  hasEffect,
  listEffects,
  applyEffectSpecs,
  computeStandardDamage,
  Modifiers,
  ExpiresAt,
  Interval,
  Triggers,
} from "framework/index";
import { Transform } from "framework/components/transform";
import { NetworkId } from "framework/components/network";
import { Health, Defense } from "framework/components/combat";
import { Projectile } from "framework/components/projectile";
import { EntityMap } from "framework/components/entityMap";
import { Ledger } from "framework/components/ledger";
import { projectileSystem } from "framework/systems/gameplay/projectileSystem";
import { makeTestGeometry } from "./helpers/mapGeometry";
import type { GameWorld } from "framework/world";
import type { EffectContext } from "framework/simulation/effects/effectRegistry";

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
  for (let i = 0; i < Ledger.length; i++) Ledger[i] = undefined;
  for (let i = 0; i < Triggers.length; i++) Triggers[i] = undefined;
}

beforeEach(() => {
  clearAos();
});

/** 手工生成测试实体（Transform + NetworkId，可选战斗组件）。 */
function spawnTestEntity(
  world: GameWorld,
  opts: { x?: number; y?: number; hp?: number; defense?: number } = {},
): number {
  const eid = addEntity(world);
  addComponent(world, eid, Transform);
  addComponent(world, eid, NetworkId);
  Transform.x[eid] = opts.x ?? 0;
  Transform.y[eid] = opts.y ?? 0;
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
  // EntityMap 为模块级 AoS 单例：显式写归属，防 eid 复用残留串扰
  EntityMap[eid] = world.defaultMapId;
  return eid;
}

/** 效果执行上下文构造工具。 */
function makeCtx(world: GameWorld, overrides: Partial<EffectContext> = {}): EffectContext {
  return {
    world,
    source: overrides.source ?? 0,
    targets: overrides.targets ?? [],
    position: overrides.position,
    params: overrides.params ?? {},
  };
}

// 类型化事件总线
describe("事件总线（eventBus）", () => {
  it("入队 → drain 按 FIFO 取出并清空", () => {
    const world = createBareWorld();
    queueEvent(world, "on-command", { eid: 1, type: "consume" });
    queueEvent(world, "on-timer", { eid: 2, phase: "expired" });

    const events = drainEvents(world);
    expect(events.map((e) => e.name)).toEqual(["on-command", "on-timer"]);
    // 清空式消费：二次 drain 为空
    expect(drainEvents(world)).toEqual([]);
  });

  it("dispatch：订阅者按事件顺序与订阅顺序调用；处理器抛错不中断", () => {
    const world = createBareWorld();
    const calls: string[] = [];
    const off1 = subscribeEvent(world, "on-command", (payload) => {
      calls.push(`a:${(payload as { eid: number }).eid}`);
    });
    subscribeEvent(world, "on-command", () => {
      calls.push("b");
      throw new Error("handler boom");
    });
    subscribeEvent(world, "on-command", () => calls.push("c"));

    queueEvent(world, "on-command", { eid: 7, type: "drop" });
    dispatchEvents(world);

    expect(calls).toEqual(["a:7", "b", "c"]);
    off1();
    queueEvent(world, "on-command", { eid: 8, type: "drop" });
    dispatchEvents(world);
    expect(calls).toEqual(["a:7", "b", "c", "b", "c"]);
  });

  it("tick 隔离：GameInstance.step 帧首清空未消费队列", () => {
    const gameDef = createDefaultGameDefinition();
    const instance = createGameInstance(gameDef);
    queueEvent(instance.world, "on-command", { eid: 1, type: "consume" });
    instance.step(50);
    expect(instance.world.eventBus.queue.length).toBe(0);
  });
});

// 效果注册表
describe("效果注册表（effectRegistry）", () => {
  it("内建效果已注册（七个）", () => {
    for (const name of ["damage", "heal", "spawn-projectile", "apply-status", "impulse", "ledger", "spawn-entity"]) {
      expect(hasEffect(name)).toBe(true);
    }
    expect(listEffects()).toContain("damage");
    expect(getEffect("damage")).toBeTypeOf("function");
  });

  it("重复注册同名效果抛错；未注册名 applyEffectSpecs 告警跳过并返回 false", () => {
    expect(() => registerEffect("damage", () => true)).toThrow("already registered");
    expect(hasEffect("no-such-effect")).toBe(false);

    const world = createBareWorld();
    const ok = applyEffectSpecs(world, 0, [], [{ name: "no-such-effect" }]);
    expect(ok).toBe(false);
  });
});

// 伤害公式纯函数（combat 与 damage 效果共用）
describe("伤害公式（damageFormula）", () => {
  it("max(1, base - defense)：防御减免 + 保底下限 1", () => {
    expect(computeStandardDamage(10, 3)).toBe(7);
    expect(computeStandardDamage(3, 10)).toBe(1);
    expect(computeStandardDamage(5, 0)).toBe(5);
  });
});

// 内置效果
describe("内置效果", () => {
  it("damage：按防御前基础量扣血；致命伤害发 killed 事件", () => {
    const world = createBareWorld();
    const target = spawnTestEntity(world, { hp: 10, defense: 3 });
    const ok = getEffect("damage")!(makeCtx(world, { targets: [target], params: { amount: 5 } }));
    expect(ok).toBe(true);
    expect(Health.current[target]).toBe(8); // 10 - max(1, 5-3)

    // 致命：无 Defense 组件时全额扣减；killed 事件入帧内队列
    const victim = spawnTestEntity(world, { hp: 2 });
    getEffect("damage")!(makeCtx(world, { source: 42, targets: [victim], params: { amount: 9 } }));
    expect(Health.current[victim]).toBeLessThanOrEqual(0);
    expect(world.runtimeEvents.some((e) => e.type === "killed" && e.data.victim === victim)).toBe(true);

    // 死亡目标跳过
    const dead = spawnTestEntity(world, { hp: 5 });
    Health.current[dead] = 0;
    expect(getEffect("damage")!(makeCtx(world, { targets: [dead], params: { amount: 1 } }))).toBe(false);
  });

  it("heal：恢复不越上限；死亡目标跳过", () => {
    const world = createBareWorld();
    const target = spawnTestEntity(world, { hp: 10 });
    Health.current[target] = 4;
    expect(getEffect("heal")!(makeCtx(world, { targets: [target], params: { amount: 3 } }))).toBe(true);
    expect(Health.current[target]).toBe(7);

    getEffect("heal")!(makeCtx(world, { targets: [target], params: { amount: 100 } }));
    expect(Health.current[target]).toBe(10);

    const dead = spawnTestEntity(world, { hp: 5 });
    Health.current[dead] = 0;
    expect(getEffect("heal")!(makeCtx(world, { targets: [dead], params: { amount: 3 } }))).toBe(false);
  });

  it("apply-status：向目标 Modifiers 追加条目（含失效 tick）", () => {
    const world = createBareWorld();
    world.time.tick = 10;
    const target = spawnTestEntity(world);
    const ok = getEffect("apply-status")!(makeCtx(world, {
      targets: [target],
      params: { stat: "moveSpeed", mul: 0.5, durationTicks: 5, source: "test" },
    }));
    expect(ok).toBe(true);
    const entries = Modifiers[target]!["moveSpeed"];
    expect(entries.length).toBe(1);
    expect(entries[0].mul).toBe(0.5);
    expect(entries[0].expiresTick).toBe(15);
    expect(entries[0].source).toBe("test");
  });

  it("impulse：瞬时位移目标", () => {
    const world = createBareWorld();
    const target = spawnTestEntity(world, { x: 10, y: 20 });
    expect(getEffect("impulse")!(makeCtx(world, { targets: [target], params: { dx: 5, dy: -3 } }))).toBe(true);
    expect(Transform.x[target]).toBe(15);
    expect(Transform.y[target]).toBe(17);
  });

  it("ledger：credit 入账（自动建账）；debit 余额不足整体 false", () => {
    const world = createBareWorld();
    const a = spawnTestEntity(world);
    const b = spawnTestEntity(world);

    expect(getEffect("ledger")!(makeCtx(world, { targets: [a], params: { op: "credit", kind: "c1", count: 7 } }))).toBe(true);
    expect(Ledger[a]).toEqual({ c1: 7 });

    expect(getEffect("ledger")!(makeCtx(world, { targets: [a, b], params: { op: "debit", kind: "c1", count: 3 } }))).toBe(false);
    // a 扣成功、b 无账本失败——按目标独立结算，效果整体 false
    expect(Ledger[a]).toEqual({ c1: 4 });
    expect(Ledger[b]).toBeUndefined();
  });

  it("spawn-entity：按原型召唤；未知原型拒绝", () => {
    const world = createBareWorld();
    if (!world.archetypes.has("test-summon")) {
      world.archetypes.register({ kind: "test-summon", components: {}, tags: [] });
    }
    const source = spawnTestEntity(world, { x: 100, y: 200 });
    const ok = getEffect("spawn-entity")!(makeCtx(world, {
      source,
      params: { archetype: "test-summon", count: 2, offsetX: 5, offsetY: 5 },
    }));
    expect(ok).toBe(true);

    // 召唤出的实体带 NetworkId + Kind，位置按偏移
    const summoned = query(world, [NetworkId]).filter((eid) => {
      const x = Transform.x[eid];
      const y = Transform.y[eid];
      return eid !== source && x === 105 && y === 205;
    });
    expect(summoned.length).toBe(2);

    expect(getEffect("spawn-entity")!(makeCtx(world, { source, params: { archetype: "no-such" } }))).toBe(false);
  });

  it("spawn-projectile：生成带 Projectile 组件的实体于作用位置", () => {
    const world = createBareWorld();
    const source = spawnTestEntity(world, { x: 3, y: 4 });
    const ok = getEffect("spawn-projectile")!(makeCtx(world, {
      source,
      params: { vx: 100, vy: 0, lifeMs: 500, radius: 6 },
    }));
    expect(ok).toBe(true);

    const projectile = query(world, [Projectile])[0];
    expect(projectile).toBeDefined();
    expect(Projectile.owner[projectile]).toBe(source);
    expect(Transform.x[projectile]).toBe(3);
    expect(Projectile.lifeMs[projectile]).toBe(500);
  });
});

// 投射物系统
describe("projectileSystem", () => {
  /** 构造带测试地图的世界（默认全可走；blocked 回调刻画阻挡）。 */
  function createProjectileWorld(blocked?: (tx: number, ty: number) => boolean): GameWorld {
    const world = createBareWorld();
    world.maps["proj-map"] = makeTestGeometry({ key: "proj-map", blocked });
    world.defaultMapId = "proj-map";
    return world;
  }

  /** 生成投射物实体。 */
  function spawnProjectileEntity(world: GameWorld, x: number, y: number, vx: number, vy: number, lifeMs = 5000): number {
    const eid = addEntity(world);
    addComponent(world, eid, Transform);
    addComponent(world, eid, NetworkId);
    addComponent(world, eid, Projectile);
    Transform.x[eid] = x;
    Transform.y[eid] = y;
    Projectile.owner[eid] = eid;
    Projectile.vx[eid] = vx;
    Projectile.vy[eid] = vy;
    Projectile.lifeMs[eid] = lifeMs;
    Projectile.radius[eid] = 4;
    NetworkId.value[eid] = world.nextNetworkId++;
    EntityMap[eid] = world.defaultMapId;
    return eid;
  }

  it("直线运动：按速度 × dt 位移", () => {
    const world = createProjectileWorld();
    world.time.dtMs = 100;
    const p = spawnProjectileEntity(world, 100, 100, 50, 25);

    projectileSystem(world);
    expect(Transform.x[p]).toBeCloseTo(105); // 50 px/s × 0.1 s
    expect(Transform.y[p]).toBeCloseTo(102.5);
    expect(Projectile.lifeMs[p]).toBe(4900);
  });

  it("墙阻挡：目标格不可走 → 销毁", () => {
    // tileWidth=16：(112, 100) 落在第 7 列——标记为阻挡
    const world = createProjectileWorld((tx) => tx === 7);
    world.time.dtMs = 100;
    const p = spawnProjectileEntity(world, 100, 100, 120, 0); // 0.1s 后 x=112 → 第 7 列

    projectileSystem(world);
    expect(hasComponent(world, p, Projectile)).toBe(false); // 已销毁
  });

  it("接触判定：命中邻近实体 → 发 on-contact 事件并销毁；主人被跳过", () => {
    const world = createProjectileWorld();
    world.time.dtMs = 100;
    // 主人恰在投射物落点（x=50）——应被跳过不命中；victim 在半径内（58 距 50 = 8）
    const owner = spawnTestEntity(world, { x: 50, y: 0 });
    const victim = spawnTestEntity(world, { x: 58, y: 0 });
    const p = spawnProjectileEntity(world, 30, 0, 200, 0);
    Projectile.owner[p] = owner;

    projectileSystem(world);

    // 移动后 x=50：主人位置跳过；victim 距离 8 <= radius 4 + 垫片 4 → 命中销毁
    const events = drainEvents(world);
    const contacts = events.filter((e) => e.name === "on-contact");
    expect(contacts.length).toBe(1);
    expect((contacts[0].payload as { eid: number }).eid).toBe(owner);
    expect((contacts[0].payload as { target: number }).target).toBe(victim);
    expect(hasComponent(world, p, Projectile)).toBe(false);
  });

  it("寿命归零销毁", () => {
    const world = createProjectileWorld();
    world.time.dtMs = 100;
    const p = spawnProjectileEntity(world, 0, 0, 0, 0, 50);
    projectileSystem(world);
    expect(hasComponent(world, p, Projectile)).toBe(false);
  });
});
