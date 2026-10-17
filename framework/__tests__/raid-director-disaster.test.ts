/**
 * 切片 D+灾害：袭击导演补全 + 天气灾害系统 + 结构防御值。
 *
 * 覆盖：
 * - 袭击导演：预警期时序（warnTicks 内只发 on-raid-warning 事件、倒计时结束
 *   才刷波、导演可重新武装）；无玩家暂停（全 Offline 保留/无玩家时倒计时
 *   冻结——进度保留，不推进不重置）；requireCondition 门槛不满足跳过整轮
 *   （不进预警不刷波，未知名求值抛错同 condition 约定）；
 * - 天气灾害（消费 WorldClock + 写回入口全链）：灾害天气窗口 + 对齐槽触发；
 *   野火——可燃实体经状态机燃烧链烧毁消失 + 焦土写回（scorch-ground 效果）
 *   + 空可燃格地面明火写回 + 出厂底板不被污染 + 脏格登记携带当前 tick；
 *   风暴——露天实体周期掉血、室内（isIndoors）免疫、断线保留/已死跳过；
 * - 结构防御值：attackStructures 开启时波成员被指派建造物目标、射程内持续
 *   攻击、打坏经 deathSystem 统一销毁、指派随目标消亡清理；关闭时不攻击；
 * - 确定性：同种子同 tick 两次运行灾害结果逐位一致。
 *
 * 既有 raid 语义（intervalTicks/waveSize/kinds/waveRef/condition）零回归由
 * nest-raid.test.ts 全量守护；本文件补导演新增字段的可选缺省行为。
 */
import { describe, it, expect, beforeAll } from "vitest";
import { addComponent, addEntity, hasComponent, query, removeComponent } from "bitecs";
import {
  bootstrapFramework,
  createGameInstance,
  createDefaultGameDefinition,
  spawnEntity,
  getRegistries,
  PHASE_DAY,
  PHASE_NIGHT,
} from "framework/index";
import { Transform } from "framework/components/transform";
import { Collider, ColliderShape } from "framework/components/physics";
import { Attack, Health } from "framework/components/combat";
import { Cooldown } from "components";
import { Player } from "framework/components/tags";
import { Kind } from "framework/components/kind";
import { EntityMap } from "framework/components/entityMap";
import { Offline } from "framework/components/offline";
import {
  Structure,
  STRUCTURE_ROLE_WALL,
  STRUCTURE_ROLE_FLOOR,
} from "framework/components/structure";
import { EntityLevel } from "framework/components/entityLevel";
import { raidSystem } from "framework/systems/gameplay/raidSystem";
import { createDisasterSystem } from "framework/systems/gameplay/disasterSystem";
import { deathSystem } from "framework/systems/gameplay/deathSystem";
import { drainEvents } from "framework/simulation/events/eventBus";
import { entityIsIndoors } from "framework/map/runtime/indoors";
import {
  drainDirtyTiles,
  registerTerrainBaseline,
  terrainBaselineOf,
} from "map/runtime/terrainWriteback";
import { computeGeometryVersion } from "map/geometry/version";
import { makeTestGeometry } from "./helpers/mapGeometry";
import type { ArchetypeSpec } from "framework/entities/archetypeRegistry";
import type { GameWorld } from "framework/world";

