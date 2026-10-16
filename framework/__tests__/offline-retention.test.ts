/**
 * 玩法切片 B2 测试：断线保留 + 离线排除。
 *
 * 覆盖：
 * ① 断线后实体保留且对在线玩家不可见（快照/兴趣）、不被感知选为目标、需求冻结；
 * ② 保留期内重连复用同一实体（NetworkId 不变、背包还在、重新可见）；
 * ③ 保留到期销毁且触发一次立即存档（memoryRepository 断言）；
 * ④ retentionTicks=0 维持旧行为（立即销毁）；缺省配置 = 5 分钟保留；
 * ⑤ 死亡守卫与保留期互不干扰（死亡玩家重连后既有拒绝语义仍生效）；
 * ⑥ 袭击（raid）不以保留期玩家为刷波中心；
 * ⑦ 保留实体不被投射物接触命中。
 */
import { describe, it, expect, beforeAll } from "vitest";
import { addComponent, addEntity, query, removeComponent } from "bitecs";
import {
  bootstrapFramework,
  createGameSimulation,
  createGameInstance,
  createDefaultGameDefinition,
} from "framework/index";
import type { SimulationPort } from "simulation";
import type { GameWorld } from "framework/world";
import { Transform } from "framework/components/transform";
import { Velocity } from "framework/components/physics";
import { Health, Team } from "framework/components/combat";
import { NetworkId } from "framework/components/network";
import { Player, NPC } from "framework/components/tags";
import { Perception } from "framework/components/perception";
import { Needs } from "framework/components/needs";
import { Inventory } from "framework/components/inventory";
import { Offline, isOfflineRetained } from "framework/components/offline";
import { Projectile } from "framework/components/projectile";
import { EntityMap } from "framework/components/entityMap";
import { getOrCreateBlackboard, setEntityKind } from "framework/systems/gameplay/aiSystem";
import { BB_PERCEPTION_TARGET } from "framework/ai/blackboard";
import { raidSystem } from "framework/systems/gameplay/raidSystem";
import { projectileSystem } from "framework/systems/gameplay/projectileSystem";
import { memoryRepository } from "./helpers/persistence";
import { makeTestGeometry } from "./helpers/mapGeometry";

beforeAll(() => {
  // 全局引导一次：注册表是幂等单例，所有用例共享同一套内置实现
  bootstrapFramework();
});

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function simWorld(sim: SimulationPort): GameWorld {
  return (sim as unknown as { world: GameWorld }).world;
}

function eidByNetworkId(world: GameWorld, networkId: number): number | undefined {
  return [...query(world, [NetworkId])].find((eid) => NetworkId.value[eid] === networkId);
}

/** 手工 spawn 感知用 NPC：Transform+NetworkId+NPC+Perception+Team(2)+Health。 */
function spawnPerceptionNpc(world: GameWorld, opts: { x?: number; y?: number } = {}): number {
  const eid = addEntity(world);
  addComponent(world, eid, Transform);
  addComponent(world, eid, NetworkId);
  addComponent(world, eid, NPC);
  addComponent(world, eid, Perception);
  addComponent(world, eid, Team);
  addComponent(world, eid, Health);
  Perception.visionRadius[eid] = 500;
  Team.id[eid] = 2;
  Transform.x[eid] = opts.x ?? 32;
  Transform.y[eid] = opts.y ?? 0;
  Health.current[eid] = 50;
  Health.max[eid] = 50;
  NetworkId.value[eid] = world.nextNetworkId++;
  EntityMap[eid] = "";
  setEntityKind(world, eid, "npc");
  return eid;
}

// ─── ① 保留 + 排除语义（快照/兴趣/感知/需求） ─────────────────────────────

