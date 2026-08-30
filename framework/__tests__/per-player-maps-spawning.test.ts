/**
 * 分图（per-player maps）刷怪路径测试（核心切换后语义）。
 *
 * 旧 zone 随机刷怪（spawningSystem + resolvedSpawns）已退役：实体生产的
 * 唯一决策路径是演化引擎（bootMaps 初始铺放 + 每 tick evolve 钩子，规则源
 * resolvedEntityRules）。本文件钉住退役不变式——即使旧规则形状残留，
 * spawningSystem 也不产出任何实体；引擎侧语义由 map-evolution.test.ts 与
 * 开机冒烟测试覆盖。
 */
import { describe, it, expect, beforeAll } from "vitest";
import { query } from "bitecs";
import {
  bootstrapFramework,
  createGameInstance,
  createDefaultGameDefinition,
  getRegistries,
} from "framework/index";
import { Transform } from "framework/components/transform";
import { spawningSystem } from "framework/systems/gameplay/spawningSystem";
import { makeTestGeometry } from "./helpers/mapGeometry";
import type { GameWorld } from "framework/world";

beforeAll(() => {
  // 全局引导一次：注册表是幂等单例，所有用例共享同一套内置实现
  bootstrapFramework();
});

/** 构造一个最小世界（默认配置，无地图配置兜底路径）。 */
function createBareWorld(): GameWorld {
  return createGameInstance(createDefaultGameDefinition()).world;
}

/** 注册测试原型（全局注册表单例，跨用例重复注册会抛错 → 已存在则跳过）。 */
function ensureArchetype(world: GameWorld, spec: Parameters<typeof world.archetypes.register>[0]): void {
  if (!world.archetypes.has(spec.kind)) {
    world.archetypes.register(spec);
  }
}

describe("spawningSystem retired（实体生产唯一路径 = 演化引擎）", () => {
  it("注入旧形状刷怪规则 + 激活图：spawningSystem 不产出任何实体", () => {
    const world = createBareWorld();
    ensureArchetype(world, { kind: "npc1", components: {} });
    world.maps = {
      a: makeTestGeometry({ key: "a", width: 8, height: 8 }),
      b: makeTestGeometry({ key: "b", width: 8, height: 8 }),
    };
    world.activeMaps = new Set(["a", "b"]);
    world.defaultMapId = "a";
    world.gameDef.resolvedSpawns = [
      { kind: "npc1", zoneId: 1, max: 6, respawnMs: 0 },
      { kind: "npc1", zoneId: 1, max: 4, respawnMs: 0, mapId: "b" },
    ];

    spawningSystem(world);

    expect(query(world, [Transform]).length).toBe(0);
  });

  it("resolvedSpawns 缺省为空（规则已迁入 resolvedEntityRules）", () => {
    const world = createBareWorld();
    expect(world.gameDef.resolvedSpawns).toEqual([]);
    expect((world.gameDef.resolvedEntityRules ?? []).length).toBe(0);
  });

  it("getRegistries 暴露生成积木注册表（内置积木可查）", () => {
    const { mapGeneratorRegistry } = getRegistries();
    expect(mapGeneratorRegistry.has("noise-terrain")).toBe(true);
    expect(mapGeneratorRegistry.has("climate-regions")).toBe(true);
    expect(mapGeneratorRegistry.has("room-corridor")).toBe(true);
    expect(mapGeneratorRegistry.has("tiled-source")).toBe(true);
  });
});
