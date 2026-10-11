/**
 * 切片 A1：确定性随机服务 + Math.random 收口 + on-death/on-hit 事件生产方。
 *
 * 覆盖：
 * - 统一随机服务（framework/simulation/rng）：attemptSeed 与历史算法逐位一致、
 *   attemptRng 等价 createRng(attemptSeed)、rngFrom 同输入恒同序列；
 * - deathSystem loot 掷骰 / wander 换向 / spawnDroppedItem 散布位置：同 tick
 *   同世界状态重复运行结果完全一致（确定性断言）；
 * - deathSystem 入队 on-death、combatSystem(attackTarget) 入队 on-hit，载荷正确。
 */
import { describe, it, expect, beforeAll } from "vitest";
import { addComponent, addEntity, query } from "bitecs";
import {
  bootstrapFramework,
  createActionRegistry,
  createGameInstance,
  createDefaultGameDefinition,
  drainEvents,
} from "framework/index";
import { createBehaviourTree } from "framework/ai/btFactory";
import { stepBehaviourTree } from "framework/ai/btRunner";
import { createRng } from "framework/map/generate/rng";
import { attemptSeed, attemptRng, rngFrom } from "framework/simulation/rng";
import { pickSpawnPosition } from "map/runtime/spawn";
import { registerBuiltinActions } from "framework/ai/registerBuiltinActions";
import { createBlackboard } from "framework/ai/blackboard";
import { Transform } from "framework/components/transform";
import { Velocity } from "framework/components/physics";
import { Health, Attack, Team } from "framework/components/combat";
import { NetworkId } from "framework/components/network";
import { Player, Enemy, NPC, Item } from "framework/components/tags";
import { LootTable } from "framework/components/loot";
import { ItemMeta } from "framework/components/itemMeta";
import { EntityMap } from "framework/components/entityMap";
import { setEntityKind } from "framework/systems/gameplay/aiSystem";
import { deathSystem } from "framework/systems/gameplay/deathSystem";
import { attackTarget } from "framework/systems/gameplay/combatSystem";
import { dropSlot, spawnDroppedItem } from "framework/systems/gameplay/inventoryOps";
import { Inventory } from "framework/components/inventory";
import { makeTestGeometry } from "./helpers/mapGeometry";
import { State } from "mistreevous";
import type { GameWorld } from "framework/world";

beforeAll(() => {
  bootstrapFramework();
});

function createBareWorld(): GameWorld {
  return createGameInstance(createDefaultGameDefinition()).world;
}

/** 挂一张 16×16 全可走测试图（游荡 / 掉落需要图）。 */
function attachMap(world: GameWorld, key = "dr-map"): void {
  world.maps[key] = makeTestGeometry({ key, width: 16, height: 16 });
  world.activeMaps.add(key);
  world.defaultMapId = key;
}

/** 手工 spawn 敌实体（NPC+Enemy+Health+Team + 归属）。 */
function spawnEnemy(world: GameWorld, opts: { x?: number; y?: number; hp?: number } = {}): number {
  const eid = addEntity(world);
  addComponent(world, eid, Transform);
  addComponent(world, eid, NetworkId);
  addComponent(world, eid, NPC);
  addComponent(world, eid, Enemy);
  addComponent(world, eid, Health);
  addComponent(world, eid, Team);
  Transform.x[eid] = opts.x ?? 0;
  Transform.y[eid] = opts.y ?? 0;
  Health.current[eid] = opts.hp ?? 30;
  Health.max[eid] = opts.hp ?? 30;
  Team.id[eid] = 2;
  NetworkId.value[eid] = world.nextNetworkId++;
  EntityMap[eid] = world.defaultMapId;
  setEntityKind(world, eid, "dr-enemy");
  return eid;
}

/** 手工 spawn 攻击者（带 Attack，Team 1）。 */
function spawnAttacker(world: GameWorld, value = 10, range = 32): number {
  const eid = addEntity(world);
  addComponent(world, eid, Transform);
  addComponent(world, eid, NetworkId);
  addComponent(world, eid, Player);
  addComponent(world, eid, Health);
  addComponent(world, eid, Attack);
  addComponent(world, eid, Team);
  Transform.x[eid] = 0;
  Transform.y[eid] = 0;
  Health.current[eid] = 100;
  Health.max[eid] = 100;
  Attack.value[eid] = value;
  Attack.range[eid] = range;
  Team.id[eid] = 1;
  NetworkId.value[eid] = world.nextNetworkId++;
  EntityMap[eid] = world.defaultMapId;
  setEntityKind(world, eid, "dr-attacker");
  return eid;
}

