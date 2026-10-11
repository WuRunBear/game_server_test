/**
 * 生态切片 3A：族群节点数据模型 + 确定性步进（framework/__tests__/population.test.ts）。
 *
 * 覆盖任务验收矩阵：
 *   ① 承载力依赖区域真实面积（改区域面积 → cap 变化；含 region-stats meta.area 优先）；
 *   ② 数量按增长率步进且有上限（整数增长确定性；小数增长经确定性随机流）；
 *   ③ **离线等价性：快进 ≡ 逐 tick**（核心断言，含长跨度早退）；
 *   ④ 序列化 → 恢复后节点状态正确；
 *   ⑤ 确定性：同世界同种子重复运行结果一致（异种子序列不同）；
 *   ⑥ 来源被移除（巢穴销毁）后该处不再产出（最小生产通路停产）。
 * 另含 GameSimulation.runOfflineCatchUp 的挂载点集成用例（真配置读档 + 离线补差）。
 */
import { describe, it, expect, beforeAll, afterEach, vi } from "vitest";
import { query } from "bitecs";
import {
  bootstrapFramework,
  createDefaultGameDefinition,
  createGameInstance,
  createGameSimulation,
  getRegistries,
  serializeWorld,
  restoreWorld,
  spawnEntity,
} from "framework/index";
import { Population } from "framework/simulation/population/population";
import { regionAreaOf, growthForSlot } from "framework/simulation/population/population";
import {
  populationSystem,
  fastForwardPopulations,
  populationSnapshot,
} from "framework/simulation/population/populationSystem";
import { setMapSeeds } from "map/runtime/mapSeeds";
import { destroyEntity } from "framework/entities/destroyEntity";
import { NetworkId } from "framework/components/network";
import { Kind } from "framework/components/kind";
import { Transform } from "framework/components/transform";
import { memoryRepository } from "./helpers/persistence";
import type { MapGeometry, RegionMeta } from "map/geometry/types";
import type { GameWorld } from "framework/world";
import type { LoadedGameDefinition } from "framework/config/schema/GameDefinitionSchema";
import type { SimulationPort } from "simulation";

beforeAll(() => {
  bootstrapFramework();
  const { archetypeRegistry } = getRegistries();
  // 族群节点原型（配置只在测试里声明；game/ 内容本切片不新增）
  archetypeRegistry.register({
    kind: NODE_KIND,
    components: {
      Population: {
        species: PREY_KIND,
        carryingDensity: 0,
        growthRate: 0,
        growthIntervalTicks: 1,
        homeRegion: "den",
        count: 0,
      },
    },
  });
  // 被产出的物种原型（无 Placeable → 16px 占位 / 单格）
  archetypeRegistry.register({ kind: PREY_KIND, components: {} });
  archetypeRegistry.register({ kind: PREY_SRC_KIND, components: {} });
});

afterEach(() => {
  vi.useRealTimers();
});

const KEY = "popmap";
const NODE_KIND = "pop_node";
const PREY_KIND = "pop_prey";
const PREY_SRC_KIND = "pop_src_prey";

/** 最小世界（默认配置，无具体 game 内容依赖）。 */
function createBareWorld(): GameWorld {
  return createGameInstance(createDefaultGameDefinition()).world;
}

/**
 * 构造 16×16 全可走、双命名区域的几何：
 * region 索引 0 = "den"（前 areaDen 格），1 = "rest"（其余）。
 */
function makeGeometry(areaDen: number, key = KEY): MapGeometry {
  const width = 16;
  const height = 16;
  const total = width * height;
  const regionOfTile = new Uint16Array(total);
  for (let i = 0; i < total; i++) regionOfTile[i] = i < areaDen ? 0 : 1;
  return {
    key,
    grid: { width, height, tileWidth: 16, tileHeight: 16 },
    tiles: new Uint8Array(total).fill(1),
    walkable: new Uint8Array(total).fill(1),
    regions: new Map<string, RegionMeta>([
      ["den", { name: "den", meta: {} }],
      ["rest", { name: "rest", meta: {} }],
    ]),
    regionOfTile,
    version: "00000000",
  };
}

/** 在 (8,8) tile 生成一个族群节点并按 overrides 覆盖节点字段（测试精确控制参数）。 */
function spawnNode(
  world: GameWorld,
  overrides: Partial<NonNullable<(typeof Population)[number]>>,
  kind = NODE_KIND,
  mapKey = KEY,
): number {
  const archetype = getRegistries().archetypeRegistry.get(kind);
  const eid = spawnEntity(world, archetype, world.components_registry, {
    x: 8 * 16 + 8,
    y: 8 * 16 + 8,
    mapId: mapKey,
  });
  Object.assign(Population[eid]!, overrides);
  return eid;
}

