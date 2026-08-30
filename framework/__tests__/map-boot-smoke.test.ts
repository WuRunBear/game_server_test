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
import { entityMapOf } from "framework/components/entityMap";
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
});
