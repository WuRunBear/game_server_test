/**
 * 离线补差接线测试（持久化切换 todo）。
 *
 * 覆盖（I3 单元面，等价断言范围按计划声明收窄到无 condition 规则）：
 * - 等价性：存档 tick T → 离线一次 evolve(T, T+N] ≡ 连续 N 个运行 tick
 *   （每 tick evolve(T+i, T+i+1]）——无 condition 规则的实体数量与位置逐一一致；
 * - condition 规则（isNight）按恢复相位求值：白天相位零补种、夜晚相位补种
 *   且不越上限（U3 仍成立）；
 * - tick 边界：补差后 world.time.tick === 存档tick + 离线ticks 精确落点，
 *   下一运行 tick 恰 +1（不重走离线跨度）；now ≤ savedAt 零补差。
 *
 * 确定性手段：
 * - vi.setSystemTime 控制 Date.now（生产代码只在装配处读一次墙钟）；
 * - 合成 8×8 单区域图 + 静态原型（无 Velocity/AIState/Collider）——
 *   系统层不移动/不增删实体，两条路径的占用集演化完全一致。
 */
import { describe, it, expect, beforeAll, beforeEach, vi, afterEach } from "vitest";
import { query } from "bitecs";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  bootstrapFramework,
  createDefaultGameDefinition,
  createGameSimulation,
  serializeWorld,
} from "framework/index";
import { createFileRepository } from "framework/persistence/fileRepository";
import { destroyEntity } from "framework/entities/destroyEntity";
import { spawnEntity } from "framework/entities/spawn";
import { Kind } from "framework/components/kind";
import { Transform } from "framework/components/transform";
import { PHASE_NIGHT } from "framework/world";
import { memoryRepository } from "./helpers/persistence";
import type { LoadedGameDefinition } from "framework/config/schema/GameDefinitionSchema";
import type { WorldRecord } from "framework/repository";
import type { GameWorld } from "framework/world";
import type { SimulationPort } from "simulation";

beforeAll(() => {
  bootstrapFramework();
});

afterEach(() => {
  vi.useRealTimers();
});

const TICK_RATE = 20;
const DT_MS = 1000 / TICK_RATE;
const INITIAL_AGE = 1000;
const OFFLINE_TICKS = 100;
const MAP_KEY = "testmap";
const KIND_STATIC = "stub";
const KIND_NIGHT = "nightstub";

/** 合成定义：8×8 全可走单命名区域图 + 静态原型 + 无条件/isNight 各一条 density 规则。 */
function buildSyntheticDef(): LoadedGameDefinition {
  const def = createDefaultGameDefinition();
  def.resolvedEntities = [
    { kind: KIND_STATIC, components: {} },
    { kind: KIND_NIGHT, components: {} },
  ];
  def.resolvedMapConfigs = [
    {
      key: MAP_KEY,
      seed: 42,
      initialAgeTicks: INITIAL_AGE,
      pipeline: [
        {
          generator: "noise-terrain",
          params: {
            width: 8,
            height: 8,
            tileWidth: 16,
            tileHeight: 16,
            bandLevel: 1,
            groundPalette: { "1": 1 },
            nonWalkableSemantics: [],
          },
        },
        { generator: "climate-regions", params: { names: ["alpha"], style: "noise" } },
      ],
    },
  ];
  def.resolvedEntityRules = [
    { map: MAP_KEY, region: "alpha", kind: KIND_STATIC, max: 5, every: 10, mode: "density" },
    {
      map: MAP_KEY,
      region: "alpha",
      kind: KIND_NIGHT,
      max: 4,
      every: 10,
      mode: "density",
      condition: "isNight",
    },
  ];
  return def;
}

function simWorld(sim: SimulationPort): GameWorld {
  return (sim as unknown as { world: GameWorld }).world;
}

function countOf(world: GameWorld, kind: string): number {
  let n = 0;
  for (const eid of query(world, [Transform])) {
    if (Kind[eid] === kind) n += 1;
  }
  return n;
}

