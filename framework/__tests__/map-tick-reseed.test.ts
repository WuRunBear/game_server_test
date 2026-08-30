/**
 * I2 tick 演化补种（HeadlessHost 驱动，真实演化接线）。
 *
 * 场景：砍树（销毁实体）→ 计数低于 max → 到下一个 every 周期边界时
 * 确定性补种。断言三段：
 * - 边界门控：周期边界之前不补种（不是即时复活）；
 * - 边界补种：every=10 的下一个槽位（绝对对齐）恰补 1 个，计数回到 max；
 * - 确定性：同 seed 同场景两次运行，补种落点逐一一致（U4 选点纯函数的
 *   运行时面）。
 *
 * 合成定义：16×16 全可走单区域图 + 无组件 stub 原型（系统层不移动/不增删，
 * 占用集只受销毁与补种影响）。
 */
import { describe, it, expect, beforeAll } from "vitest";
import { query } from "bitecs";
import {
  bootstrapFramework,
  createDefaultGameDefinition,
  createGameSimulation,
  runHeadless,
} from "framework/index";
import { destroyEntity } from "framework/entities/destroyEntity";
import { Kind } from "framework/components/kind";
import { Transform } from "framework/components/transform";
import type { LoadedGameDefinition } from "framework/config/schema/GameDefinitionSchema";
import type { GameWorld } from "framework/world";
import type { SimulationPort } from "simulation";

beforeAll(() => {
  bootstrapFramework();
});

const MAP_KEY = "i2-map";
const TREE = "i2-tree";
const INITIAL_AGE = 1000;
const EVERY = 10;
const MAX = 3;
const DT_MS = 50;

function buildDef(): LoadedGameDefinition {
  const def = createDefaultGameDefinition();
  def.resolvedEntities = [{ kind: TREE, components: {} }];
  def.resolvedMapConfigs = [
    {
      key: MAP_KEY,
      seed: 77,
      initialAgeTicks: INITIAL_AGE,
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
        { generator: "climate-regions", params: { names: ["alpha"], style: "noise" } },
      ],
    },
  ];
  def.resolvedEntityRules = [
    { map: MAP_KEY, region: "alpha", kind: TREE, max: MAX, every: EVERY, mode: "density" },
  ];
  return def;
}

function simWorld(sim: SimulationPort): GameWorld {
  return (sim as unknown as { world: GameWorld }).world;
}

function countKind(world: GameWorld, kind: string): number {
  let n = 0;
  for (const eid of query(world, [Transform])) {
    if (Kind[eid] === kind) n += 1;
  }
  return n;
}

function tilePositionsOf(world: GameWorld, mapKey: string, kind: string): string[] {
  const geometry = world.maps[mapKey]!;
  const out: string[] = [];
  for (const eid of query(world, [Transform])) {
    if (Kind[eid] !== kind) continue;
    out.push(`${Math.floor(Transform.x[eid] / geometry.grid.tileWidth)},${Math.floor(Transform.y[eid] / geometry.grid.tileHeight)}`);
  }
  return out.sort();
}

/** 完整场景一次：开机 → 砍 1 棵 → 推进到下一周期边界 → 返回（终态 world, 砍前坐标集）。 */
async function runScenario() {
  const sim = await createGameSimulation(buildDef());
  const world = simWorld(sim);
  expect(world.time.tick).toBe(INITIAL_AGE);
  expect(countKind(world, TREE)).toBe(MAX);

  const beforeCut = tilePositionsOf(world, MAP_KEY, TREE);
  destroyEntity(world, query(world, [Transform]).find((eid) => Kind[eid] === TREE)!);
  expect(countKind(world, TREE)).toBe(MAX - 1);

  // 周期边界前：every=10，下一槽位 = 1010；推进 9 tick 不补种
  const results = runHeadless(sim, { tickCount: EVERY - 1, dtMs: DT_MS });
  expect(results).toHaveLength(EVERY - 1);
  expect(world.time.tick).toBe(INITIAL_AGE + EVERY - 1);
  expect(countKind(world, TREE)).toBe(MAX - 1);

  // 边界 tick：evolve (1009, 1010] 覆盖槽位 1010 → 恰补 1 棵
  const boundary = sim.tick(DT_MS);
  expect(boundary.tick).toBe(INITIAL_AGE + EVERY);
  expect(countKind(world, TREE)).toBe(MAX);

  return { world, beforeCut };
}

describe("I2 tick 演化补种（砍树 → 周期边界确定性补种）", () => {
  it("I2：低于 max 到周期边界才补种，且补种后计数回到 max", async () => {
    await runScenario();
  });

  it("I2：同 seed 两次运行补种落点逐一一致（确定性补种）", async () => {
    const run1 = await runScenario();
    const run2 = await runScenario();

    const after1 = tilePositionsOf(run1.world, MAP_KEY, TREE);
    const after2 = tilePositionsOf(run2.world, MAP_KEY, TREE);
    expect(after2).toEqual(after1);
    // 补种恰新增 1 个落点（其余两棵原位保留）
    const added = after1.filter((p) => !run1.beforeCut.includes(p));
    expect(added).toHaveLength(1);
  });
});