/** 统计世界上某 kind 的实体数。 */
function countKind(world: GameWorld, kind: string): number {
  let n = 0;
  for (const eid of query(world, [Transform])) {
    if (Kind[eid] === kind) n += 1;
  }
  return n;
}

/** 带几何 + seed 的最小世界。 */
function worldWith(areaDen: number, seed: number): GameWorld {
  const world = createBareWorld();
  world.maps[KEY] = makeGeometry(areaDen);
  setMapSeeds(world, { [KEY]: seed });
  return world;
}

describe("① 承载力依赖区域真实面积", () => {
  it("cap = floor(区域面积 × carryingDensity)；改区域面积 → cap 变化", () => {
    const world = worldWith(40, 1);
    const eid = spawnNode(world, {
      carryingDensity: 0.1,
      growthRate: 0,
      growthIntervalTicks: 1,
      count: 0,
      homeRegion: "den",
    });

    world.time.tick = 1;
    populationSystem(world);
    expect(Population[eid]!.cap).toBe(4); // floor(40 × 0.1)

    // 同一节点、同一密度，仅把区域面积换小 → 承载力随之下降
    world.maps[KEY] = makeGeometry(10);
    world.time.tick = 2;
    populationSystem(world);
    expect(Population[eid]!.cap).toBe(1); // floor(10 × 0.1)
  });

  it("regionAreaOf 优先采用 region-stats 写入的 meta.area", () => {
    const geometry = makeGeometry(5);
    geometry.regions.get("den")!.meta.area = 100;
    expect(regionAreaOf(geometry, "den")).toBe(100);
    // 未声明 meta.area 时回退 regionOfTile 逐格计数
    expect(regionAreaOf(geometry, "rest")).toBe(16 * 16 - 5);
    // 未注册区域 → 0
    expect(regionAreaOf(geometry, "nope")).toBe(0);
  });

  it("归属区域空串时由实体所在 tile 惰性解析", () => {
    const world = worldWith(256, 1);
    const eid = spawnNode(world, {
      carryingDensity: 0.5,
      count: 0,
      homeRegion: "",
    });
    world.time.tick = 1;
    populationSystem(world);
    // (8,8) 落在 den（前 256 格全 den，索引 0）
    expect(Population[eid]!.homeRegion).toBe("den");
    expect(Population[eid]!.cap).toBe(128); // floor(256 × 0.5)
  });
});

describe("② 数量按增长率步进且有上限", () => {
  it("整数增长率：每周期确定性 +growthRate，达 cap 后封顶", () => {
    const world = worldWith(200, 1);
    const eid = spawnNode(world, {
      carryingDensity: 0.05, // cap = floor(200 × 0.05) = 10
      growthRate: 2,
      growthIntervalTicks: 5,
      count: 0,
      homeRegion: "den",
    });

    const step = (tick: number): number => {
      world.time.tick = tick;
      populationSystem(world);
      return Population[eid]!.count;
    };

    expect(step(5)).toBe(2);
    expect(step(10)).toBe(4);
    expect(step(15)).toBe(6);
    expect(step(20)).toBe(8);
    expect(step(25)).toBe(10); // 达上限
    expect(step(30)).toBe(10); // 封顶，不再增长
    expect(Population[eid]!.cap).toBe(10);
    expect(Population[eid]!.lastEvolvedTick).toBe(30); // 饱和后推到 target
  });

  it("小数增长率：逐周期经确定性随机流掷骰，结果落在期望带内", () => {
    const seed = 12345;
    const periods = 60;
    const rate = 1.5;
    let expected = 0;
    for (let p = 1; p <= periods; p++) {
      expected += growthForSlot(seed, NODE_KIND, 7, p, rate);
      // 每周期增量 ∈ {1, 2}
      const inc = growthForSlot(seed, NODE_KIND, 7, p, rate);
      expect(inc).toBeGreaterThanOrEqual(1);
      expect(inc).toBeLessThanOrEqual(2);
    }
    // 确定性：重复调用同周期得到同值
    expect(growthForSlot(seed, NODE_KIND, 7, 3, rate)).toBe(
      growthForSlot(seed, NODE_KIND, 7, 3, rate),
    );
    // 落在 [1, 2] × periods 区间
    expect(expected).toBeGreaterThanOrEqual(periods);
    expect(expected).toBeLessThanOrEqual(periods * 2);
  });
});

