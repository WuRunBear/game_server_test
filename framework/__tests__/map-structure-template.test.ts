/**
 * U7 结构模板（template 规则）集成面：真实 spawn 链 + 真实存档往返。
 *
 * 覆盖：
 * - 确定性成组：同 seed 两次开机 → 模板组（墙×3 + 地板×1 + 门×1，共 5 实体）
 *   落点逐一一致（同 seed 同 timeSlot 同位置）；
 * - 拆一块 → 存 → 读 → 演化不补全：拆除一个非锚实体后存档，读档 + 离线补差
 *   后组保持已拆状态——锚 kind 计数已满（max），演化不复活缺失件，
 *   存档状态胜出（U4 占用语义的存档面）。
 *
 * 模板规则是测试夹具（不进 game 配置）：锚 kind = 门（模板中恰出现一次，
 * 引擎按锚计数）；原型为无组件 stub，排除系统层移动对占用的扰动。
 * 地图用 tiled-source 单区域全覆盖（而非 noise-terrain + climate-regions）：
 * 模板偏移格不受规则区域约束，而锚计数按区域统计——若锚偏移落出区域，
 * 每次 evolve 调用都会误判「低于 max」而再加一组（潜在引擎语义缺口，已另报）；
 * 全图单区域使锚恒在区域内，钉住本场景的计划语义。
 */
import { describe, it, expect, beforeAll, vi, afterEach } from "vitest";
import { query } from "bitecs";
import {
  bootstrapFramework,
  createDefaultGameDefinition,
  createGameSimulation,
  serializeWorld,
} from "framework/index";
import { destroyEntity } from "framework/entities/destroyEntity";
import { Kind } from "framework/components/kind";
import { Transform } from "framework/components/transform";
import { memoryRepository } from "./helpers/persistence";
import type { LoadedGameDefinition } from "framework/config/schema/GameDefinitionSchema";
import type { GameWorld } from "framework/world";
import type { SimulationPort } from "simulation";

beforeAll(() => {
  bootstrapFramework();
});

afterEach(() => {
  vi.useRealTimers();
});

const MAP_KEY = "u7-map";
const WALL = "u7-wall";
const FLOOR = "u7-floor";
const DOOR = "u7-door";
const INITIAL_AGE = 1000;
const OFFLINE_TICKS = 100;
const DT_MS = 50;

/** 16×16 / 16px 全图单 zone 的内联 Tiled JSON：每格中心都落在矩形内 → 全图同区域。 */
function fullCoverTiledJson(): Record<string, unknown> {
  return {
    width: 16,
    height: 16,
    tilewidth: 16,
    tileheight: 16,
    layers: [
      {
        type: "objectgroup",
        name: "zones",
        objects: [
          {
            id: 1,
            type: "zone",
            name: "alpha",
            x: 0,
            y: 0,
            width: 256,
            height: 256,
            properties: [{ name: "zoneId", type: "int", value: 1 }],
          },
        ],
      },
    ],
  };
}

