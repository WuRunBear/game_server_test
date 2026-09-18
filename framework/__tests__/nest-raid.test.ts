/**
 * 切片③动态机制测试：Nest 巢穴系统 / 周期袭击（raid 规则） / isDay 条件 / Nest 持久化。
 *
 * 覆盖：Nest AoS 初始化钩子（归一化 + fail-fast）、nestSystem 间隔门控 /
* 存活重数镜像 / 补足落位合法性（可走 + 足印不压实体/阻挡，确定性 rng →
 * 精确落点断言）/ 巢摧毁停产、raidSystem 规则驱动（无规则 no-op / 间隔门控 /
 * 按玩家分图刷波 / waveRef 规则模块接管 / condition 门控）、isDay 刷怪条件、
 * Nest 组件随世界快照序列化/恢复往返（slice5 同款）。
 */
import { makeTestGeometry } from "./helpers/mapGeometry";
import { describe, it, expect, beforeAll } from "vitest";
import { addComponent, addEntity, query } from "bitecs";
import {
  bootstrapFramework,
  createGameInstance,
  createDefaultGameDefinition,
  spawnEntity,
  getRegistries,
  getSpawnCondition,
  registerRuleModule,
  serializeWorld,
  restoreWorld,
  PHASE_DAY,
  PHASE_NIGHT,
} from "framework/index";
import { Transform } from "framework/components/transform";
import { Collider, ColliderShape } from "framework/components/physics";
import { Health } from "framework/components/combat";
import { NetworkId } from "framework/components/network";
import { Player } from "framework/components/tags";
import { Nest, initNest } from "framework/components/nest";
import { Kind } from "framework/components/kind";
import { EntityMap, entityMapOf } from "framework/components/entityMap";
import { destroyEntity } from "framework/entities/destroyEntity";
import { createNestSystem } from "framework/systems/gameplay/nestSystem";
import { raidSystem, type RaidWaveContext } from "framework/systems/gameplay/raidSystem";
import { setEntityKind } from "framework/systems/gameplay/aiSystem";
import type { GameWorld } from "framework/world";

beforeAll(() => {
  // 全局引导一次：注册表是幂等单例，所有用例共享同一套内置实现
  bootstrapFramework();
});

/** 构造一个最小世界（默认配置，无依赖具体 game 配置内容）。 */
function createBareWorld(): GameWorld {
  return createGameInstance(createDefaultGameDefinition()).world;
}

/** 注册测试原型（全局注册表单例，跨用例重复注册会抛错 → 已存在则跳过）。 */
function ensureArchetype(spec: Parameters<GameWorld["archetypes"]["register"]>[0]): void {
  const registries = getRegistries();
  if (!registries.archetypeRegistry.has(spec.kind)) {
    registries.archetypeRegistry.register(spec);
  }
}

/** 测试原型集：16px 产出物 / 24px（2×2）产出物 / 巢 / 阻挡桩。 */
function ensureTestArchetypes(): void {
  ensureArchetype({
    kind: "nr-worker",
    components: {
      Placeable: { footprintW: 16, footprintH: 16, canCollide: 1 },
      Collider: { shape: ColliderShape.Box, halfW: 8, halfH: 8 },
      Health: { current: 10, max: 10 },
    },
    team: 2,
  });
  ensureArchetype({
    kind: "nr-big",
    components: {
      Placeable: { footprintW: 24, footprintH: 24, canCollide: 1 },
      Collider: { shape: ColliderShape.Box, halfW: 12, halfH: 12 },
      Health: { current: 10, max: 10 },
    },
    team: 2,
  });
  ensureArchetype({
    kind: "nr-brute",
    components: {
      Collider: { shape: ColliderShape.Box, halfW: 8, halfH: 8 },
      Health: { current: 10, max: 10 },
    },
    team: 2,
  });
  ensureArchetype({
    kind: "nr-blocker",
    components: { Collider: { shape: ColliderShape.Box, halfW: 8, halfH: 8 } },
  });
  ensureArchetype({
    kind: "nr-blocker24",
    components: { Collider: { shape: ColliderShape.Box, halfW: 12, halfH: 12 } },
  });
  // 巢（带 16px 碰撞体：自身占格不可被产出物叠放）
  ensureArchetype({
    kind: "nr-nest",
    components: {
      Nest: { spawnKind: "nr-worker", capacity: 2, intervalTicks: 5 },
      Collider: { shape: ColliderShape.Box, halfW: 8, halfH: 8 },
    },
  });
  ensureArchetype({
    kind: "nr-nest-fast",
    components: {
      Nest: { spawnKind: "nr-worker", capacity: 2, intervalTicks: 1 },
      Collider: { shape: ColliderShape.Box, halfW: 8, halfH: 8 },
    },
  });
  ensureArchetype({
    kind: "nr-nest-c1",
    components: {
      Nest: { spawnKind: "nr-worker", capacity: 1, intervalTicks: 1 },
      Collider: { shape: ColliderShape.Box, halfW: 8, halfH: 8 },
    },
  });
  // 足印测试专用巢：无碰撞体（隔离 nest 占格因素，只验证 24px 足印合法性）
  ensureArchetype({
    kind: "nr-nest-big",
    components: { Nest: { spawnKind: "nr-big", capacity: 1, intervalTicks: 1 } },
  });
  ensureArchetype({
    kind: "nr-nest-missing",
    components: { Nest: { spawnKind: "nr-missing-kind", capacity: 3, intervalTicks: 1 } },
  });
}