describe("③ 离线等价性：快进 ≡ 逐 tick（核心断言）", () => {
  const spec = {
    carryingDensity: 0.05, // cap = floor(256 × 0.05) = 12
    growthRate: 1.3,
    growthIntervalTicks: 4,
    count: 0,
    homeRegion: "den",
    spawnInstances: false,
  } as const;

  function runFastForward(targetTick: number) {
    const world = worldWith(256, 7);
    const eid = spawnNode(world, spec);
    world.time.tick = targetTick;
    fastForwardPopulations(world, targetTick);
    return populationSnapshot(eid);
  }

  function runTickByTick(targetTick: number) {
    const world = worldWith(256, 7);
    const eid = spawnNode(world, spec);
    for (let t = 1; t <= targetTick; t++) {
      world.time.tick = t;
      populationSystem(world);
    }
    return populationSnapshot(eid);
  }

  it("中途（tick 23，槽未对齐）：快进 ≡ 逐 tick", () => {
    const ff = runFastForward(23);
    const tb = runTickByTick(23);
    expect(ff).toEqual(tb);
    expect(ff!.cap).toBe(12);
    expect(ff!.count).toBeGreaterThan(0);
    expect(ff!.count).toBeLessThan(12); // 未饱和
  });

  it("精确落在槽边界（tick 20）：快进 ≡ 逐 tick", () => {
    expect(runFastForward(20)).toEqual(runTickByTick(20));
  });

  it("长跨度（tick 10000，已饱和早退）：快进 ≡ 逐 tick", () => {
    const ff = runFastForward(10_000);
    const tb = runTickByTick(10_000);
    expect(ff).toEqual(tb);
    expect(ff!.count).toBe(12); // 饱和
    expect(ff!.lastEvolvedTick).toBe(10_000);
  });

  it("分段快进 ≡ 一次快进（时间可结合性）", () => {
    const world = worldWith(256, 7);
    const eid = spawnNode(world, spec);
    fastForwardPopulations(world, 23);
    fastForwardPopulations(world, 57);
    expect(populationSnapshot(eid)).toEqual(runFastForward(57));
  });
});

describe("④ 序列化 → 恢复后节点状态正确", () => {
  it("节点随实体入档；恢复后状态与存档一致", () => {
    const world1 = worldWith(200, 3);
    const eid1 = spawnNode(world1, {
      carryingDensity: 0.05,
      growthRate: 1.5,
      growthIntervalTicks: 3,
      count: 0,
      homeRegion: "den",
    });
    world1.time.tick = 17;
    populationSystem(world1);
    const expected = populationSnapshot(eid1)!;
    expect(expected.count).toBeGreaterThan(0);

    const record = serializeWorld(world1, "pop");
    const saved = record.entities.find((e) => e.kind === NODE_KIND)!;
    expect(saved.components.Population).toEqual(expected);

    const world2 = worldWith(200, 3);
    restoreWorld(world2, record);
    const eid2 = query(world2, [NetworkId]).find((e) => Kind[e] === NODE_KIND)!;
    expect(Population[eid2]).toEqual(expected);
    // 稳定身份是 NetworkId 而非 eid：两个 world 都是全新创建，eid 会复用，
    // 跨世界断言 eid 相等/不等没有意义；NetworkId 相等才说明身份随档保留。
    expect(NetworkId.value[eid2]).toEqual(NetworkId.value[eid1]);
  });
});

describe("⑤ 确定性：同种子重复运行一致", () => {
  function run(seed: number, targetTick: number) {
    const world = worldWith(256, seed);
    const eid = spawnNode(world, {
      carryingDensity: 1,
      growthRate: 0.5,
      growthIntervalTicks: 1,
      count: 0,
      homeRegion: "den",
    });
    for (let t = 1; t <= targetTick; t++) {
      world.time.tick = t;
      populationSystem(world);
    }
    return populationSnapshot(eid);
  }

  it("同世界同种子重复运行结果逐位一致", () => {
    expect(run(11, 200)).toEqual(run(11, 200));
  });

  it("异种子产生不同序列（随机流的确参与步进）", () => {
    expect(run(11, 200)).not.toEqual(run(12, 200));
  });
});

describe("⑥ 来源被移除（巢穴销毁）后不再产出（最小生产通路停产）", () => {
  it("巢被销毁 → Population 条目消失 → 后续 tick 不再产出", () => {
    const world = worldWith(256, 5);
    const nestEid = spawnNode(
      world,
      {
        species: PREY_SRC_KIND,
        carryingDensity: 0.05,
        growthRate: 0,
        growthIntervalTicks: 1,
        count: 2,
        homeRegion: "den",
        spawnInstances: true, // 开启最小生产通路
      },
      NODE_KIND,
    );

    world.time.tick = 1;
    populationSystem(world);
    const spawned = countKind(world, PREY_SRC_KIND);
    expect(spawned).toBeGreaterThan(0);
    expect(spawned).toBeLessThanOrEqual(2);

    // 捣毁巢穴：AoS 残留清理 → 节点消失 → 该处永久停产
    destroyEntity(world, nestEid);
    expect(Population[nestEid]).toBeUndefined();

    for (let t = 2; t <= 40; t++) {
      world.time.tick = t;
      populationSystem(world);
    }
    expect(countKind(world, PREY_SRC_KIND)).toBe(spawned);
  });
});