// ─── 统一随机服务 ─────────────────────────────────────────────────────────

describe("framework/simulation/rng：确定性随机服务", () => {
  it("attemptSeed 与历史算法逐位一致（nest/raid 落点正交依赖）", () => {
    for (const [t, e, s, a] of [
      [0, 0, 0, 0],
      [5, 7, 0, 3],
      [123456, 42, 2, 31],
    ] as const) {
      const expected =
        (Math.imul(t, 2654435761) ^
          Math.imul(e, 40503) ^
          Math.imul(s, 7919) ^
          Math.imul(a, 97)) >>>
        0;
      expect(attemptSeed(t, e, s, a)).toBe(expected);
    }
  });

  it("attemptRng ≡ createRng(attemptSeed)：同输入恒同序列", () => {
    const a = attemptRng(9, 3, 1, 2);
    const b = createRng(attemptSeed(9, 3, 1, 2));
    for (let i = 0; i < 8; i++) expect(a.next()).toBe(b.next());
  });

  it("rngFrom：同分量同序列；分量顺序/取值不同则序列不同", () => {
    const draw = (label: string) => Array.from({ length: 5 }, () => rngFrom(7, 42, "loot").next());
    expect(draw("a")).toEqual(draw("b"));
    const other = Array.from({ length: 5 }, () => rngFrom(7, 43, "loot").next());
    expect(other).not.toEqual(draw("a"));
  });
});

// ─── loot 掷骰确定性 ──────────────────────────────────────────────────────

describe("deathSystem loot 掷骰：同 tick 同世界状态重复运行完全一致", () => {
  /** 一次完整运行：全 0.5 命中率的四条掉落，返回 (kind, x, y) 排序结果。 */
  function runOnce() {
    const world = createBareWorld();
    attachMap(world);
    const eid = spawnEnemy(world, { x: 64, y: 64, hp: 0 });
    LootTable[eid] = [
      { kind: "k1", qty: 1, chance: 0.5 },
      { kind: "k2", qty: 2, chance: 0.5 },
      { kind: "k3", qty: 1, chance: 0.5 },
      { kind: "k4", qty: 1, chance: 0.5 },
    ];
    world.time.tick = 17;
    deathSystem(world);
    return {
      eid,
      drops: [...query(world, [Item])]
        .map((item) => ({
          kind: ItemMeta[item]!.kind,
          x: Transform.x[item],
          y: Transform.y[item],
        }))
        .sort((a, b) => a.kind.localeCompare(b.kind) || a.x - b.x || a.y - b.y),
    };
  }

  it("两次独立运行的掉落集合（种类/数量/落点）完全一致", () => {
    const first = runOnce();
    const second = runOnce();
    expect(first.eid).toBe(second.eid); // 同构造序 → 同 eid（种子含 eid）
    expect(first.drops.length).toBeGreaterThan(0); // 0.5 × 4 至少命中一条
    expect(first.drops).toEqual(second.drops);
  });
});

// ─── 掉落散布确定性 ──────────────────────────────────────────────────────

describe("spawnDroppedItem 散布：同来源同 tick 位置确定", () => {
  function dropOnce(): { x: number; y: number } {
    const world = createBareWorld();
    attachMap(world);
    world.time.tick = 33;
    const eid = spawnDroppedItem(world, { kind: "k1", count: 1 }, 100, 100, 0, world.defaultMapId, 42);
    return { x: Transform.x[eid], y: Transform.y[eid] };
  }

  it("不同世界同 (tick, 来源 eid) → 同落点；且落在 16~24px 环带内", () => {
    const a = dropOnce();
    const b = dropOnce();
    expect(a).toEqual(b);
    const dist = Math.hypot(a.x - 100, a.y - 100);
    expect(dist).toBeGreaterThanOrEqual(16);
    expect(dist).toBeLessThanOrEqual(24 + 1e-9);
  });

  it("dropSlot 同样确定性（走来源 eid 派生流）", () => {
    const run = () => {
      const world = createBareWorld();
      attachMap(world);
      world.time.tick = 5;
      const owner = spawnAttacker(world);
      Transform.x[owner] = 100;
      Transform.y[owner] = 100;
      Inventory[owner] = { capacity: 1, slots: [{ kind: "k1", count: 1 }] };
      dropSlot(world, owner, 0);
      const item = query(world, [Item])[0];
      return { x: Transform.x[item], y: Transform.y[item] };
    };
    expect(run()).toEqual(run());
  });
});