describe("断线保留：保留期排除语义", () => {
  it("断线后实体保留：对在线玩家不可见（快照+兴趣）、不被感知选为目标、需求冻结", async () => {
    const def = createDefaultGameDefinition();
    def.systems!.push({ id: "needDecay" }, { id: "perception" });
    def.resolvedRules["server"] = { offlineRetentionTicks: 100 };
    const sim = await createGameSimulation(def);
    const world = simWorld(sim);

    const nid1 = sim.addPlayer("s1").networkId;
    const nid2 = sim.addPlayer("s2").networkId;
    const p1 = eidByNetworkId(world, nid1)!;
    const p2 = eidByNetworkId(world, nid2)!;
    const npc = spawnPerceptionNpc(world, { x: 32, y: 0 });
    // 内建 player 原型无 Needs（Team 已随原型 team=1 挂载）——手工挂一条会衰减的需求
    Needs[p1] = [{ name: "n1", current: 80, max: 100, decayPerSec: 1, depletionDmg: 0 }];

    // 在线基线：可见、被感知、需求在衰减
    const online = sim.tick(50);
    expect(online.snapshot.entities.has(nid1)).toBe(true);
    expect(online.interest!.get("s2")).toContain(nid1);
    const targetOnline = getOrCreateBlackboard(world, npc).data.get(BB_PERCEPTION_TARGET) as
      | { eid: number }
      | null
      | undefined;
    expect(targetOnline?.eid).toBe(p1);
    const needWhileOnline = Needs[p1]![0]!.current;
    expect(needWhileOnline).toBeLessThan(80); // 对照组：在线时确实在衰减

    // 断线：实体保留 + 挂标记
    sim.removePlayer("s1");
    expect(eidByNetworkId(world, nid1)).toBe(p1); // 实体还在
    expect(isOfflineRetained(world, p1)).toBe(true);

    // 保留期：不可见、不被感知、需求冻结
    sim.tick(50);
    const retained = sim.tick(50);
    expect(retained.snapshot.entities.has(nid1)).toBe(false);
    expect(retained.interest!.get("s2")).not.toContain(nid1);
    expect(retained.interest!.get("s2")).toContain(nid2); // 在线玩家不受影响
    const targetAfter = getOrCreateBlackboard(world, npc).data.get(BB_PERCEPTION_TARGET) as
      | { eid: number }
      | null
      | undefined;
    expect(targetAfter?.eid).not.toBe(p1); // 保留实体不再是感知目标
    expect(targetAfter?.eid).toBe(p2); // 感知正常换目标到在线玩家（排除而非世界失明）
    expect(Needs[p1]![0]!.current).toBe(needWhileOnline); // 冻结：不再衰减

    sim.removePlayer("s2");
  });

  it("保留期重连：复用同一实体（NetworkId 不变、背包还在、重新可见）；提示键未命中则降级常规加入", async () => {
    const def = createDefaultGameDefinition();
    def.resolvedRules["server"] = { offlineRetentionTicks: 100 };
    const sim = await createGameSimulation(def);
    const world = simWorld(sim);

    const nid = sim.addPlayer("s1").networkId;
    const p = eidByNetworkId(world, nid)!;
    Inventory[p] = { capacity: 2, slots: [{ kind: "k1", count: 7 }, null] };
    sim.tick(50);

    sim.removePlayer("s1");
    expect(isOfflineRetained(world, p)).toBe(true);

    // 新 session 重连（客户端自报断线前 networkId）→ 复用同一实体
    const join = sim.addPlayer("s2", { networkId: nid });
    expect(join.networkId).toBe(nid);
    expect(eidByNetworkId(world, nid)).toBe(p);
    expect(isOfflineRetained(world, p)).toBe(false); // 标记已清除
    expect(Inventory[p]!.slots[0]).toEqual({ kind: "k1", count: 7 }); // 背包原样

    const after = sim.tick(50);
    expect(after.snapshot.entities.has(nid)).toBe(true); // 重新进入快照
    expect(after.interest!.get("s2")).toContain(nid); // 自己恒可见

    // 提示键未命中（如已到期销毁）：降级常规路径新生成，既有实体不受影响
    const before = [...query(world, [NetworkId])].length;
    const miss = sim.addPlayer("s3", { networkId: 999999 });
    expect(miss.networkId).not.toBe(nid);
    expect([...query(world, [NetworkId])].length).toBe(before + 1);

    sim.removePlayer("s2");
    sim.removePlayer("s3");
  });
});

// ─── ③ 到期销毁 + 立即存档 ───────────────────────────────────────────────

