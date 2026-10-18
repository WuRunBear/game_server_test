/**
 * 完整性批次 B2 验收测试（audit 2026-10-18）。
 *
 * B2-a / F-04 单一时钟：
 * - timeOfDay 是 tick 纯函数：同 tick 恒等（与 dtMs/推进路径无关）；
 * - advanceTickTo 跨天/跨多天后 hour/phase 与直接按 tick 计算一致；
 * - 离线补差（构造期 advanceTickTo）后 timeOfDay 自动正确，isNight 与
 *   environmentAt 同源于 tick；
 * - 客户端快照 hour/phase 与派生值一致。
 *
 * B2-b / F-07 + F-32 死亡容器持久 TTL 与重启重复死亡：
 * - 死亡 → 存档 → 重启：容器仍在、剩余 TTL 正确；
 * - 跨过到期 tick 后由 timerSystem 销毁；
 * - 0 血玩家重启不重复掉落/不重复生成空容器（直接进入 respawn 流程）；
 * - ttlTicks=0 永不；旧档缺 Lifetime 字段不崩溃。
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest";
import { hasComponent, query } from "bitecs";
import {
  bootstrapFramework,
  createDefaultGameDefinition,
  createGameSimulation,
  serializeWorld,
  getSpawnCondition,
  environmentAt,
  phaseAt,
  Lifetime,
} from "framework/index";
import { advanceTickTo } from "framework/map/runtime/clock";
import { timeOfDayAt } from "framework/simulation/worldClock/dayNight";
import { timerSystem } from "framework/simulation/timer/timerSystem";
import { Health } from "framework/components/combat";
import { Inventory } from "framework/components/inventory";
import { NetworkId } from "framework/components/network";
import { LootTable } from "framework/components/loot";
import { Container, Item, Player } from "framework/components/tags";
import { Kind } from "framework/components/kind";
import { PHASE_DAY, PHASE_NIGHT, type GameWorld } from "framework/world";
import type { DayNightRule } from "framework/config/schema/RuleSchema";
import type { LoadedGameDefinition } from "framework/config/schema/GameDefinitionSchema";
import type { WorldRecord } from "framework/repository";
import type { SimulationPort } from "simulation";
import { memoryRepository } from "./helpers/persistence";

beforeAll(() => {
  bootstrapFramework();
});

afterEach(() => {
  vi.useRealTimers();
});

const TICK_RATE = 20;
const DT_MS = 1000 / TICK_RATE;
const DAY_TICKS = 600 * TICK_RATE; // cycleLengthSec 600 × 20tps

function simWorld(sim: SimulationPort): GameWorld {
  return (sim as unknown as { world: GameWorld }).world;
}

function playerEidOf(world: GameWorld): number {
  const [eid] = query(world, [Player]);
  return eid!;
}

function corpseEids(world: GameWorld): number[] {
  return [...query(world, [Container])];
}

/* ------------------------------------------------------------------ */
/* B2-a / F-04 单一时钟                                                 */
/* ------------------------------------------------------------------ */

const DAYNIGHT_RULE: DayNightRule = {
  cycleLengthSec: 600,
  nightStartHour: 19,
  nightEndHour: 5,
};

/** 带 daynight + environment 规则的最小配置（无地图/无实体生成成本）。 */
function clockDef(): LoadedGameDefinition {
  const def = createDefaultGameDefinition();
  def.systems = [{ id: "dayNight" }, { id: "environment" }];
  def.resolvedRules["daynight"] = { ...DAYNIGHT_RULE };
  def.resolvedRules["environment"] = {
    seed: 7,
    weatherSlotTicks: 100,
    phases: [
      { id: "alpha", durationTicks: 1000 },
      { id: "beta", durationTicks: 1000 },
    ],
  };
  return def;
}