/** 合成定义：全图单区域图 + 墙/地板/门 stub 原型 + 门锚模板规则（max=1 组）。 */
function buildTemplateDef(): LoadedGameDefinition {
  const def = createDefaultGameDefinition();
  def.resolvedEntities = [
    { kind: WALL, components: {} },
    { kind: FLOOR, components: {} },
    { kind: DOOR, components: {} },
  ];
  def.resolvedMapConfigs = [
    {
      key: MAP_KEY,
      seed: 4242,
      initialAgeTicks: INITIAL_AGE,
      pipeline: [{ generator: "tiled-source", params: { tiled: fullCoverTiledJson() } }],
    },
  ];
  def.resolvedEntityRules = [
    {
      map: MAP_KEY,
      region: "alpha",
      kind: DOOR,
      max: 1,
      every: 10,
      mode: "template",
      template: [
        { kind: WALL, dx: 0, dy: 0 },
        { kind: WALL, dx: 1, dy: 0 },
        { kind: WALL, dx: 0, dy: 1 },
        { kind: FLOOR, dx: 1, dy: 1 },
        { kind: DOOR, dx: 2, dy: 0 },
      ],
    },
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

/** 某图某 kind 全部实体的 tile 坐标（排序后可比）。 */
function tilePositionsOf(world: GameWorld, mapKey: string, kind: string): string[] {
  const geometry = world.maps[mapKey]!;
  const out: string[] = [];
  for (const eid of query(world, [Transform])) {
    if (Kind[eid] !== kind) continue;
    out.push(`${Math.floor(Transform.x[eid] / geometry.grid.tileWidth)},${Math.floor(Transform.y[eid] / geometry.grid.tileHeight)}`);
  }
  return out.sort();
}

describe("U7 结构模板（真实链路集成）", () => {
  it("U7：同 seed 两次开机模板组成组创建，落点逐一一致（同 seed 同 timeSlot 同位置）", async () => {
    const sim1 = await createGameSimulation(buildTemplateDef());
    const sim2 = await createGameSimulation(buildTemplateDef());

    for (const world of [simWorld(sim1), simWorld(sim2)]) {
      expect(countKind(world, WALL)).toBe(3);
      expect(countKind(world, FLOOR)).toBe(1);
      expect(countKind(world, DOOR)).toBe(1);
    }

    expect(tilePositionsOf(simWorld(sim2), MAP_KEY, WALL)).toEqual(tilePositionsOf(simWorld(sim1), MAP_KEY, WALL));
    expect(tilePositionsOf(simWorld(sim2), MAP_KEY, FLOOR)).toEqual(tilePositionsOf(simWorld(sim1), MAP_KEY, FLOOR));
    expect(tilePositionsOf(simWorld(sim2), MAP_KEY, DOOR)).toEqual(tilePositionsOf(simWorld(sim1), MAP_KEY, DOOR));

    // 模板相对偏移成立：门 = 原点墙 + (2,0)，原点墙 = 同时有右邻墙与下邻墙的那面墙
    const walls = tilePositionsOf(simWorld(sim1), MAP_KEY, WALL).map((p) => p.split(",").map(Number));
    const origin = walls.find(
      ([x, y]) =>
        walls.some(([wx, wy]) => wx === x + 1 && wy === y) && walls.some(([wx, wy]) => wx === x && wy === y + 1),
    );
    expect(origin).toBeDefined();
    const doors = tilePositionsOf(simWorld(sim1), MAP_KEY, DOOR).map((p) => p.split(",").map(Number));
    expect(doors).toContainEqual([origin![0] + 2, origin![1]]);
  });

  it("U7：拆一块 → 存 → 读 → 演化不补全（存档状态胜出，组保持已拆）", async () => {
    const def = buildTemplateDef();
    const sim1 = await createGameSimulation(def);
    const world1 = simWorld(sim1);
    expect(countKind(world1, WALL)).toBe(3);

    // 拆除一个非锚实体（墙）：锚（门）计数仍 = max → 演化无补全需求
    const wallEid = query(world1, [Transform]).find((eid) => Kind[eid] === WALL)!;
    destroyEntity(world1, wallEid);
    expect(countKind(world1, WALL)).toBe(2);

    const record = serializeWorld(world1, "u7-dismantled");
    expect(record.tick).toBe(INITIAL_AGE);

    // 读档 + 离线补差（墙钟拨到 savedAt + N tick，生产代码只在装配处读一次）
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(record.savedAt + OFFLINE_TICKS * DT_MS);
    const sim2 = await createGameSimulation(def, {
      repository: memoryRepository(record),
      saveId: "u7-dismantled",
    });
    vi.useRealTimers();
    const world2 = simWorld(sim2);

    // 组保持已拆：墙不复活为 3，其余件原位保留；演化零新增
    expect(countKind(world2, WALL)).toBe(2);
    expect(countKind(world2, FLOOR)).toBe(1);
    expect(countKind(world2, DOOR)).toBe(1);
    expect(tilePositionsOf(world2, MAP_KEY, FLOOR)).toEqual(tilePositionsOf(world1, MAP_KEY, FLOOR));
    expect(tilePositionsOf(world2, MAP_KEY, DOOR)).toEqual(tilePositionsOf(world1, MAP_KEY, DOOR));
    expect(tilePositionsOf(world2, MAP_KEY, WALL)).toEqual(tilePositionsOf(world1, MAP_KEY, WALL));
  });
});
