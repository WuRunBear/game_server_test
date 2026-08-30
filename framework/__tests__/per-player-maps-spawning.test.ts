/**
 * 分图（per-player maps）刷怪路径测试（spawning 退役后语义）。
 *
 * 旧 zone 随机刷怪（spawning 系统 + resolvedSpawns）已整体删除：实体生产的
 * 唯一决策路径是演化引擎（bootMaps 初始铺放 + 每 tick evolve 钩子，规则源
 * resolvedEntityRules）。本文件钉住退役不变式——注册表与 game.json 均不再
 * 引用 spawning；引擎侧语义由 map-evolution.test.ts 与开机冒烟测试覆盖。
 */
import { describe, it, expect, beforeAll } from "vitest";
import {
  bootstrapFramework,
  createGameInstance,
  createDefaultGameDefinition,
  loadGameDefinition,
  getRegistries,
} from "framework/index";

beforeAll(() => {
  // 全局引导一次：注册表是幂等单例，所有用例共享同一套内置实现
  bootstrapFramework();
});

describe("spawning 退役（实体生产唯一路径 = 演化引擎）", () => {
  it("spawning 不在系统注册表中，game.json 也不再启用", () => {
    const { systemRegistry } = getRegistries();
    expect(systemRegistry.has("spawning")).toBe(false);

    const gameDef = loadGameDefinition({ gameJsonPath: "game/game.json" });
    expect((gameDef.systems ?? []).some((s) => s.id === "spawning")).toBe(false);
  });

  it("默认定义无演化规则（resolvedEntityRules 缺省为空）", () => {
    const world = createGameInstance(createDefaultGameDefinition()).world;
    expect(world.gameDef.resolvedEntityRules ?? []).toEqual([]);
  });

  it("getRegistries 暴露生成积木注册表（内置积木可查）", () => {
    const { mapGeneratorRegistry } = getRegistries();
    expect(mapGeneratorRegistry.has("noise-terrain")).toBe(true);
    expect(mapGeneratorRegistry.has("climate-regions")).toBe(true);
    expect(mapGeneratorRegistry.has("room-corridor")).toBe(true);
    expect(mapGeneratorRegistry.has("tiled-source")).toBe(true);
  });
});