describe("断线保留：到期清扫与立即存档", () => {
  it("到期销毁实体并触发一次立即存档（saveNow 绕过 saveIntervalMs 门控）", async () => {
    const def = createDefaultGameDefinition();
    // saveIntervalMs 拉到不可达：存档 tick 变化只能来自到期清扫的 saveNow
    def.resolvedRules["server"] = { saveId: "s1", saveIntervalMs: 1e9, offlineRetentionTicks: 3 };
    const repo = memoryRepository(null);
    const sim = await createGameSimulation(def, { repository: repo, saveId: "s1" });
    const world = simWorld(sim);

    const nid = sim.addPlayer("s1").networkId;
    await sleep(20); // 开机首存落盘（boot 路径，fire-and-forget）
    const bootTick = (await repo.loadWorld("s1"))!.tick;

    sim.removePlayer("s1"); // 此刻 tick=0 → untilTick=3
    expect(isOfflineRetained(world, eidByNetworkId(world, nid)!)).toBe(true);

    sim.tick(50); // tick=1，未到期
    sim.tick(50); // tick=2，未到期
    expect(eidByNetworkId(world, nid)).toBeDefined();

    sim.tick(50); // tick=3 → untilTick ≤ tick，清扫销毁 + 立即存档
    expect(eidByNetworkId(world, nid)).toBeUndefined();
    expect([...query(world, [NetworkId])].some((e) => NetworkId.value[e] === nid)).toBe(false);

    const record = await repo.loadWorld("s1");
    expect(record).not.toBeNull();
    expect(record!.tick).toBe(3); // 存档被触发（boot 那份 tick 更早）
    expect(record!.tick).toBeGreaterThan(bootTick);
    expect(record!.entities.some((e) => e.networkId === nid)).toBe(false); // 销毁后的最后状态
  });
});

// ─── ④ retentionTicks=0 旧行为 / 缺省 5 分钟 ────────────────────────────

describe("断线保留：配置语义", () => {
  it("offlineRetentionTicks=0：断线立即销毁（旧行为），不产生保留标记", async () => {
    const def = createDefaultGameDefinition();
    def.resolvedRules["server"] = { offlineRetentionTicks: 0 };
    const sim = await createGameSimulation(def);
    const world = simWorld(sim);

    const nid = sim.addPlayer("s1").networkId;
    const p = eidByNetworkId(world, nid)!;
    sim.removePlayer("s1");
    expect(eidByNetworkId(world, nid)).toBeUndefined(); // 立即销毁
    expect(isOfflineRetained(world, p)).toBe(false);
  });

  it("未配置 offlineRetentionTicks：缺省保留（5 分钟对应 tick），到期前不销毁", async () => {
    const def = createDefaultGameDefinition();
    const sim = await createGameSimulation(def);
    const world = simWorld(sim);

    const nid = sim.addPlayer("s1").networkId;
    const p = eidByNetworkId(world, nid)!;
    sim.removePlayer("s1");
    expect(isOfflineRetained(world, p)).toBe(true); // 缺省保留而非立即销毁
    for (let i = 0; i < 5; i++) sim.tick(50);
    expect(eidByNetworkId(world, nid)).toBe(p); // 远未到缺省 6000 tick，仍保留
  });
});

// ─── ⑤ 死亡守卫 × 保留期互不干扰 ─────────────────────────────────────────

describe("断线保留：与死亡守卫互不干扰", () => {
  it("死亡玩家断线保留→重连复用后，死亡守卫的既有拒绝语义仍生效", async () => {
    const def = createDefaultGameDefinition();
    def.resolvedRules["server"] = { offlineRetentionTicks: 100 };
    const sim = await createGameSimulation(def);
    const world = simWorld(sim);

    const nid = sim.addPlayer("s1").networkId;
    const p = eidByNetworkId(world, nid)!;
    Health.current[p] = 0; // 死亡（respawn 窗口语义归 deathSystem 侧，本切片不触及）

    sim.removePlayer("s1"); // 死亡玩家断线同样走保留
    expect(isOfflineRetained(world, p)).toBe(true);
    expect(eidByNetworkId(world, nid)).toBe(p);

    // 保留期（死亡 + 保留）：不可见（保留期门控独立于死亡守卫生效）
    const offlineTick = sim.tick(50);
    expect(offlineTick.snapshot.entities.has(nid)).toBe(false);

    const join = sim.addPlayer("s2", { networkId: nid });
    expect(join.networkId).toBe(nid); // 复用保留实体

    // 死亡守卫：命令拒绝（背包含物品，只有死亡守卫会拒绝 consume）
    Inventory[p] = { capacity: 2, slots: [{ kind: "k1", count: 7 }, null] };
    expect(sim.submitCommand("s2", { type: "consume", slot: 0 })).toBe(false);
    expect(Inventory[p]!.slots[0]).toEqual({ kind: "k1", count: 7 }); // 未被消费

    // 死亡守卫：移动/意图输入被忽略（速度不写入）
    sim.submitInput("s2", { seq: 1, moveX: 1, moveY: 0, interact: true });
    const result = sim.tick(50);
    expect(Velocity.vx[p]).toBe(0);
    // 复用后恢复在线语义：重新可见（死亡守卫只挡输入/命令，不影响快照可见性）
    expect(result.snapshot.entities.has(nid)).toBe(true);
  });
});