describe("B2-a：timeOfDay 是 tick 纯函数（单一时钟）", () => {
  it("同 tick 的 hour/phase 恒等——与 dtMs 及推进路径无关", async () => {
    const def = clockDef();
    const sim = await createGameSimulation(def);
    const world = simWorld(sim);

    world.time.tick = 1234;
    world.time.dtMs = DT_MS;
    sim.tick(DT_MS); // 经真实 tick 推进路径（tick 1235）
    const viaTick = { ...world.time.timeOfDay };

    // 另一条路径：直接推进到同一 tick（无 dt 累积）
    const jumped = await createGameSimulation(def);
    const jumpedWorld = simWorld(jumped);
    advanceTickTo(jumpedWorld, world.time.tick);
    expect(jumpedWorld.time.timeOfDay).toEqual(viaTick);

    // 与纯函数直接求值一致
    expect(viaTick).toEqual(timeOfDayAt(world.time.tick, DAYNIGHT_RULE, TICK_RATE));
  });

  it("advanceTickTo 跨天/跨 N 天后 hour/phase 与直接按 tick 计算一致", async () => {
    const sim = await createGameSimulation(clockDef());
    const world = simWorld(sim);

    // 跨 3 天再多 5500 tick（8 时锚点 + 11 小时 = 19 时，入夜）
    const target = DAY_TICKS * 3 + 5500;
    advanceTickTo(world, target);

    expect(world.time.tick).toBe(target);
    const expected = timeOfDayAt(target, DAYNIGHT_RULE, TICK_RATE)!;
    expect(expected.hour).toBeCloseTo(19, 8);
    expect(world.time.timeOfDay).toEqual(expected);
    expect(world.time.timeOfDay.phase).toBe(PHASE_NIGHT);

    // 跨整 N 天后回到锚点小时（无累积漂移）
    advanceTickTo(world, DAY_TICKS * 10);
    expect(world.time.timeOfDay.hour).toBeCloseTo(8, 8);
    expect(world.time.timeOfDay.phase).toBe(PHASE_DAY);
  });

  it("离线补差后 timeOfDay 自动正确：isNight 与 environmentAt 同源于 tick", async () => {
    const def = clockDef();
    const sim1 = await createGameSimulation(def);
    const record = serializeWorld(simWorld(sim1), "clock");

    // 离线 2 天 + 5500 tick → 终点 19 时（夜晚）
    const offlineTicks = DAY_TICKS * 2 + 5500;
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(record.savedAt + offlineTicks * DT_MS);
    const sim2 = await createGameSimulation(def, {
      repository: memoryRepository(record),
      saveId: "clock",
    });
    vi.useRealTimers();

    const world2 = simWorld(sim2);
    expect(world2.time.tick).toBe(offlineTicks);
    const expected = timeOfDayAt(world2.time.tick, DAYNIGHT_RULE, TICK_RATE)!;
    expect(world2.time.timeOfDay).toEqual(expected);
    expect(expected.phase).toBe(PHASE_NIGHT);
    expect(getSpawnCondition("isNight")(world2)).toBe(true);
    expect(getSpawnCondition("isDay")(world2)).toBe(false);

    // environmentAt 同样是 tick 纯函数：与直接 phaseAt 一致（时间不会各走各的）
    const envRule = def.resolvedRules["environment"] as Parameters<typeof phaseAt>[1];
    expect(environmentAt(world2).phaseIndex).toBe(phaseAt(world2.time.tick, envRule).phaseIndex);
  });

  it("客户端快照 hour/phase 与 tick 派生一致（含 advance 跳跃后）", async () => {
    const sim = await createGameSimulation(clockDef());
    const world = simWorld(sim);

    const first = sim.tick(DT_MS);
    expect(first.snapshot.timeOfDay).toEqual(
      timeOfDayAt(world.time.tick, DAYNIGHT_RULE, TICK_RATE),
    );

    advanceTickTo(world, DAY_TICKS + 5500); // 19 时
    const second = sim.tick(DT_MS);
    expect(second.snapshot.timeOfDay).toEqual(
      timeOfDayAt(world.time.tick, DAYNIGHT_RULE, TICK_RATE),
    );
    expect(second.snapshot.timeOfDay!.phase).toBe(PHASE_NIGHT);
  });
});

