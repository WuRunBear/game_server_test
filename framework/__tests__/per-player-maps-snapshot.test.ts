/**
 * 分图（per-player maps）快照测试（per-player-maps 计划 todo 10）。
 *
 * 覆盖：
 * - snapshot.entities 每实体带 mapId（entityMapOf 语义：显式 overrides.mapId
 *   写入的实体保留该图；未归属实体回退默认图）
 * - snapshot.playerMaps：sessionId → 该玩家实体的当前地图
 * - 无 viewRadius（无 server 规则）时 interest 恒存在（T11 后为同图全集；
 *   本 todo 断言存在且至少含 own 玩家实体）
 * - orphan 玩家（restoreWorld 路径）：addPlayer 复用后保留存档 EntityMap，
 *   不被重置为默认图
 *
 * 镜像 slice5 的 createGameSimulation 持久化/玩家设置（repository/initialRecord
 * 经 options 注入；world 经私有访问器取出），地图归属全部经 spawnEntity
 * overrides.mapId（todo 4）。
 */
import { describe, it, expect, beforeAll } from "vitest";
import { query } from "bitecs";
import {
  bootstrapFramework,
  createGameSimulation,
  createDefaultGameDefinition,
  spawnEntity,
  getRegistries,
} from "framework/index";
import { Transform } from "framework/components/transform";
import { NetworkId } from "framework/components/network";
import { Player } from "framework/components/tags";
import { EntityMap, entityMapOf } from "framework/components/entityMap";
import type { GameWorld } from "framework/world";
import type { WorldRecord } from "framework/repository";

beforeAll(() => {
  // 全局引导一次：注册表是幂等单例，所有用例共享同一套内置实现
  bootstrapFramework();
});

/** 取仿真内部的 GameWorld（镜像 slice5 simWorld 私有访问器）。 */
function simWorld(sim: ReturnType<typeof createGameSimulation>): GameWorld {
  return (sim as unknown as { world: GameWorld }).world;
}

/** 清空 EntityMap 模块级单例残留（AoS 数组跨 world 复用 eid，防跨用例串扰）。 */
function clearEntityMap(): void {
  for (let i = 0; i < EntityMap.length; i++) EntityMap[i] = undefined;
}

describe("snapshot", () => {
  it("a) snapshot 每实体 mapId === entityMapOf（显式 overrides.mapId 生效）", () => {
    clearEntityMap();
    const sim = createGameSimulation(createDefaultGameDefinition());
    const world = simWorld(sim);
    sim.addPlayer("s1");

    // 显式归属一张无 world.maps 条目的图：EntityMap 只记录标识，不校验图是否激活
    const custom = spawnEntity(world, world.archetypes.get("item"), getRegistries().componentRegistry, {
      x: 5,
      y: 5,
      mapId: "custom-map",
    });

    const { snapshot } = sim.tick(50);
    expect(snapshot.entities.size).toBeGreaterThan(0);

    for (const [networkId, snap] of snapshot.entities) {
      const eid = query(world, [NetworkId]).find((e) => NetworkId.value[e] === networkId)!;
      expect(snap.mapId).toBe(entityMapOf(world, eid));
    }
    expect(snapshot.entities.get(NetworkId.value[custom])!.mapId).toBe("custom-map");
  });

  it("b) snapshot.playerMaps：sessionId → 该玩家实体的地图", () => {
    clearEntityMap();
    const sim = createGameSimulation(createDefaultGameDefinition());
    const world = simWorld(sim);
    sim.addPlayer("s1");
    const [p1] = query(world, [Player]);
    sim.addPlayer("s2");
    const [, p2] = query(world, [Player]);

    const { snapshot } = sim.tick(50);
    expect(snapshot.playerMaps.get("s1")).toBe(entityMapOf(world, p1));
    expect(snapshot.playerMaps.get("s2")).toBe(entityMapOf(world, p2));
    // 无地图配置兜底路径：默认图为空串（玩家未归属时回退默认图）
    expect(snapshot.playerMaps.get("s1")).toBe("");
  });

  it("c) 无 viewRadius（无 server 规则）也产出 interest：存在且至少含 own 玩家实体", () => {
    clearEntityMap();
    const sim = createGameSimulation(createDefaultGameDefinition());
    const world = simWorld(sim);
    sim.addPlayer("s1");
    const [p1] = query(world, [Player]);

    const { interest } = sim.tick(50);
    expect(interest).toBeDefined();
    expect(interest!.get("s1")).toContain(NetworkId.value[p1]);
  });

  it("d) orphan 玩家复用后保留存档图（EntityMap 不被重置为默认图）", () => {
    clearEntityMap();
    const def = createDefaultGameDefinition();
    const record: WorldRecord = {
      id: "s",
      savedAt: 1,
      tick: 1,
      nextNetworkId: 100,
      entities: [{ networkId: 7, kind: "player", components: { EntityMap: "cave1" } }],
    };
    const sim = createGameSimulation(def, { initialRecord: record });
    const world = simWorld(sim);

    const { networkId } = sim.addPlayer("s1");
    expect(networkId).toBe(7);

    const [playerEid] = query(world, [Player]);
    expect(EntityMap[playerEid]).toBe("cave1");
    expect(entityMapOf(world, playerEid)).toBe("cave1");

    const { snapshot, interest } = sim.tick(50);
    expect(snapshot.playerMaps.get("s1")).toBe("cave1");
    expect(interest).toBeDefined();
    expect(interest!.get("s1")).toContain(networkId);
  });
});