describe("配置校验 fail-fast", () => {
  it("species 缺失/空串 → 抛错（初始化钩子）", () => {
    const world = createBareWorld();
    expect(() => {
      getRegistries().componentRegistry.getAosInitializer("Population")!(world, 0, {});
    }).toThrow(/non-empty "species"/);
  });

  it("growthIntervalTicks 非法 → 钳到 1；负 carryingDensity → 0", () => {
    const world = createBareWorld();
    const eid = 999;
    Population[eid] = undefined;
    getRegistries().componentRegistry.getAosInitializer("Population")!(world, eid, {
      species: "x",
      growthIntervalTicks: 0,
      carryingDensity: -5,
      growthRate: undefined,
    });
    expect(Population[eid]!.growthIntervalTicks).toBe(1);
    expect(Population[eid]!.carryingDensity).toBe(0);
    expect(Population[eid]!.growthRate).toBe(0);
    Population[eid] = undefined;
  });
});

describe("GameSimulation.runOfflineCatchUp 挂载点（真配置读档 + 离线补差）", () => {
  const DT_MS = 50;
  const SAVE_TICK = 100;
  const OFFLINE_TICKS = 100;
  const SIM_KEY = "popsim";
  const SIM_NODE = "sim_pop_node";
  const SIM_PREY = "sim_prey";

  function buildSimDef(): LoadedGameDefinition {
    const def = createDefaultGameDefinition();
    def.systems = [{ id: "population" }];
    def.resolvedEntities = [
      {
        kind: SIM_NODE,
        components: {
          Population: {
            species: SIM_PREY,
            carryingDensity: 1,
            growthRate: 1.5,
            growthIntervalTicks: 5,
            homeRegion: "den",
            count: 0,
          },
        },
      },
    ];
    def.resolvedMapConfigs = [
      {
        key: SIM_KEY,
        seed: 9,
        initialAgeTicks: 0,
        pipeline: [
          {
            generator: "noise-terrain",
            params: {
              width: 16,
              height: 16,
              tileWidth: 16,
              tileHeight: 16,
              bandLevel: 1,
              groundPalette: { "1": 1 },
              nonWalkableSemantics: [],
            },
          },
          { generator: "climate-regions", params: { names: ["den"], style: "noise" } },
        ],
      },
    ];
    return def;
  }

  function simWorld(sim: SimulationPort): GameWorld {
    return (sim as unknown as { world: GameWorld }).world;
  }

  function nodeSnapshot(world: GameWorld) {
    const eid = query(world, [NetworkId]).find((e) => Kind[e] === SIM_NODE)!;
    return populationSnapshot(eid);
  }

  async function loadSim(def: LoadedGameDefinition, record: unknown, offlineTicks: number) {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime((record as { savedAt: number }).savedAt + offlineTicks * DT_MS);
    const sim = await createGameSimulation(def, {
      repository: memoryRepository(record as never),
      saveId: "pop-offline",
    });
    vi.useRealTimers();
    return sim;
  }

  it("读档 + 离线快进 ≡ 读档 + 连续运行同跨度（节点状态一致）", async () => {
    const def = buildSimDef();

    // 世界 1：生成节点 → 推进到 SAVE_TICK → 存档
    const sim1 = await createGameSimulation(def);
    const world1 = simWorld(sim1);
    const node1 = spawnEntity(world1, world1.archetypes.get(SIM_NODE), world1.components_registry);
    world1.time.tick = SAVE_TICK;
    populationSystem(world1);
    const record = serializeWorld(world1, "pop-offline");
    expect(node1).toBeGreaterThanOrEqual(0);

    // 路径 A：读档 + 离线补差（fastForwardPopulations 到 SAVE_TICK+OFFLINE）
    const simOffline = await loadSim(def, record, OFFLINE_TICKS);
    const worldOffline = simWorld(simOffline);
    expect(worldOffline.time.tick).toBe(SAVE_TICK + OFFLINE_TICKS);
    const offlineState = nodeSnapshot(worldOffline); // 先快照，隔离跨 world 全局 AoS 干扰

    // 路径 B：零补差读档 + 连续 OFFLINE 个运行 tick
    const simContinuous = await loadSim(def, record, 0);
    const worldContinuous = simWorld(simContinuous);
    for (let i = 0; i < OFFLINE_TICKS; i++) simContinuous.tick(DT_MS);

    const continuousState = nodeSnapshot(worldContinuous);
    expect(offlineState).toEqual(continuousState);
    expect(offlineState!.count).toBeGreaterThan(0);
    expect(offlineState!.lastEvolvedTick).toBe(SAVE_TICK + OFFLINE_TICKS);
  });
});