// ─── 游荡方向确定性 ──────────────────────────────────────────────────────

describe("wander：同 (tick, eid) 恒产生同方向", () => {
  function wanderOnce() {
    const world = createBareWorld();
    attachMap(world);
    const self = spawnEnemy(world, { x: 128, y: 128 });
    world.time.tick = 7;
    const registry = createActionRegistry();
    registerBuiltinActions(registry);
    const inst = createBehaviourTree(
      { type: "root", child: { type: "action", call: "Wander", args: { speed: 40 } } },
      registry,
    );
    const bb = createBlackboard(self);
    stepBehaviourTree(inst, { world, self, bb });
    return { self, vx: Velocity.vx[self], vy: Velocity.vy[self], state: inst.tree.getState() };
  }

  it("两次运行的换向方向向量完全一致、且非零（确实在移动）", () => {
    const first = wanderOnce();
    const second = wanderOnce();
    expect(first.self).toBe(second.self);
    expect(first.vx).toBe(second.vx);
    expect(first.vy).toBe(second.vy);
    expect(Math.hypot(first.vx, first.vy)).toBeGreaterThan(0);
    expect(first.state).toBe(State.RUNNING);
  });
});

// ─── 事件生产方接线 ──────────────────────────────────────────────────────

describe("事件生产方：on-death / on-hit 入队且载荷正确", () => {
  it("deathSystem 发 on-death { eid, kind }（非玩家实体）", () => {
    const world = createBareWorld();
    attachMap(world);
    const eid = spawnEnemy(world, { hp: 0 });
    deathSystem(world);

    const events = drainEvents(world).filter((e) => e.name === "on-death");
    expect(events.length).toBe(1);
    expect(events[0].payload).toEqual({ eid, kind: "dr-enemy" });
    // 队列被 drain 清空
    expect(drainEvents(world)).toEqual([]);
  });

  it("玩家死亡也发 on-death，且重生窗口内只发一次", () => {
    const world = createBareWorld();
    attachMap(world);
    world.gameDef.resolvedRules["respawn"] = { delayMs: 1000 };
    const eid = spawnAttacker(world);
    Health.current[eid] = 0;

    deathSystem(world);
    deathSystem(world);
    const events = drainEvents(world).filter((e) => e.name === "on-death");
    expect(events.length).toBe(1);
    expect(events[0].payload).toEqual({ eid, kind: "dr-attacker" });
  });

  it("attackTarget 命中发 on-hit { eid, attacker, target, damage }", () => {
    const world = createBareWorld();
    attachMap(world);
    const attacker = spawnAttacker(world, 10, 32);
    const target = spawnEnemy(world, { x: 10, y: 0, hp: 30 });

    expect(attackTarget(world, attacker, target)).toBe(true);
    expect(Health.current[target]).toBe(20); // 30 - max(1, 10-0)

    const hits = drainEvents(world).filter((e) => e.name === "on-hit");
    expect(hits.length).toBe(1);
    expect(hits[0].payload).toEqual({
      eid: attacker,
      attacker,
      target,
      damage: 10,
    });
  });

  it("未命中（超射程）不发 on-hit", () => {
    const world = createBareWorld();
    attachMap(world);
    const attacker = spawnAttacker(world, 10, 32);
    const far = spawnEnemy(world, { x: 500, y: 0, hp: 30 });

    expect(attackTarget(world, attacker, far)).toBe(false);
    expect(drainEvents(world).filter((e) => e.name === "on-hit")).toHaveLength(0);
  });
});

// ─── 出生点确定性（random 模式收口） ─────────────────────────────────────

describe("spawn pickSpawnPosition：random 模式确定性（不再用 Math.random）", () => {
  it("同种子同图恒选同点；异种子（玩家标识）选点可不同", () => {
    const geometry = makeTestGeometry({ key: "sp-map", width: 16, height: 16 });
    const rule = { mode: "random" as const };

    const a1 = pickSpawnPosition(geometry, rule, 12345);
    const a2 = pickSpawnPosition(geometry, rule, 12345);
    expect(a1).toEqual(a2); // 同种子恒同点

    // 多玩家各自种子 → 至少出现两个不同落点（保留每玩家分散的可观察行为）
    const picks = new Set(
      [1, 2, 3, 4, 5, 6, 7, 8].map((n) => {
        const p = pickSpawnPosition(geometry, rule, n * 99991)!;
        return `${p.x},${p.y}`;
      }),
    );
    expect(picks.size).toBeGreaterThan(1);
  });
});