beforeAll(() => {
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

/** 测试原型集：波成员 / 袭击者（远射程）/ 可袭击墙 / 可燃树（状态机燃烧链）。 */
function ensureTestArchetypes(): void {
  ensureArchetype({
    kind: "rd-worker",
    components: {
      Collider: { shape: ColliderShape.Box, halfW: 8, halfH: 8 },
      Health: { current: 10, max: 10 },
    },
    team: 2,
  });
  ensureArchetype({
    kind: "rd-raider",
    components: {
      Collider: { shape: ColliderShape.Box, halfW: 8, halfH: 8 },
      Health: { current: 20, max: 20 },
      Attack: { value: 5, range: 200 },
      Cooldown: {},
    },
    team: 2,
  });
  ensureArchetype({
    kind: "rd-wall",
    components: {
      Collider: { shape: ColliderShape.Box, halfW: 8, halfH: 8 },
      Health: { current: 5, max: 5 },
      Structure: { role: STRUCTURE_ROLE_WALL },
    },
  });
  ensureArchetype({
    kind: "rd-tree",
    components: {
      StateMachine: {
        initial: "alive",
        states: {
          alive: { transitions: [{ on: "ignite", to: "burning" }] },
          burning: {
            transitions: [
              {
                afterTicks: 0,
                to: "burnt",
                effects: [
                  { name: "scorch-ground", params: { semantic: 9 } },
                  { name: "despawn" },
                ],
              },
            ],
          },
          burnt: {},
        },
      },
    },
  } satisfies ArchetypeSpec);
}

/** 给裸 world 挂一块 8×8 测试地图（128×128 像素，缺省全可走，常驻激活）。 */
function attachTestMap(
  world: GameWorld,
  key = "test",
  opts: Parameters<typeof makeTestGeometry>[0] = {},
): ReturnType<typeof makeTestGeometry> {
  const geometry = makeTestGeometry({ key, width: 8, height: 8, ...opts });
  world.maps[key] = geometry;
  world.activeMaps.add(key);
  world.defaultMapId = key;
  return geometry;
}

/** tile 坐标 → 像素中心（与演化 spawn 通道同一换算）。 */
function tileCenter(tx: number, ty: number): { x: number; y: number } {
  return { x: (tx + 0.5) * 16, y: (ty + 0.5) * 16 };
}

interface PlayerOpts { x?: number; y?: number; mapId?: string; }

/** 手工 spawn 测试玩家：Player/Health/Transform + EntityMap 归属。 */
function spawnTestPlayer(world: GameWorld, opts: PlayerOpts = {}): number {
  const eid = addEntity(world);
  addComponent(world, eid, Transform);
  addComponent(world, eid, Player);
  addComponent(world, eid, Health);
  Transform.x[eid] = opts.x ?? 72;
  Transform.y[eid] = opts.y ?? 72;
  Health.current[eid] = 100;
  Health.max[eid] = 100;
  EntityMap[eid] = opts.mapId ?? world.defaultMapId;
  return eid;
}

/** 手工 spawn 带 Health 的测试实体（风暴伤害目标）。 */
function spawnHealthEntity(world: GameWorld, x: number, y: number): number {
  const eid = addEntity(world);
  addComponent(world, eid, Transform);
  addComponent(world, eid, Health);
  Transform.x[eid] = x;
  Transform.y[eid] = y;
  Health.current[eid] = 100;
  Health.max[eid] = 100;
  EntityMap[eid] = world.defaultMapId;
  return eid;
}

/** 手工 spawn 建造结构实体（墙/楼板）：Structure role + 显式层号。 */
function spawnStructure(
  world: GameWorld,
  mapId: string,
  tx: number,
  ty: number,
  level: number,
  role: number,
): number {
  const eid = addEntity(world);
  addComponent(world, eid, Transform);
  addComponent(world, eid, Structure);
  Structure.role[eid] = role;
  const { x, y } = tileCenter(tx, ty);
  Transform.x[eid] = x;
  Transform.y[eid] = y;
  EntityMap[eid] = mapId;
  EntityLevel[eid] = level;
  return eid;
}

function eidsOfKind(world: GameWorld, kind: string): number[] {
  const out: number[] = [];
  for (const eid of query(world, [Transform])) {
    if (Kind[eid] === kind) out.push(eid);
  }
  return out;
}

function warningEventsOf(world: GameWorld): Array<{ eid: number; remainingTicks: number }> {
  return drainEvents(world)
    .filter((evt) => evt.name === "on-raid-warning")
    .map((evt) => evt.payload as { eid: number; remainingTicks: number });
}

/** 恒定 storm 天气的 environment 规则（单候选权重 → 任意 tick 均为 storm）。 */
function setStormEnvironment(world: GameWorld): void {
  world.gameDef.resolvedRules["environment"] = {
    seed: 7,
    weatherSlotTicks: 100,
    phases: [{ id: "p", durationTicks: 1000, weather: [{ id: "storm", weight: 1 }] }],
  };
}

/** 挂一块 3×3 全可燃（语义 5）地图 + 注册出厂底板（写回全链断言用）。 */
function attachFlammableMap(world: GameWorld): ReturnType<typeof makeTestGeometry> {
  const geometry = makeTestGeometry({
    key: "fire",
    width: 3,
    height: 3,
    tiles: () => 5,
  });
  world.maps["fire"] = geometry;
  world.activeMaps.add("fire");
  world.defaultMapId = "fire";
  registerTerrainBaseline(world, "fire", geometry);
  return geometry;
}

/** 写入灾害规则（野火覆盖全图半径，attempts 拉满保证确定性命中可燃格）。 */
function setWildfireRule(world: GameWorld): void {
  world.gameDef.resolvedRules["disasters"] = {
    weatherId: "storm",
    intervalTicks: 1,
    wildfire: {
      flammableGrounds: [5],
      scorchGround: 9,
      attempts: 200,
      radiusTiles: 1,
      flammableKinds: ["rd-tree"],
    },
  };
}

// ─── 袭击导演：预警期 ─────────────────────────────────────────────────────

describe("袭击导演：预警期时序", () => {
  it("预警期内不刷波、每 tick 发 on-raid-warning（remainingTicks 递减），倒计时结束才刷波", () => {
    ensureTestArchetypes();
    const world = createBareWorld();
    attachTestMap(world, "warn");
    const playerEid = spawnTestPlayer(world, { mapId: "warn" });
    world.gameDef.resolvedRules["raid"] = {
      intervalTicks: 5,
      waveSize: 2,
      kinds: ["rd-worker"],
      radiusTiles: 2,
      warnTicks: 2,
    };

    // 门控 tick：进预警窗口——不刷波、不发事件（预警从下一 tick 起）
    world.time.tick = 5;
    raidSystem(world);
    expect(eidsOfKind(world, "rd-worker")).toHaveLength(0);
    expect(warningEventsOf(world)).toHaveLength(0);

    // 预警第 1 tick：只发事件（remaining 2）
    world.time.tick = 6;
    raidSystem(world);
    expect(eidsOfKind(world, "rd-worker")).toHaveLength(0);
    expect(warningEventsOf(world)).toEqual([{ eid: playerEid, remainingTicks: 2 }]);

    // 预警第 2 tick：发事件（remaining 1）后倒计时归零 → 当 tick 刷波
    world.time.tick = 7;
    raidSystem(world);
    const workers = eidsOfKind(world, "rd-worker");
    expect(workers).toHaveLength(2);
    expect(warningEventsOf(world)).toEqual([{ eid: playerEid, remainingTicks: 1 }]);
    for (const eid of workers) {
      expect(EntityMap[eid]).toBe("warn");
    }

    // 导演重新武装：下一门控槽再进预警，而非立即刷波
    world.time.tick = 10;
    raidSystem(world);
    expect(eidsOfKind(world, "rd-worker")).toHaveLength(2);
    expect(warningEventsOf(world)).toHaveLength(0);
    world.time.tick = 11;
    raidSystem(world);
    expect(warningEventsOf(world)).toEqual([{ eid: playerEid, remainingTicks: 2 }]);
    world.time.tick = 12;
    raidSystem(world);
    expect(eidsOfKind(world, "rd-worker")).toHaveLength(4);
  });

  it("warnTicks 缺省/0 = 门控当 tick 即刷（旧行为不变）", () => {
    ensureTestArchetypes();
    const world = createBareWorld();
    attachTestMap(world, "warn0");
    spawnTestPlayer(world, { mapId: "warn0" });
    world.gameDef.resolvedRules["raid"] = {
      intervalTicks: 5,
      waveSize: 1,
      kinds: ["rd-worker"],
    };
    world.time.tick = 5;
    raidSystem(world);
    expect(eidsOfKind(world, "rd-worker")).toHaveLength(1);
    expect(warningEventsOf(world)).toHaveLength(0);
  });
});

// ─── 袭击导演：无玩家暂停 ─────────────────────────────────────────────────

describe("袭击导演：无玩家暂停", () => {
  it("预警期内全 Offline 保留 → 倒计时冻结（不发事件不推进）；恢复后从冻结进度继续", () => {
    ensureTestArchetypes();
    const world = createBareWorld();
    attachTestMap(world, "pause");
    world.gameDef.resolvedRules["raid"] = {
      intervalTicks: 5,
      waveSize: 1,
      kinds: ["rd-worker"],
      warnTicks: 3,
    };

    // 无玩家时不进预警（尚未开始的轮次不启动）
    world.time.tick = 5;
    raidSystem(world);
    expect(warningEventsOf(world)).toHaveLength(0);
    expect(eidsOfKind(world, "rd-worker")).toHaveLength(0);

    // 玩家上线后进预警并推进 1 tick（remaining 3 → 2）
    const playerEid = spawnTestPlayer(world, { mapId: "pause" });
    world.time.tick = 10;
    raidSystem(world);
    expect(warningEventsOf(world)).toHaveLength(0);
    world.time.tick = 11;
    raidSystem(world);
    expect(warningEventsOf(world)).toEqual([{ eid: playerEid, remainingTicks: 3 }]);

    // 断线保留：倒计时冻结——不发事件、不推进、不重置（门控槽照过也不动）
    addComponent(world, playerEid, Offline);
    for (const tick of [12, 13, 14, 15]) {
      world.time.tick = tick; // 15 是下一门控槽，pending 分支优先且同样冻结
      raidSystem(world);
      expect(warningEventsOf(world)).toHaveLength(0);
      expect(eidsOfKind(world, "rd-worker")).toHaveLength(0);
    }

    // 重连恢复：从冻结进度（remaining 2）继续，再走 2 tick 后刷波
    removeComponent(world, playerEid, Offline);
    world.time.tick = 16;
    raidSystem(world);
    expect(warningEventsOf(world)).toEqual([{ eid: playerEid, remainingTicks: 2 }]);
    expect(eidsOfKind(world, "rd-worker")).toHaveLength(0);
    world.time.tick = 17;
    raidSystem(world);
    expect(warningEventsOf(world)).toEqual([{ eid: playerEid, remainingTicks: 1 }]);
    expect(eidsOfKind(world, "rd-worker")).toHaveLength(1);
  });
});

// ─── 袭击导演：门槛门控 ───────────────────────────────────────────────────

describe("袭击导演：requireCondition 门槛", () => {
  it("门槛不满足 → 跳过该轮（不进预警不刷波）；满足后正常成轮", () => {
    ensureTestArchetypes();
    const world = createBareWorld();
    attachTestMap(world, "gate");
    const playerEid = spawnTestPlayer(world, { mapId: "gate" });
    world.gameDef.resolvedRules["raid"] = {
      intervalTicks: 5,
      waveSize: 1,
      kinds: ["rd-worker"],
      warnTicks: 2,
      requireCondition: "isDay",
    };

    // 夜晚：门槛不满足 → 整轮跳过（无预警事件、无波、无 pending）
    world.time.timeOfDay.phase = PHASE_NIGHT;
    world.time.tick = 5;
    raidSystem(world);
    world.time.tick = 6;
    raidSystem(world);
    expect(warningEventsOf(world)).toHaveLength(0);
    expect(eidsOfKind(world, "rd-worker")).toHaveLength(0);

    // 白天：门槛通过 → 正常进预警并成波
    world.time.timeOfDay.phase = PHASE_DAY;
    world.time.tick = 10;
    raidSystem(world);
    world.time.tick = 11;
    raidSystem(world);
    expect(warningEventsOf(world)).toEqual([{ eid: playerEid, remainingTicks: 2 }]);
    expect(eidsOfKind(world, "rd-worker")).toHaveLength(0);
    world.time.tick = 12;
    raidSystem(world);
    expect(eidsOfKind(world, "rd-worker")).toHaveLength(1);
  });

  it("requireCondition 未注册名 → 门控求值时抛错（与 condition 同约定）", () => {
    ensureTestArchetypes();
    const world = createBareWorld();
    attachTestMap(world, "gate-unknown");
    spawnTestPlayer(world, { mapId: "gate-unknown" });
    world.gameDef.resolvedRules["raid"] = {
      intervalTicks: 1,
      waveSize: 1,
      kinds: ["rd-worker"],
      requireCondition: "rd-nope",
    };
    world.time.tick = 1;
    expect(() => raidSystem(world)).toThrow(/not registered/);
  });
});

// ─── 天气灾害：野火（WorldClock + 写回入口全链） ──────────────────────────

describe("灾害系统：野火", () => {
  it("灾害天气触发野火：可燃实体烧毁消失 + 焦土写回（指纹/脏格/出厂底板全链）", () => {
    ensureTestArchetypes();
    const world = createBareWorld();
    const geometry = attachFlammableMap(world);
    const version0 = geometry.version;
    spawnTestPlayer(world, { x: 24, y: 24 }); // tile (1,1)
    const treeEid = spawnEntity(world, world.archetypes.get("rd-tree"), getRegistries().componentRegistry, {
      x: 8, y: 8, mapId: "fire",
    }); // tile (0,0)

    setStormEnvironment(world);
    setWildfireRule(world);
    world.time.tick = 10;

    createDisasterSystem()(world);

    // 可燃实体经状态机燃烧链（ignite 信号 → 烧尽迁移）消失
    expect(eidsOfKind(world, "rd-tree")).toHaveLength(0);
    expect(hasComponent(world, treeEid, Transform)).toBe(false);

    // 焦土写回：树下（scorch-ground 效果）+ 空可燃格（地面明火）均为语义 9
    const treeTile = 0; // (0,0) 行主序线性索引
    expect(geometry.tiles[treeTile]).toBe(9);
    const scorched = Array.from(geometry.tiles).filter((v) => v === 9).length;
    expect(scorched).toBeGreaterThanOrEqual(2);

    // 写回入口全链：version 指纹与内容恒同步；出厂底板不被污染
    expect(geometry.version).not.toBe(version0);
    expect(geometry.version).toBe(computeGeometryVersion(geometry));
    expect(terrainBaselineOf(world, "fire")!.tiles[treeTile]).toBe(5);

    // 脏格登记：携带当前 tick（callerTick 缺省 = world.time.tick），推完即清
    const drained = drainDirtyTiles(world);
    const records = drained.get("fire")!;
    expect(records.length).toBeGreaterThanOrEqual(2);
    for (const record of records) {
      expect(record.field).toBe("tiles");
      expect(record.value).toBe(9);
      expect(record.tick).toBe(10);
    }
    expect(drainDirtyTiles(world).size).toBe(0);
  });

  it("非灾害天气 / 非对齐槽 → no-op", () => {
    ensureTestArchetypes();
    const world = createBareWorld();
    const geometry = attachFlammableMap(world);
    spawnTestPlayer(world, { x: 24, y: 24 });
    setWildfireRule(world);
    // 无 environment 规则 → weatherId 恒空串，永不命中灾害窗口
    world.time.tick = 10;
    createDisasterSystem()(world);
    expect(Array.from(geometry.tiles).every((v) => v === 5)).toBe(true);

    // 命中天气但非对齐槽（intervalTicks 150）
    setStormEnvironment(world);
    (world.gameDef.resolvedRules["disasters"] as { intervalTicks: number }).intervalTicks = 150;
    world.time.tick = 10;
    createDisasterSystem()(world);
    expect(Array.from(geometry.tiles).every((v) => v === 5)).toBe(true);
    expect(eidsOfKind(world, "rd-tree")).toHaveLength(0);
  });

  it("确定性：同种子同 tick 两次独立运行，灾害结果逐位一致", () => {
    ensureTestArchetypes();
    const run = (): { tiles: number[]; trees: number; records: unknown[] } => {
      const world = createBareWorld();
      const geometry = attachFlammableMap(world);
      spawnTestPlayer(world, { x: 24, y: 24 });
      spawnEntity(world, world.archetypes.get("rd-tree"), getRegistries().componentRegistry, {
        x: 8, y: 8, mapId: "fire",
      });
      setStormEnvironment(world);
      setWildfireRule(world);
      world.time.tick = 10;
      createDisasterSystem()(world);
      const records = drainDirtyTiles(world).get("fire") ?? [];
      return { tiles: Array.from(geometry.tiles), trees: eidsOfKind(world, "rd-tree").length, records };
    };
    const first = run();
    const second = run();
    expect(second.tiles).toEqual(first.tiles);
    expect(second.trees).toBe(first.trees);
    expect(second.records).toEqual(first.records);
    expect(first.trees).toBe(0);
  });
});

// ─── 天气灾害：风暴 ───────────────────────────────────────────────────────

describe("灾害系统：风暴", () => {
  it("露天实体周期掉血；室内（isIndoors）免疫；断线保留/已死跳过", () => {
    ensureTestArchetypes();
    const world = createBareWorld();
    attachTestMap(world, "stormmap");
    // 手工搭最小房间：L0 墙环围 (1,1)，L1 楼板盖顶 → (1,1) 室内
    const ring: Array<[number, number]> = [
      [0, 0], [1, 0], [2, 0], [0, 1], [2, 1], [0, 2], [1, 2], [2, 2],
    ];
    for (const [tx, ty] of ring) spawnStructure(world, "stormmap", tx, ty, 0, STRUCTURE_ROLE_WALL);
    spawnStructure(world, "stormmap", 1, 1, 1, STRUCTURE_ROLE_FLOOR);

    const indoorPos = tileCenter(1, 1);
    const indoor = spawnHealthEntity(world, indoorPos.x, indoorPos.y);
    const outdoorPos = tileCenter(5, 5);
    const outdoor = spawnHealthEntity(world, outdoorPos.x, outdoorPos.y);
    const offlinePos = tileCenter(6, 6);
    const offline = spawnHealthEntity(world, offlinePos.x, offlinePos.y);
    addComponent(world, offline, Offline);
    const deadPos = tileCenter(7, 7);
    const dead = spawnHealthEntity(world, deadPos.x, deadPos.y);
    Health.current[dead] = 0;

    // 构造自检：室内判定生效（否则断言无意义）
    expect(entityIsIndoors(world, indoor)).toBe(true);
    expect(entityIsIndoors(world, outdoor)).toBe(false);

    setStormEnvironment(world);
    world.gameDef.resolvedRules["disasters"] = {
      weatherId: "storm",
      intervalTicks: 1,
      storm: { damageIntervalTicks: 1, damage: 5 },
    };
    world.time.tick = 10;

    createDisasterSystem()(world);

    expect(Health.current[outdoor]).toBe(95);
    expect(Health.current[indoor]).toBe(100);
    expect(Health.current[offline]).toBe(100);
    expect(Health.current[dead]).toBe(0);

    // 周期性：伤害按对齐槽重复
    world.time.tick = 11;
    createDisasterSystem()(world);
    expect(Health.current[outdoor]).toBe(90);
    expect(Health.current[indoor]).toBe(100);
  });

  it("伤害周期与灾害周期独立（damageIntervalTicks 缺省回退灾害 intervalTicks）", () => {
    ensureTestArchetypes();
    const world = createBareWorld();
    attachTestMap(world, "stormmap2");
    const victim = spawnHealthEntity(world, 72, 72);
    setStormEnvironment(world);
    world.gameDef.resolvedRules["disasters"] = {
      weatherId: "storm",
      intervalTicks: 2,
      storm: { damage: 3 },
    };
    world.time.tick = 4; // 4 % 2 === 0：灾害与伤害同槽
    createDisasterSystem()(world);
    expect(Health.current[victim]).toBe(97);
    world.time.tick = 5; // 非对齐槽
    createDisasterSystem()(world);
    expect(Health.current[victim]).toBe(97);
    world.time.tick = 6;
    createDisasterSystem()(world);
    expect(Health.current[victim]).toBe(94);
  });
});

// ─── 结构防御值：袭击波对抗建造物 ─────────────────────────────────────────

describe("结构防御值：袭击波攻击建造物", () => {
  it("attackStructures 开启：波成员被指派目标、射程内打坏 → deathSystem 统一销毁", () => {
    ensureTestArchetypes();
    const world = createBareWorld();
    attachTestMap(world, "raidmap");
    spawnTestPlayer(world, { mapId: "raidmap" }); // tile (4,4)
    const wallEid = spawnEntity(world, world.archetypes.get("rd-wall"), getRegistries().componentRegistry, {
      x: 56, y: 72, mapId: "raidmap",
    }); // tile (3,4)，玩家邻格
    world.gameDef.resolvedRules["raid"] = {
      intervalTicks: 5,
      waveSize: 1,
      kinds: ["rd-raider"],
      radiusTiles: 1,
      attackStructures: true,
    };

    // 刷波 tick：指派当 tick 不结算攻击（攻击步先于导演推进）
    world.time.tick = 5;
    raidSystem(world);
    const raiders = eidsOfKind(world, "rd-raider");
    expect(raiders).toHaveLength(1);
    expect(Health.current[wallEid]).toBe(5);

    // 下一 tick：成员在射程内攻击建造物（Attack.range 200 必中）→ 一击打坏
    world.time.tick = 6;
    raidSystem(world);
    expect(Health.current[wallEid]).toBeLessThanOrEqual(0);

    // 打坏即销毁统一归 deathSystem（非玩家 Health ≤ 0 → destroyEntity）
    deathSystem(world);
    expect(hasComponent(world, wallEid, Transform)).toBe(false);

    // 目标消亡后指派清理：攻击步不再引用死实体（不抛错、不影响波成员）
    world.time.tick = 7;
    expect(() => raidSystem(world)).not.toThrow();
    expect(eidsOfKind(world, "rd-raider")).toHaveLength(1);
  });

  it("attackStructures 缺省关闭：建造物不受波成员攻击（新增字段缺省关闭）", () => {
    ensureTestArchetypes();
    const world = createBareWorld();
    attachTestMap(world, "raidmap2");
    spawnTestPlayer(world, { mapId: "raidmap2" });
    const wallEid = spawnEntity(world, world.archetypes.get("rd-wall"), getRegistries().componentRegistry, {
      x: 56, y: 72, mapId: "raidmap2",
    });
    world.gameDef.resolvedRules["raid"] = {
      intervalTicks: 5,
      waveSize: 1,
      kinds: ["rd-raider"],
      radiusTiles: 1,
    };
    world.time.tick = 5;
    raidSystem(world);
    world.time.tick = 6;
    raidSystem(world);
    world.time.tick = 7;
    raidSystem(world);
    expect(Health.current[wallEid]).toBe(5);
  });
});