/* ------------------------------------------------------------------ */
/* B2-b / F-07 + F-32 死亡容器持久 TTL + 重启重复死亡                    */
/* ------------------------------------------------------------------ */

const CORPSE_TTL_TICKS = 600;

function deathDef(ttlTicks = CORPSE_TTL_TICKS): LoadedGameDefinition {
  const def = createDefaultGameDefinition();
  def.systems = [{ id: "death" }, { id: "respawn" }, { id: "timer" }];
  def.resolvedItems = [
    { kind: "k1", maxStack: 20 },
  ];
  def.resolvedRules["respawn"] = {
    delayMs: 1000,
    deathContainer: { archetype: "corpse", ttlTicks },
  };
  return def;
}

function ensureCorpseArchetype(world: GameWorld): void {
  if (!world.archetypes.has("corpse")) {
    world.archetypes.register({
      kind: "corpse",
      tags: ["Container"],
      components: { Inventory: { capacity: 16 } },
    });
  }
}

interface DeathFixture {
  def: LoadedGameDefinition;
  sim: SimulationPort;
  world: GameWorld;
  player: number;
  corpse: number;
  record: WorldRecord;
}

/** 玩家在死亡窗口内被存档：背包已转入容器、LootTable 已掷一次、玩家仍 0 血。 */
async function saveWhileDead(ttlTicks = CORPSE_TTL_TICKS): Promise<DeathFixture> {
  const def = deathDef(ttlTicks);
  const sim = await createGameSimulation(def);
  const world = simWorld(sim);
  ensureCorpseArchetype(world);

  sim.addPlayer("s1");
  const player = playerEidOf(world);
  Inventory[player] = {
    capacity: 4,
    slots: [{ kind: "k1", count: 3 }, null, null, null],
  };
  // 玩家也有一条掉落表：若重启重复处理死亡，会多落地一份战利品
  LootTable[player] = [{ kind: "k1", qty: 1, chance: 1 }];

  world.time.tick = 100;
  Health.current[player] = 0;
  sim.tick(DT_MS); // tick 101：death 生成容器并转移背包

  const corpses = corpseEids(world);
  expect(corpses).toHaveLength(1);
  const corpse = corpses[0]!;
  expect(Inventory[corpse]!.slots[0]).toEqual({ kind: "k1", count: 3 });

  return { def, sim, world, player, corpse, record: serializeWorld(world, "death") };
}

/** 读档重建（savedAt 拨到未来 → 零离线补差，便于断言 tick/剩余 TTL）。 */
async function restore(fixture: DeathFixture, record: WorldRecord): Promise<SimulationPort> {
  const revived: WorldRecord = { ...record, savedAt: Date.now() + 3_600_000 };
  return createGameSimulation(fixture.def, {
    repository: memoryRepository(revived),
    saveId: "death",
  });
}