/** 某图某 kind 实体的 tile 坐标（排序后逐实体比较）。 */
function tilePositionsOf(world: GameWorld, mapKey: string, kind: string): string[] {
  const geometry = world.maps[mapKey];
  const out: string[] = [];
  for (const eid of query(world, [Transform])) {
    if (Kind[eid] !== kind) continue;
    const tx = Math.floor(Transform.x[eid] / geometry.grid.tileWidth);
    const ty = Math.floor(Transform.y[eid] / geometry.grid.tileHeight);
    out.push(`${tx},${ty}`);
  }
  return out.sort();
}

/** 以存档时刻为基准拨墙钟，构造离线 N tick 的读档仿真（墙钟只在装配处读一次）。 */
async function loadWithOfflineTicks(
  def: LoadedGameDefinition,
  record: WorldRecord,
  offlineTicks: number,
): Promise<SimulationPort> {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(record.savedAt + offlineTicks * DT_MS);
  const sim = await createGameSimulation(def, {
    repository: memoryRepository(record),
    saveId: "catchup",
  });
  vi.useRealTimers();
  return sim;
}

describe("offline catch-up（离线补差）", () => {
  it("I3/U2：离线一次推演 ≡ 连续运行同跨度（无 condition 规则的数量与位置逐一一致）", async () => {
    const def = buildSyntheticDef();
    const sim1 = await createGameSimulation(def);
    const world1 = simWorld(sim1);
    expect(world1.time.tick).toBe(INITIAL_AGE);

    // 初始演化已把 stub 补到 max=5 → 拆掉 2 个制造补种需求（存档 count=3 < max）
    const stubs = query(world1, [Transform]).filter((eid) => Kind[eid] === KIND_STATIC);
    expect(stubs.length).toBe(5);
    destroyEntity(world1, stubs[0]);
    destroyEntity(world1, stubs[1]);

    const record = serializeWorld(world1, "catchup");
    expect(record.tick).toBe(INITIAL_AGE);

    // 路径 A：读档 + 离线补差（一次 evolve (T, T+N]）
    const simOffline = await loadWithOfflineTicks(def, record, OFFLINE_TICKS);

    // 路径 B：零补差读档 + 连续 N 个运行 tick（每 tick evolve (t-1, t]）
    const simContinuous = await loadWithOfflineTicks(def, record, 0);
    for (let i = 0; i < OFFLINE_TICKS; i++) simContinuous.tick(DT_MS);

    // 无 condition 规则：数量与位置逐一一致（I3 适用范围内断言等价）
    const offlineTiles = tilePositionsOf(simWorld(simOffline), MAP_KEY, KIND_STATIC);
    expect(offlineTiles).toHaveLength(5);
    expect(offlineTiles).toEqual(tilePositionsOf(simWorld(simContinuous), MAP_KEY, KIND_STATIC));
  });

  it("I3：condition 规则按恢复相位求值：白天相位离线补差零补种（计数不变且不越上限）", async () => {
    const def = buildSyntheticDef();
    const sim1 = await createGameSimulation(def);
    const world1 = simWorld(sim1);
    // 初始演化在白天相位（world 初始 phase=DAY）→ nightstub 零产出；
    // 手工放置 2 个入档（模拟存档既有实体）
    expect(countOf(world1, KIND_NIGHT)).toBe(0);
    const archetype = world1.archetypes.get(KIND_NIGHT);
    spawnEntity(world1, archetype, world1.components_registry, { x: 8, y: 8, mapId: MAP_KEY });
    spawnEntity(world1, archetype, world1.components_registry, { x: 24, y: 8, mapId: MAP_KEY });

    const record = serializeWorld(world1, "catchup");
    const sim2 = await loadWithOfflineTicks(def, record, OFFLINE_TICKS);

    // 恢复相位 = 白天 → isNight 对整个离线跨度恒假 → 零补种；计数不变且 ≤ max
    expect(countOf(simWorld(sim2), KIND_NIGHT)).toBe(2);
    expect(countOf(simWorld(sim2), KIND_NIGHT)).toBeLessThanOrEqual(4);
  });

  it("I3/U3：condition 规则按恢复相位求值：夜晚相位补种且不越上限（U3）", async () => {
    const def = buildSyntheticDef();
    const sim1 = await createGameSimulation(def);
    const world1 = simWorld(sim1);
    expect(countOf(world1, KIND_NIGHT)).toBe(0);
    // 相位拨到夜晚后入档 → 恢复相位 = 夜晚 → isNight 对整个离线跨度恒真
    world1.time.timeOfDay = { hour: 22, phase: PHASE_NIGHT };
    const record = serializeWorld(world1, "catchup");

    const sim2 = await loadWithOfflineTicks(def, record, OFFLINE_TICKS);

    // 离线跨度含 10 个 every=10 槽位 → 补种发生但不越 max=4
    const count = countOf(simWorld(sim2), KIND_NIGHT);
    expect(count).toBeGreaterThan(0);
    expect(count).toBeLessThanOrEqual(4);
  });

  it("I3：补差后 tick 精确落在演化边界，下一运行 tick 恰 +1（不重走离线跨度）", async () => {
    const def = buildSyntheticDef();
    const sim1 = await createGameSimulation(def);
    const record = serializeWorld(simWorld(sim1), "catchup");

    const sim2 = await loadWithOfflineTicks(def, record, OFFLINE_TICKS);
    const world2 = simWorld(sim2);
    expect(world2.time.tick).toBe(record.tick + OFFLINE_TICKS);

    const result = sim2.tick(DT_MS);
    expect(result.tick).toBe(record.tick + OFFLINE_TICKS + 1);
  });

  it("I3：now ≤ savedAt（时钟回拨）零补差：tick 保持存档值，下一运行 tick 恰 +1", async () => {
    const def = buildSyntheticDef();
    const sim1 = await createGameSimulation(def);
    const record = serializeWorld(simWorld(sim1), "catchup");

    const sim2 = await loadWithOfflineTicks(def, record, 0);
    const world2 = simWorld(sim2);
    expect(world2.time.tick).toBe(record.tick);

    const result = sim2.tick(DT_MS);
    expect(result.tick).toBe(record.tick + 1);
  });
});

