/**
 * EntityLevel 组件测试（framework/__tests__/component-entity-level.test.ts）。
 *
 * 载体验收（地图切片 4 · 前置修正 1——本切片只交付载体，不接移动）：
 * - 默认层号：无条目时 entityLevelOf 回退 0（地面基准层）；
 * - 运行时写入/读取：AoS 直写直读；
 * - 注册形态：registerBuiltinComponents 注册为 AoS 组件（无 archetype
 *   initializer、无 configSchema——运行时层号无法由静态原型表达）；
 * - 销毁清理：destroyEntity 清 AoS 残留（防 eid 复用串扰，统一出口行为）；
 * - 入档：未列入 worldSerializer 瞬态黑名单——有序列化值时随实体写入存档。
 */
import { beforeEach, describe, expect, it } from "vitest";
import { addEntity, addComponent } from "bitecs";

import { bootstrapFramework, createDefaultGameDefinition, createGameInstance, getRegistries } from "framework";
import { destroyEntity } from "framework/entities/destroyEntity";
import { serializeWorld } from "framework/persistence/worldSerializer";
import { NetworkId } from "framework/components/network";
import { EntityLevel, entityLevelOf } from "framework/components/entityLevel";
import type { GameWorld } from "framework/world";

/** 清空 EntityLevel 模块级单例残留（AoS 数组跨 world 复用 eid，防跨用例串扰）。 */
function clearEntityLevel(): void {
  for (let i = 0; i < EntityLevel.length; i++) EntityLevel[i] = undefined;
}

describe("EntityLevel 载体（AoS，切片 4 前置修正 1）", () => {
  beforeEach(() => {
    clearEntityLevel();
  });

  it("POSITIVE：无条目回退 0（地面基准层），写入后原样读取", () => {
    expect(entityLevelOf(123)).toBe(0);

    EntityLevel[123] = 2;
    expect(entityLevelOf(123)).toBe(2);

    // 负层（地下预留）原样承载
    EntityLevel[124] = -1;
    expect(entityLevelOf(124)).toBe(-1);
  });

  it("POSITIVE：注册为 AoS 组件（无 archetype initializer，静态原型不可配置）", () => {
    bootstrapFramework();
    const registry = getRegistries().componentRegistry;

    expect(registry.has("EntityLevel")).toBe(true);
    expect(registry.isAosComponent("EntityLevel")).toBe(true);
    // 无 initializer：参照 EntityMap/SpawnPoint 模式，运行时写入不经 spawn 链
    expect(registry.getAosInitializer("EntityLevel")).toBeUndefined();
  });

  it("POSITIVE：destroyEntity 清 AoS 残留（eid 复用后回退默认层 0）", () => {
    const world: GameWorld = createGameInstance(createDefaultGameDefinition()).world;
    const eid = addEntity(world);
    EntityLevel[eid] = 3;

    destroyEntity(world, eid);

    expect(EntityLevel[eid]).toBeUndefined();
    expect(entityLevelOf(eid)).toBe(0);
  });

  it("POSITIVE：随实体入档（serializeWorld 携带 EntityLevel 值）", () => {
    const world: GameWorld = createGameInstance(createDefaultGameDefinition()).world;
    const eid = addEntity(world);
    addComponent(world, eid, NetworkId);
    NetworkId.value[eid] = world.nextNetworkId++;
    EntityLevel[eid] = 2;

    const record = serializeWorld(world, "entity-level-test");

    expect(record.entities).toHaveLength(1);
    expect(record.entities[0]?.components["EntityLevel"]).toBe(2);
  });
});