describe("B2-b：死亡容器持久 TTL（跨重启）", () => {
  beforeEach(() => {
    // AoS 槽位跨 world 共享：清掉战利品表残留，避免 eid 复用时串扰
    for (let i = 0; i < LootTable.length; i++) LootTable[i] = undefined;
  });

  it("死亡 → 存档 → 重启：容器仍在且剩余 TTL 正确", async () => {
    const fixture = await saveWhileDead();
    expect(fixture.record.tick).toBe(101);
    // 持久到期 tick 随实体入档（101 + 600 = 701）
    const savedCorpse = fixture.record.entities.find(
      (entity) => entity.kind === "corpse",
    )!;
    expect(savedCorpse.components["Lifetime"]).toEqual({ expiresTick: 701 });

    const sim2 = await restore(fixture, fixture.record);
    const world2 = simWorld(sim2);
    expect(world2.time.tick).toBe(101);

    const corpses = corpseEids(world2);
    expect(corpses).toHaveLength(1);
    const corpse2 = corpses[0]!;
    expect(Lifetime.expiresTick[corpse2]).toBe(701);
    expect(Lifetime.expiresTick[corpse2] - world2.time.tick).toBe(CORPSE_TTL_TICKS);
    expect(Inventory[corpse2]!.slots[0]).toEqual({ kind: "k1", count: 3 });
  });

  it("跨过到期 tick 后销毁：剩余时间内仍在、到期 tick 当帧清除", async () => {
    const fixture = await saveWhileDead();
    const sim2 = await restore(fixture, fixture.record);
    const world2 = simWorld(sim2);

    world2.time.tick = 700; // 剩余 1 tick
    timerSystem(world2);
    expect(corpseEids(world2)).toHaveLength(1);

    world2.time.tick = 701; // 到期
    timerSystem(world2);
    expect(corpseEids(world2)).toHaveLength(0);
  });

  it("ttlTicks = 0 → 永不销毁（不挂载 Lifetime）", async () => {
    const fixture = await saveWhileDead(0);
    const savedCorpse = fixture.record.entities.find((e) => e.kind === "corpse")!;
    expect(savedCorpse.components["Lifetime"]).toBeUndefined();

    const sim2 = await restore(fixture, fixture.record);
    const world2 = simWorld(sim2);
    const corpse2 = corpseEids(world2)[0]!;
    world2.time.tick = 10_000_000;
    timerSystem(world2);
    expect(corpseEids(world2)).toHaveLength(1);
    expect(Kind[corpse2]).toBe("corpse");
  });

  it("0 血玩家重启：不重复掉落、不重复生成空容器，直接进入 respawn 流程", async () => {
    const fixture = await saveWhileDead();
    const playerNetworkId = NetworkId.value[fixture.player];
    // 首次死亡已落地 1 份战利品
    expect(query(fixture.world, [Item])).toHaveLength(1);

    const sim2 = await restore(fixture, fixture.record);
    const world2 = simWorld(sim2);
    expect(query(world2, [Item])).toHaveLength(1); // 战利品随档恢复
    expect(corpseEids(world2)).toHaveLength(1);

    sim2.addPlayer("s2", { networkId: playerNetworkId });
    const player2 = playerEidOf(world2);
    expect(Health.current[player2]).toBe(0);

    sim2.tick(DT_MS); // tick 102：death 必须跳过，respawn 复活

    expect(Health.current[player2]).toBeGreaterThan(0);
    expect(corpseEids(world2)).toHaveLength(1); // 不生成第二个空容器
    expect(query(world2, [Item])).toHaveLength(1); // 不重复掉落
    const corpse2 = corpseEids(world2)[0]!;
    expect(Inventory[corpse2]!.slots[0]).toEqual({ kind: "k1", count: 3 }); // 原有容器内容未被再次清空
  });

  it("旧档缺 Lifetime 字段：不崩溃（容器按无期限恢复）", async () => {
    const fixture = await saveWhileDead();
    const legacy: WorldRecord = {
      ...fixture.record,
      savedAt: Date.now() + 3_600_000,
      entities: fixture.record.entities.map((entity) => {
        const components = { ...entity.components };
        delete components["Lifetime"];
        return { ...entity, components };
      }),
    };

    const sim2 = await createGameSimulation(fixture.def, {
      repository: memoryRepository(legacy),
      saveId: "death",
    });
    const world2 = simWorld(sim2);
    const corpse2 = corpseEids(world2)[0]!;
    // 未挂载（旧档无到期 tick）；SoA 数据槽可能残留旧 world 的值，按组件挂载判定
    expect(hasComponent(world2, corpse2, Lifetime)).toBe(false);
    world2.time.tick = 1_000_000;
    expect(() => timerSystem(world2)).not.toThrow();
    expect(corpseEids(world2)).toHaveLength(1); // 旧档容器无期限保留（不崩溃）
  });
});
