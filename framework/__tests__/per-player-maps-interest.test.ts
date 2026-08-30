/**
 * 分图（per-player maps）interest 测试（per-player-maps 计划 todo 11）。
 *
 * 覆盖：
 * - 跨图实体即使与玩家同坐标也不可见（快照 mapId 过滤：snap.mapId === 玩家图）
 * - 同图半径内可见 / 半径外不可见（viewRadius 配置，距离平方比较）
 * - 未配 viewRadius → 同图全量（不做半径检查）
 * - 自身实体恒可见（出半径/跨图均不影响 own，:44-47 语义保留）
 * - 他图玩家实体不出现在本玩家 visible 列表
 *
 * 镜像 per-player-maps-snapshot.test.ts 的 setup：createGameSimulation +
 * addPlayer；地图归属经 spawnEntity overrides.mapId / EntityMap 直写（todo 4）；
 * viewRadius 经 def.resolvedRules["server"]（ServerRuleSchema 语义，同 slice5）。
 */
import type { SimulationPort } from "simulation";
import { describe, it, expect, beforeAll } from "vitest";
import { query } from "bitecs";
import {
  bootstrapFramework,
  createGameSimulation,
  createDefaultGameDefinition,
  spawnEntity,
  getRegistries,
} from "framework/index";
import { NetworkId } from "framework/components/network";
import { Player } from "framework/components/tags";
import { EntityMap } from "framework/components/entityMap";
import type { GameWorld } from "framework/world";

beforeAll(() => {
  // 全局引导一次：注册表是幂等单例，所有用例共享同一套内置实现
  bootstrapFramework();
});

/** 取仿真内部的 GameWorld（镜像 slice5 simWorld 私有访问器）。 */
function simWorld(sim: SimulationPort): GameWorld {
  return (sim as unknown as { world: GameWorld }).world;
}

/** 清空 EntityMap 模块级单例残留（AoS 数组跨 world 复用 eid，防跨用例串扰）。 */
function clearEntityMap(): void {
  for (let i = 0; i < EntityMap.length; i++) EntityMap[i] = undefined;
}

/** 带 viewRadius 的默认定义（server 规则语义，GameSimulation 构造时读取）。 */
function defWithRadius(viewRadius: number) {
  const def = createDefaultGameDefinition();
  def.resolvedRules = { server: { viewRadius } };
  return def;
}

/** 造一个指定坐标/地图的 item 实体（与 snapshot 测试同一 spawn 路径）。 */
function spawnItem(world: GameWorld, x: number, y: number, mapId: string): number {
  return spawnEntity(
    world,
    world.archetypes.get("item"),
    getRegistries().componentRegistry,
    { x, y, mapId },
  );
}

describe("interest", () => {
  it("a) 跨图实体与玩家同坐标 → 不可见", async () => {
    clearEntityMap();
    const sim = await createGameSimulation(createDefaultGameDefinition());
    const world = simWorld(sim);
    sim.addPlayer("s1");
    const [p1] = query(world, [Player]);
    EntityMap[p1] = "map-a";

    const cross = spawnItem(world, 0, 0, "map-b");

    const { interest } = sim.tick(50);
    const visible = interest!.get("s1")!;
    expect(visible).not.toContain(NetworkId.value[cross]);
    // 自身恒可见（回归防线）
    expect(visible).toContain(NetworkId.value[p1]);
  });

  it("b) 同图半径内可见；半径外不可见", async () => {
    clearEntityMap();
    const sim = await createGameSimulation(defWithRadius(100));
    const world = simWorld(sim);
    sim.addPlayer("s1");
    const [p1] = query(world, [Player]);
    EntityMap[p1] = "map-a";

    const near = spawnItem(world, 10, 0, "map-a");
    const far = spawnItem(world, 300, 0, "map-a");

    const { interest } = sim.tick(50);
    const visible = interest!.get("s1")!;
    expect(visible).toContain(NetworkId.value[near]);
    expect(visible).not.toContain(NetworkId.value[far]);
    expect(visible).toContain(NetworkId.value[p1]);
  });

  it("c) 未配 viewRadius → 同图全量（远距同图亦可见）", async () => {
    clearEntityMap();
    const sim = await createGameSimulation(createDefaultGameDefinition());
    const world = simWorld(sim);
    sim.addPlayer("s1");
    const [p1] = query(world, [Player]);
    EntityMap[p1] = "map-a";

    const far = spawnItem(world, 5000, 5000, "map-a");

    const { interest } = sim.tick(50);
    expect(interest!.get("s1")).toContain(NetworkId.value[far]);
    expect(interest!.get("s1")).toContain(NetworkId.value[p1]);
  });

  it("d) 自身恒可见：出半径 + 跨图邻接均不影响 own", async () => {
    clearEntityMap();
    const sim = await createGameSimulation(defWithRadius(1));
    const world = simWorld(sim);
    sim.addPlayer("s1");
    const [p1] = query(world, [Player]);
    EntityMap[p1] = "map-a";

    const far = spawnItem(world, 200, 200, "map-a");
    const cross = spawnItem(world, 0, 0, "map-b");

    const { interest } = sim.tick(50);
    const visible = interest!.get("s1")!;
    expect(visible).toContain(NetworkId.value[p1]);
    expect(visible).not.toContain(NetworkId.value[far]);
    expect(visible).not.toContain(NetworkId.value[cross]);
  });

  it("e) 他图玩家实体不在本玩家 visible 列表", async () => {
    clearEntityMap();
    const sim = await createGameSimulation(createDefaultGameDefinition());
    const world = simWorld(sim);
    sim.addPlayer("s1");
    const [p1] = query(world, [Player]);
    sim.addPlayer("s2");
    const [, p2] = query(world, [Player]);
    EntityMap[p1] = "map-a";
    EntityMap[p2] = "map-b";

    const { interest } = sim.tick(50);
    expect(interest!.get("s1")!).not.toContain(NetworkId.value[p2]);
    // 各自 own 恒可见
    expect(interest!.get("s1")!).toContain(NetworkId.value[p1]);
    expect(interest!.get("s2")!).toContain(NetworkId.value[p2]);
  });
});