/** 给裸 world 挂一块 8×8 测试地图（128×128 像素，缺省全可走，常驻激活）。 */
function attachTestMap(
  world: GameWorld,
  key = "test",
  opts: Parameters<typeof makeTestGeometry>[0] = {},
): void {
  world.maps[key] = makeTestGeometry({ key, width: 8, height: 8, ...opts });
  world.activeMaps.add(key);
  world.defaultMapId = key;
}

interface PlayerOpts { x?: number; y?: number; mapId?: string; }

/** 手工 spawn 测试玩家：Player/Health/Transform + EntityMap 归属。 */
function spawnTestPlayer(world: GameWorld, opts: PlayerOpts = {}): number {
  const eid = addEntity(world);
  addComponent(world, eid, Transform);
  addComponent(world, eid, NetworkId);
  addComponent(world, eid, Player);
  addComponent(world, eid, Health);
  Transform.x[eid] = opts.x ?? 64;
  Transform.y[eid] = opts.y ?? 64;
  Health.current[eid] = 100;
  Health.max[eid] = 100;
  NetworkId.value[eid] = world.nextNetworkId++;
  EntityMap[eid] = opts.mapId ?? world.defaultMapId;
  setEntityKind(world, eid, "nr-player");
  return eid;
}

/** tile 坐标 → 像素中心（与演化 spawn 通道同一换算）。 */
function tileCenter(tx: number, ty: number): { x: number; y: number } {
  return { x: (tx + 0.5) * 16, y: (ty + 0.5) * 16 };
}

function eidsOfKind(world: GameWorld, kind: string): number[] {
  const out: number[] = [];
  for (const eid of query(world, [Transform])) {
    if (Kind[eid] === kind) out.push(eid);
  }
  return out;
}

/** 某图上某 kind 的实体数（分图断言用）。 */
function countKindOnMap(world: GameWorld, kind: string, mapId: string): number {
  return eidsOfKind(world, kind).filter((eid) => entityMapOf(world, eid) === mapId).length;
}

/** tile 切比雪夫距离 ≤ r。 */
function withinRadius(
  world: GameWorld,
  eid: number,
  cx: number,
  cy: number,
  r: number,
): boolean {
  const dx = Math.floor(Transform.x[eid] / 16) - cx;
  const dy = Math.floor(Transform.y[eid] / 16) - cy;
  return Math.max(Math.abs(dx), Math.abs(dy)) <= r;
}

// ─── Nest 组件：初始化钩子 ────────────────────────────────────────────────

