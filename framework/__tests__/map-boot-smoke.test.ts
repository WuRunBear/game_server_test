/**
 * I1 开机全量构建（真实配置 HeadlessHost 冒烟）。
 *
 * 真实 game/ 配置 + HeadlessHost 驱动，断言开机编排的四个硬性结果：
 * - 全部配置图就绪于 world.maps；
 * - 全部配置图 ∈ world.activeMaps（常驻语义）；
 * - world.time.tick = 最大 initialAgeTicks（开机初始演化推进）；
 * - 初始实体数 > 0（演化引擎是唯一实体生产路径）。
 */
import { describe, it, expect, beforeAll } from "vitest";
import { query } from "bitecs";
import {
  bootstrapFramework,
  loadGameDefinition,
  createGameSimulation,
  runHeadless,
} from "framework/index";
import { NetworkId } from "framework/components/network";
import { Kind } from "framework/components/kind";
import { Player } from "framework/components/tags";
import { Needs } from "framework/components/needs";
import { ResourceNode } from "framework/components/resourceNode";
import { DialogueSource } from "framework/components/dialogueSource";
import { Ledger } from "framework/components/ledger";
import { Transform } from "framework/components/transform";
import { entityMapOf } from "framework/components/entityMap";
import { entityLevelOf } from "framework/components/entityLevel";
import { walkableAtLevel } from "map/geometry/query";
import type { GameWorld } from "framework/world";

beforeAll(() => {
  bootstrapFramework();
});

describe("boot smoke（真实配置 HeadlessHost 冒烟）", () => {
  it("I1：boot：全图就绪并常驻激活、tick=initialAgeTicks、初始实体>0；headless tick 正常推进", async () => {
    const def = loadGameDefinition({ gameJsonPath: "game/game.json" });
    const sim = await createGameSimulation(def);
    const world = (sim as unknown as { world: GameWorld }).world;

    const configKeys = def.resolvedMapConfigs.map((c) => c.key);
    expect(configKeys.length).toBeGreaterThan(0);
    // 全部配置图就绪
    for (const key of configKeys) {
      expect(world.maps[key]).toBeDefined();
      expect(world.maps[key]!.key).toBe(key);
    }
    // 全部配置图常驻激活
    expect(world.activeMaps).toEqual(new Set(configKeys));
    // 默认图 = game.json map.default
    expect(world.defaultMapId).toBe(def.map?.default ?? "");
    // tick = 最大 initialAgeTicks（island 155520000 > cave 51840000）
    const maxInitialAge = Math.max(...def.resolvedMapConfigs.map((c) => c.initialAgeTicks));
    expect(world.time.tick).toBe(maxInitialAge);
    // 初始实体 > 0（演化引擎铺放）
    expect(query(world, [NetworkId]).length).toBeGreaterThan(0);
    // 默认图（island）初始铺放含资源实体（entity-rules 密度规则的真实产出）
    const eids = [...query(world, [NetworkId])];
    const islandKinds = new Set(
      eids
        .filter((eid) => entityMapOf(world, eid) === world.defaultMapId)
        .map((eid) => Kind[eid]),
    );
    expect(islandKinds.has("tree")).toBe(true);
    expect(islandKinds.has("berry_bush")).toBe(true);

    // HeadlessHost 驱动 3 tick：帧号严格递增、无异常
    const results = runHeadless(sim, { tickCount: 3, dtMs: 50 });
    expect(results).toHaveLength(3);
    expect(results[2]!.tick).toBe(maxInitialAge + 3);
    for (let i = 1; i < results.length; i++) {
      expect(results[i]!.tick).toBe(results[i - 1]!.tick + 1);
    }
  });

  it("boot 后关键内容可直接交互：资源节点/商贩接线完整，玩家系统实际运行", async () => {
    const def = loadGameDefinition({ gameJsonPath: "game/game.json" });
    const sim = await createGameSimulation(def);
    const world = (sim as unknown as { world: GameWorld }).world;
    const eids = [...query(world, [NetworkId])];

    // 资源实体：有真实 ResourceNode 数据（不是空壳原型）
    const treeEid = eids.find((eid) => Kind[eid] === "tree")!;
    expect(treeEid).toBeDefined();
    expect(ResourceNode[treeEid]?.remaining).toBeGreaterThan(0);
    expect(ResourceNode[treeEid]?.yieldsKind).toBe("wood");

    // 商贩：DialogueSource.treeId 必须能在已解析对话树中查到（交互不是悬空引用）
    const villagerEid = eids.find((eid) => Kind[eid] === "villager")!;
    expect(villagerEid).toBeDefined();
    const treeId = DialogueSource[villagerEid]?.treeId;
    expect(treeId).toBeTruthy();
    expect(world.gameDef.dialoguesByKind?.has(treeId!)).toBe(true);
    // F-44：商贩账本由 archetype 配置真实初始化（有限库存/资金）
    expect(Ledger[villagerEid]?.shell).toBe(100);
    expect(Ledger[villagerEid]?.shell_spear).toBe(6);

    // 玩家：出生点在其地图的层视角可通行；需求系统与昼夜系统在 tick 中实际运行
    const join = sim.addPlayer("boot-smoke-player");
    const playerEid = [...query(world, [Player, NetworkId])].find(
      (eid) => NetworkId.value[eid] === join.networkId,
    )!;
    expect(playerEid).toBeDefined();
    const geometry = world.maps[entityMapOf(world, playerEid)]!;
    const level = entityLevelOf(playerEid);
    const tileX = Math.floor(Transform.x[playerEid] / geometry.grid.tileWidth);
    const tileY = Math.floor(Transform.y[playerEid] / geometry.grid.tileHeight);
    expect(walkableAtLevel(geometry, tileX, tileY, level)).toBe(true);

    const hunger = Needs[playerEid]?.find((need) => need.name === "hunger")!;
    expect(hunger).toBeDefined();
    const hungerBefore = hunger.current;
    const hourBefore = world.time.timeOfDay.hour;

    // 20 tick = 1s：需求衰减与昼夜推进都是同一条 tick 系统链的真实结果
    sim.submitInput("boot-smoke-player", { seq: 1, moveX: 0, moveY: 0 });
    runHeadless(sim, { tickCount: 20, dtMs: 50 });
    expect(hunger.current).toBeLessThan(hungerBefore);
    expect(world.time.timeOfDay.hour).not.toBe(hourBefore);
  });
});
