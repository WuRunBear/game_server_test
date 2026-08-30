/**
 * 持久化切换测试（快照入档）：serializeWorld ↔ restoreWorld 往返与完整性锚。
 *
 * 覆盖：
 * - save→load 往返（真实 game 配置）：world.maps 深相等（经 bootMaps
 *   deserializeGeometry 回填路径——boot.ts 消费 record.maps 的真实方式）、
 *   tick/timeOfDay/savedAt 一致、实体组件按 networkId 逐一还原一致；
 * - 存档为纯 JSON（maps 内嵌后仍可安全 stringify/parse，fileRepository 负载前提）；
 * - 快照截断/缺字段 → 启动抛结构错误，绝不静默加载（完整性锚）。
 *
 * 确定性：往返用例把 savedAt 拨到未来 → 离线折算为 0（computeOfflineTicks
 * 契约），不引入补差实体，实体集合恒等可比。
 */
import { describe, it, expect, beforeAll } from "vitest";
import {
  bootstrapFramework,
  loadGameDefinition,
  createGameSimulation,
  serializeWorld,
} from "framework/index";
import { serializeGeometry } from "map/geometry/snapshot";
import { memoryRepository } from "./helpers/persistence";
import type { WorldRecord } from "framework/repository";
import type { LoadedGameDefinition } from "framework/config/schema/GameDefinitionSchema";
import type { GameWorld } from "framework/world";
import type { SimulationPort } from "simulation";

beforeAll(() => {
  bootstrapFramework();
});

function simWorld(sim: SimulationPort): GameWorld {
  return (sim as unknown as { world: GameWorld }).world;
}

/** 全套共享一次真实配置开机（生成+初始演化成本高，用例间只读复用快照）。 */
const suite: { def: LoadedGameDefinition; record: WorldRecord } = {} as never;

beforeAll(async () => {
  suite.def = loadGameDefinition({ gameJsonPath: "game/game.json" });
  const sim1 = await createGameSimulation(suite.def);
  suite.record = serializeWorld(simWorld(sim1), "rt");
});

describe("worldSerializer 快照入档", () => {
  it("I3：save→load 往返：maps 深相等（bootMaps 回填路径）、tick/timeOfDay/savedAt 一致、实体组件还原一致", async () => {
    const record = suite.record;
    // 快照含全部配置图
    const configKeys = suite.def.resolvedMapConfigs.map((c) => c.key);
    expect(Object.keys(record.maps ?? {}).sort()).toEqual([...configKeys].sort());

    // 纯 JSON：maps 内嵌后仍可安全 stringify/parse（模拟文件仓储负载往返）
    const revived = JSON.parse(JSON.stringify(record)) as WorldRecord;
    // savedAt 拨到未来 → 离线折算为 0（确定性往返，不引入补差实体）
    revived.savedAt = Date.now() + 3_600_000;

    const sim2 = await createGameSimulation(suite.def, {
      repository: memoryRepository(revived),
      saveId: "rt",
    });
    const world2 = simWorld(sim2);

    // world.maps 深相等（经 bootMaps deserializeGeometry 回填）且全部常驻激活
    for (const [key, snapshot] of Object.entries(revived.maps ?? {})) {
      expect(world2.maps[key]).toBeDefined();
      expect(serializeGeometry(world2.maps[key])).toEqual(snapshot);
      expect(world2.activeMaps.has(key)).toBe(true);
    }

    // 全局时刻一致
    expect(world2.time.tick).toBe(revived.tick);
    expect(world2.time.timeOfDay).toEqual(revived.timeOfDay);
    expect(world2.nextNetworkId).toBe(revived.nextNetworkId);

    // 实体组件按 networkId 逐一还原一致（kind + 全部持久化组件；无补差实体 → 集合恒等）
    const restored = serializeWorld(world2, "rt2").entities;
    expect(restored.length).toBe(revived.entities.length);
    const byNetworkId = new Map(restored.map((e) => [e.networkId, e]));
    for (const saved of revived.entities) {
      const r = byNetworkId.get(saved.networkId);
      expect(r, `networkId ${saved.networkId} missing`).toBeDefined();
      expect(r!.kind).toBe(saved.kind);
      expect(r!.components).toEqual(saved.components);
    }
  });

  it("快照截断（walkable 数组切短）→ 启动抛结构错误，绝不静默加载", async () => {
    const entries = Object.entries(suite.record.maps ?? {});
    const [key, snapshot] = entries[0];
    const corrupted: WorldRecord = {
      ...suite.record,
      maps: {
        ...suite.record.maps,
        [key]: { ...snapshot, walkable: snapshot.walkable.slice(0, 10) },
      },
    };

    await expect(
      createGameSimulation(suite.def, {
        repository: memoryRepository(corrupted),
        saveId: "cut",
      }),
    ).rejects.toThrow(/walkable length/);
  });

  it("快照缺字段（缺 tiles）→ 启动抛错，绝不静默加载", async () => {
    const entries = Object.entries(suite.record.maps ?? {});
    const [key, snapshot] = entries[0];
    const corrupted = {
      ...suite.record,
      maps: {
        ...suite.record.maps,
        [key]: { ...snapshot, tiles: undefined },
      },
    } as unknown as WorldRecord;

    await expect(
      createGameSimulation(suite.def, {
        repository: memoryRepository(corrupted),
        saveId: "cut",
      }),
    ).rejects.toThrow();
  });
});