describe("Nest 组件：initializer 归一化与 fail-fast", () => {
  it("归一化：capacity 取整钳 ≥0、intervalTicks 钳 ≥1、current 归零", () => {
    initNest(undefined, 900, { spawnKind: "nr-worker", capacity: 2.9, intervalTicks: 0.4 });
    expect(Nest[900]).toEqual({ spawnKind: "nr-worker", capacity: 2, intervalTicks: 1, current: 0 });

    // 缺省：capacity 0（不生产）、interval 1（每 tick 门控）
    initNest(undefined, 901, { spawnKind: "nr-worker" });
    expect(Nest[901]).toEqual({ spawnKind: "nr-worker", capacity: 0, intervalTicks: 1, current: 0 });

    Nest[900] = undefined;
    Nest[901] = undefined;
  });

  it("spawnKind 缺失/空串 → 抛错（配置错误尽早暴露）", () => {
    expect(() => initNest(undefined, 902, {})).toThrow(/spawnKind/);
    expect(() => initNest(undefined, 903, { spawnKind: "" })).toThrow(/spawnKind/);
    expect(Nest[902]).toBeUndefined();
    expect(Nest[903]).toBeUndefined();
  });
});

// ─── nestSystem ──────────────────────────────────────────────────────────

describe("nestSystem：门控 / 补足 / 重数 / 生命周期", () => {
  it("间隔门控：非对齐槽 tick 不生产、不重数", () => {
    ensureTestArchetypes();
    const world = createBareWorld();
    attachTestMap(world);
    const nestEid = spawnEntity(world, world.archetypes.get("nr-nest"), getRegistries().componentRegistry, { x: 72, y: 72 });
    world.time.tick = 1; // 1 % 5 ≠ 0
    createNestSystem({ radiusTiles: 1 })(world);
    expect(eidsOfKind(world, "nr-worker")).toHaveLength(0);
    expect(Nest[nestEid]!.current).toBe(0);
  });

  it("对齐槽补足至容量，落点确定性（双世界同位）且在巢半径内", () => {
    ensureTestArchetypes();
    const run = () => {
      const world = createBareWorld();
      attachTestMap(world);
      spawnEntity(world, world.archetypes.get("nr-nest"), getRegistries().componentRegistry, { x: 72, y: 72 });
      world.time.tick = 5; // 5 % 5 === 0
      createNestSystem({ radiusTiles: 1 })(world);
      return eidsOfKind(world, "nr-worker")
        .map((eid) => [Transform.x[eid], Transform.y[eid]] as const)
        .sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    };
    const first = run();
    const second = run();
    expect(first).toHaveLength(2);
    expect(first).toEqual(second); // 确定性：同状态 → 同落点序列
    for (const [x, y] of first) {
      const tx = Math.floor(x / 16);
      const ty = Math.floor(y / 16);
      expect(Math.max(Math.abs(tx - 4), Math.abs(ty - 4))).toBeLessThanOrEqual(1);
      expect([tx, ty]).not.toEqual([4, 4]); // 巢自身占格（Collider）不被叠放
    }
  });

  it("占位合法性：被占 tile 跳过，落点精确落在唯一空 tile", () => {
    ensureTestArchetypes();
    const world = createBareWorld();
    attachTestMap(world);
    spawnEntity(world, world.archetypes.get("nr-nest-c1"), getRegistries().componentRegistry, { x: 72, y: 72 });
    // (4,4) 九宫格内除 (3,4) 外全部放阻挡桩（巢自身占 (4,4)）
    for (const [tx, ty] of [[3, 3], [4, 3], [5, 3], [5, 4], [3, 5], [4, 5], [5, 5]] as const) {
      const { x, y } = tileCenter(tx, ty);
      spawnEntity(world, world.archetypes.get("nr-blocker"), getRegistries().componentRegistry, { x, y });
    }
    world.time.tick = 1;
    createNestSystem({ radiusTiles: 1 })(world);
    const workers = eidsOfKind(world, "nr-worker");
    expect(workers).toHaveLength(1);
    expect(Transform.x[workers[0]]).toBe(56); // (3,4) → (56, 72)
    expect(Transform.y[workers[0]]).toBe(72);
  });

  it("可走性：半径内全阻挡 → 不生产", () => {
    ensureTestArchetypes();
    const world = createBareWorld();
    attachTestMap(world, "test", {
      blocked: (tx, ty) => tx >= 3 && tx <= 5 && ty >= 3 && ty <= 5,
    });
    spawnEntity(world, world.archetypes.get("nr-nest-fast"), getRegistries().componentRegistry, { x: 72, y: 72 });
    world.time.tick = 1;
    createNestSystem({ radiusTiles: 1 })(world);
    expect(eidsOfKind(world, "nr-worker")).toHaveLength(0);
  });

  it("存活重数镜像 + 击杀回补：current 反映门控时存活数，缺口下槽补足", () => {
    ensureTestArchetypes();
    const world = createBareWorld();
    attachTestMap(world);
    spawnEntity(world, world.archetypes.get("nr-nest-fast"), getRegistries().componentRegistry, { x: 72, y: 72 });
    world.time.tick = 1;
    createNestSystem({ radiusTiles: 1 })(world);
    expect(eidsOfKind(world, "nr-worker")).toHaveLength(2);
    expect(Nest[eidsOfKind(world, "nr-nest-fast")[0]]!.current).toBe(0); // 门控镜像先于补足（首槽存活 0）

    const workers = eidsOfKind(world, "nr-worker");
    destroyEntity(world, workers[0]);

    world.time.tick = 2;
    createNestSystem({ radiusTiles: 1 })(world);
    expect(eidsOfKind(world, "nr-worker")).toHaveLength(2); // 回补至容量
    const nestEid = eidsOfKind(world, "nr-nest-fast")[0];
    expect(Nest[nestEid]!.current).toBe(1); // 镜像门控时存活数（补足前）
  });

  it("足印语义：24px（2×2）产出物不压既有实体——16px 邻格全被排除", () => {
    ensureTestArchetypes();
    const world = createBareWorld();
    attachTestMap(world);
    spawnEntity(world, world.archetypes.get("nr-nest-big"), getRegistries().componentRegistry, { x: 72, y: 72 });
    // (5,4) 放 24px 碰撞桩：radius 1 内 24px 足印与它相邻即重叠（|dx|=16 < 12+12）
    const { x, y } = tileCenter(5, 4);
    spawnEntity(world, world.archetypes.get("nr-blocker24"), getRegistries().componentRegistry, { x, y });
    world.time.tick = 1;
    createNestSystem({ radiusTiles: 1 })(world);
    const big = eidsOfKind(world, "nr-big");
    expect(big).toHaveLength(1);
    expect(Transform.x[big[0]]).toBe(56); // 仅 (3,*) 列满足 |56-88| ≥ 24
    expect(Math.abs(Transform.x[big[0]] - 88)).toBeGreaterThanOrEqual(24); // 不压既有实体
  });

  it("spawnKind 原型缺失：warn 跳过，不砸 tick、不生成", () => {
    ensureTestArchetypes();
    const world = createBareWorld();
    attachTestMap(world);
    spawnEntity(world, world.archetypes.get("nr-nest-missing"), getRegistries().componentRegistry, { x: 72, y: 72 });
    world.time.tick = 1;
    const before = [...query(world, [Transform])].length;
    expect(() => createNestSystem({ radiusTiles: 1 })(world)).not.toThrow();
    expect([...query(world, [Transform])].length).toBe(before);
  });

  it("巢被摧毁 → 停产（无独立存活状态）", () => {
    ensureTestArchetypes();
    const world = createBareWorld();
    attachTestMap(world);
    const nestEid = spawnEntity(world, world.archetypes.get("nr-nest-fast"), getRegistries().componentRegistry, { x: 72, y: 72 });
    world.time.tick = 1;
    createNestSystem({ radiusTiles: 1 })(world);
    expect(eidsOfKind(world, "nr-worker")).toHaveLength(2);

    destroyEntity(world, nestEid);
    for (const eid of eidsOfKind(world, "nr-worker")) destroyEntity(world, eid);

    world.time.tick = 2;
    createNestSystem({ radiusTiles: 1 })(world);
    expect(eidsOfKind(world, "nr-worker")).toHaveLength(0); // 条目已清 → 无生产
  });
});

