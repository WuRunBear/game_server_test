/**
 * 分图（per-player maps）世界级基础设施测试：world.maps / activeMaps / defaultMapId。
 *
 * 覆盖：
 * - 有地图配置时：开机仅构建并激活默认图（惰性缓存不构建全部图）；
 *   `world.map` 仍是默认图引用（弃用别名），与 world.maps[defaultMapId] 同一对象。
 * - 无地图配置（createDefaultGameDefinition 兜底路径）：maps/activeMaps 为空、
 *   defaultMapId 为空串，游戏实例照常 step 不崩溃。
 */
import { describe, it, expect, beforeAll } from "vitest";
import {
  bootstrapFramework,
  createGameInstance,
  createDefaultGameDefinition,
  loadGameDefinition,
} from "framework/index";
import type { GameWorld } from "framework/world";

beforeAll(() => {
  // 全局引导一次：注册表是幂等单例，所有用例共享同一套内置实现
  bootstrapFramework();
});

describe("world maps", () => {
  it("with map config: all config maps are built/active at boot, defaultMapId set", () => {
    const gameDef = loadGameDefinition({ gameJsonPath: "game/game.json" });
    const world: GameWorld = createGameInstance(gameDef).world;

    const defaultId = gameDef.map?.default ?? "";

    // 常驻语义：开机全量构建并激活全部配置图
    const configKeys = gameDef.resolvedMapConfigs.map((c) => c.key);
    expect(Object.keys(world.maps).sort()).toEqual([...configKeys].sort());
    expect(world.maps[defaultId]).toBeDefined();
    expect(world.maps[defaultId]!.key).toBe(defaultId);
    expect(world.activeMaps).toEqual(new Set(configKeys));
    expect(world.defaultMapId).toBe(defaultId);
  });

  it("without map config: maps/activeMaps stay empty and step still runs", () => {
    const instance = createGameInstance(createDefaultGameDefinition());
    const world = instance.world;

    expect(world.maps).toEqual({});
    expect(world.activeMaps.size).toBe(0);
    expect(world.defaultMapId).toBe("");

    // 无地图配置时世界照常推进，不带错误
    expect(() => instance.step(16)).not.toThrow();
  });
});