// ─── ⑥/⑦ 系统侧排除：raid / projectile（直调系统，同 nest-raid 测试形态） ──

/** 给裸 world 挂一块 8×8 测试地图（128×128 像素，全可走，常驻激活）。 */
function attachTestMap(world: GameWorld, key = "test"): void {
  world.maps[key] = makeTestGeometry({ key, width: 8, height: 8 });
  world.activeMaps.add(key);
  world.defaultMapId = key;
}

/** 手工 spawn 测试玩家（Player+Transform+NetworkId + 归属 test 图）。 */
function spawnManualPlayer(world: GameWorld, x = 64, y = 64): number {
  const eid = addEntity(world);
  addComponent(world, eid, Transform);
  addComponent(world, eid, NetworkId);
  addComponent(world, eid, Player);
  NetworkId.value[eid] = world.nextNetworkId++;
  EntityMap[eid] = world.defaultMapId;
  Transform.x[eid] = x;
  Transform.y[eid] = y;
  return eid;
}

/** 手工实体写归属与 kind 的注册表取组件捷径（与 makeTest 专用原型解耦）。 */
function writeEntityMap(world: GameWorld, eid: number, mapId: string): void {
  EntityMap[eid] = mapId;
  setEntityKind(world, eid, "or-probe");
}

describe("断线保留：raid / projectile 排除", () => {
  it("⑥ raid 不以保留期玩家为中心刷波；恢复后正常刷波（对照组）", () => {
    const world = createGameInstance(createDefaultGameDefinition()).world;
    attachTestMap(world);
    if (!world.archetypes.has("or-worker")) {
      world.archetypes.register({
        kind: "or-worker",
        components: {
          Collider: { shape: 1, halfW: 8, halfH: 8 },
          Health: { current: 10, max: 10 },
        },
        team: 2,
      });
    }
    const p = spawnManualPlayer(world);
    world.gameDef.resolvedRules["raid"] = { intervalTicks: 1, waveSize: 2, kinds: ["or-worker"], radiusTiles: 2 };
    const countWave = () => [...query(world, [Transform])].filter((e) => e !== p).length;

    world.time.tick = 1;
    addComponent(world, p, Offline);
    Offline.untilTick[p] = world.time.tick + 100;
    raidSystem(world);
    expect(countWave()).toBe(0); // 保留期玩家不作为刷波中心

    removeComponent(world, p, Offline); // 对照：无标记 → 正常刷波
    raidSystem(world);
    expect(countWave()).toBe(2);
  });

  it("⑦ 保留期实体不被投射物接触命中（无 on-contact 事件、投射物不因此销毁）", () => {
    const world = createGameInstance(createDefaultGameDefinition()).world;
    attachTestMap(world);
    const p = spawnManualPlayer(world);
    addComponent(world, p, Offline);
    Offline.untilTick[p] = world.time.tick + 100;

    // 投射物恰好压在保留实体上（零速，寿命充足）
    const proj = addEntity(world);
    addComponent(world, proj, Transform);
    addComponent(world, proj, NetworkId);
    addComponent(world, proj, Projectile);
    Projectile.owner[proj] = p;
    Projectile.vx[proj] = 0;
    Projectile.vy[proj] = 0;
    Projectile.lifeMs[proj] = 1000;
    Projectile.radius[proj] = 8;
    NetworkId.value[proj] = world.nextNetworkId++;
    writeEntityMap(world, proj, world.defaultMapId);
    Transform.x[proj] = 64;
    Transform.y[proj] = 64;

    projectileSystem(world);
    expect(world.eventBus.queue).toHaveLength(0); // 无 on-contact 事件
    expect(eidByNetworkId(world, NetworkId.value[proj])).toBeDefined(); // 未被命中销毁
  });
});