// ─── raidSystem ──────────────────────────────────────────────────────────

/** raid 规则写入（测试直写 resolvedRules，绕过文件加载；schema 校验另有注册）。 */
function setRaidRule(world: GameWorld, rule: unknown): void {
  world.gameDef.resolvedRules["raid"] = rule;
}

// 规则模块全局注册（无反注册 API → 用本文件专属 id，模块内只注册一次）
let waveV1Ctx: { playerEid: number; ctx: RaidWaveContext } | undefined;
registerRuleModule("nr-wave-v1", (_world, playerEid, ctx) => {
  waveV1Ctx = { playerEid: playerEid as number, ctx: ctx as RaidWaveContext };
  return [
    { kind: "nr-brute", x: 40, y: 40 }, // 显式落点
    { kind: "nr-worker" }, // 缺省落位（玩家附近）
  ];
});
registerRuleModule("nr-wave-v2", () => [{ kind: "nr-missing-kind" }]);

describe("raidSystem：规则驱动的周期刷波", () => {
  it("无 raid 规则 → no-op", () => {
    ensureTestArchetypes();
    const world = createBareWorld();
    attachTestMap(world);
    spawnTestPlayer(world);
    world.time.tick = 10;
    raidSystem(world);
    expect(eidsOfKind(world, "nr-worker")).toHaveLength(0);
    expect(eidsOfKind(world, "nr-brute")).toHaveLength(0);
  });

  it("间隔门控 + 波刷在玩家同图、半径内（每玩家各得一波）", () => {
    ensureTestArchetypes();
    const world = createBareWorld();
    attachTestMap(world, "test");
    attachTestMap(world, "test2");
    spawnTestPlayer(world, { mapId: "test" });
    spawnTestPlayer(world, { mapId: "test2" });
    setRaidRule(world, { intervalTicks: 5, waveSize: 2, kinds: ["nr-worker"], radiusTiles: 2 });

    world.time.tick = 1; // 1 % 5 ≠ 0
    raidSystem(world);
    expect(countKindOnMap(world, "nr-worker", "test")).toBe(0);
    expect(countKindOnMap(world, "nr-worker", "test2")).toBe(0);

    world.time.tick = 5;
    raidSystem(world);
    for (const mapId of ["test", "test2"]) {
      expect(countKindOnMap(world, "nr-worker", mapId)).toBe(2); // 分图各自成波
      for (const eid of eidsOfKind(world, "nr-worker")) {
        if (entityMapOf(world, eid) !== mapId) continue;
        expect(withinRadius(world, eid, 4, 4, 2)).toBe(true); // 玩家在 (4,4)
      }
    }
  });

  it("waveRef 模块接管波构建：显式落点照放、缺省落位近玩家、waveSize 被忽略", () => {
    ensureTestArchetypes();
    const world = createBareWorld();
    attachTestMap(world);
    const playerEid = spawnTestPlayer(world);
    setRaidRule(world, { intervalTicks: 1, waveSize: 99, kinds: ["nr-worker"], radiusTiles: 2, waveRef: "nr-wave-v1" });

    world.time.tick = 1;
    raidSystem(world);

    expect(waveV1Ctx).toBeDefined();
    expect(waveV1Ctx!.playerEid).toBe(playerEid);
    expect(waveV1Ctx!.ctx.mapId).toBe("test");
    expect(waveV1Ctx!.ctx.tick).toBe(1);
    expect(waveV1Ctx!.ctx.radiusTiles).toBe(2);

    const brutes = eidsOfKind(world, "nr-brute");
    expect(brutes).toHaveLength(1); // waveSize 99 未生效（模块完全接管）
    expect(Transform.x[brutes[0]]).toBe(40);
    expect(Transform.y[brutes[0]]).toBe(40);
    expect(entityMapOf(world, brutes[0])).toBe("test");

    const workers = eidsOfKind(world, "nr-worker");
    expect(workers).toHaveLength(1);
    expect(withinRadius(world, workers[0], 4, 4, 2)).toBe(true);
  });

  it("waveRef 成员 kind 原型缺失 → warn 跳过不砸 tick", () => {
    ensureTestArchetypes();
    const world = createBareWorld();
    attachTestMap(world);
    spawnTestPlayer(world);
    setRaidRule(world, { intervalTicks: 1, waveSize: 1, kinds: ["nr-worker"], waveRef: "nr-wave-v2" });
    world.time.tick = 1;
    const before = [...query(world, [Transform])].length;
    expect(() => raidSystem(world)).not.toThrow();
    expect([...query(world, [Transform])].length).toBe(before);
  });

  it("waveRef 未知模块 id → 求值时抛错", () => {
    ensureTestArchetypes();
    const world = createBareWorld();
    attachTestMap(world);
    spawnTestPlayer(world);
    setRaidRule(world, { intervalTicks: 1, waveSize: 1, kinds: ["nr-worker"], waveRef: "nr-missing-module" });
    world.time.tick = 1;
    expect(() => raidSystem(world)).toThrow(/not registered/);
  });

  it("condition 门控（isNight）：白天不刷、夜晚刷", () => {
    ensureTestArchetypes();
    const world = createBareWorld();
    attachTestMap(world);
    spawnTestPlayer(world);
    setRaidRule(world, { intervalTicks: 1, waveSize: 2, kinds: ["nr-worker"], radiusTiles: 2, condition: "isNight" });

    world.time.timeOfDay.phase = PHASE_DAY;
    world.time.tick = 1;
    raidSystem(world);
    expect(eidsOfKind(world, "nr-worker")).toHaveLength(0);

    world.time.timeOfDay.phase = PHASE_NIGHT;
    world.time.tick = 2;
    raidSystem(world);
    expect(eidsOfKind(world, "nr-worker")).toHaveLength(2);
  });

  it("condition 未注册名 → 求值时抛错（getSpawnCondition 惯例）", () => {
    ensureTestArchetypes();
    const world = createBareWorld();
    attachTestMap(world);
    spawnTestPlayer(world);
    setRaidRule(world, { intervalTicks: 1, waveSize: 1, kinds: ["nr-worker"], condition: "nr-nope" });
    world.time.tick = 1;
    expect(() => raidSystem(world)).toThrow(/not registered/);
  });
});