describe("I3：fileRepository 真实磁盘往返 + 离线补差一致性", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "i3-file-repo-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
    vi.useRealTimers();
  });

  it("存档经 fileRepository 落盘 → 重启真实磁盘读档 + 离线补差 ≡ 连续运行（无 condition 规则）", async () => {
    const def = buildSyntheticDef();
    const repo = createFileRepository(tmpDir);

    // 首次开机：bootMaps 组装的首个 WorldRecord 经装配通道落盘（真实磁盘写）
    const sim1 = await createGameSimulation(def, { repository: repo, saveId: "i3-disk" });
    const world1 = simWorld(sim1);
    expect(world1.time.tick).toBe(INITIAL_AGE);
    const stubs = query(world1, [Transform]).filter((eid) => Kind[eid] === KIND_STATIC);
    expect(stubs.length).toBe(5);

    // 砍掉 2 个制造补种需求，再显式走一次真实磁盘写（临时文件 + rename 原子替换）
    destroyEntity(world1, stubs[0]);
    destroyEntity(world1, stubs[1]);
    const record = serializeWorld(world1, "i3-disk");
    await repo.saveWorld(record);
    expect(existsSync(join(tmpDir, "i3-disk.json"))).toBe(true);

    // 路径 A：真实磁盘读 + 离线补差（墙钟只在装配处读一次）
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(record.savedAt + OFFLINE_TICKS * DT_MS);
    const simOffline = await createGameSimulation(def, { repository: repo, saveId: "i3-disk" });
    vi.useRealTimers();

    // 路径 B：真实磁盘读 + 零补差 + 连续 N 个运行 tick
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(record.savedAt);
    const simContinuous = await createGameSimulation(def, { repository: repo, saveId: "i3-disk" });
    vi.useRealTimers();
    for (let i = 0; i < OFFLINE_TICKS; i++) simContinuous.tick(DT_MS);

    // 无 condition 规则：数量与位置逐一一致（I3 适用范围内断言等价）
    const offlineTiles = tilePositionsOf(simWorld(simOffline), MAP_KEY, KIND_STATIC);
    expect(offlineTiles).toHaveLength(5);
    expect(offlineTiles).toEqual(tilePositionsOf(simWorld(simContinuous), MAP_KEY, KIND_STATIC));
  });
});