// ─── isDay 刷怪条件 ──────────────────────────────────────────────────────

describe("isDay 刷怪条件", () => {
  it("按昼夜相位判定（isNight 同款机制）", () => {
    const world = createBareWorld();
    const cond = getSpawnCondition("isDay");
    world.time.timeOfDay.phase = PHASE_NIGHT;
    expect(cond(world)).toBe(false);
    world.time.timeOfDay.phase = PHASE_DAY;
    expect(cond(world)).toBe(true);
  });
});

// ─── Nest 持久化（世界快照往返） ─────────────────────────────────────────

describe("Nest 组件持久化", () => {
  it("serializeWorld/restoreWorld 往返：Nest AoS 状态与产出实体完整恢复", () => {
    ensureTestArchetypes();
    const world1 = createBareWorld();
    attachTestMap(world1);
    spawnEntity(world1, world1.archetypes.get("nr-nest"), getRegistries().componentRegistry, { x: 72, y: 72 });
    world1.time.tick = 5;
    createNestSystem({ radiusTiles: 1 })(world1);
    expect(countKindOnMap(world1, "nr-worker", "test")).toBe(2);
    const nestBefore = { ...Nest[eidsOfKind(world1, "nr-nest")[0]]! };

    const record = serializeWorld(world1, "nr-save");
    const world2 = createBareWorld();
    attachTestMap(world2);
    const orphans = restoreWorld(world2, record);
    expect(orphans).toEqual([]);

    // 巢恢复：四个字段逐项一致（Nest 不在 RUNTIME_ONLY_COMPONENTS → 随实体入档）
    const restoredNestEid = eidsOfKind(world2, "nr-nest")[0];
    expect(restoredNestEid).toBeDefined();
    expect(Nest[restoredNestEid]!.spawnKind).toBe(nestBefore.spawnKind);
    expect(Nest[restoredNestEid]!.capacity).toBe(nestBefore.capacity);
    expect(Nest[restoredNestEid]!.intervalTicks).toBe(nestBefore.intervalTicks);
    expect(Nest[restoredNestEid]!.current).toBe(nestBefore.current);
    expect(entityMapOf(world2, restoredNestEid)).toBe("test");

    // 产出实体同样入档恢复：存活重数不因读档漂移
    expect(countKindOnMap(world2, "nr-worker", "test")).toBe(2);

    // 读档后下一门控：存活已满 → current 重数为 2、不重复补足
    world2.time.tick = 10; // 10 % 5 === 0
    createNestSystem({ radiusTiles: 1 })(world2);
    expect(countKindOnMap(world2, "nr-worker", "test")).toBe(2);
    expect(Nest[restoredNestEid]!.current).toBe(2);
  });
});
