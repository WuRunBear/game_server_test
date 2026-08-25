/**
 * 地图生成器注册表（createGeneratorRegistry）单元测试。
 *
 * 覆盖名 → 生成器注册表的注册 / 查询 / 枚举契约：
 * - register + get：注册后按 id 取回同一个生成器；has(id) 对已注册为 true、未注册为 false。
 * - 重复 register：id 已存在时抛错（`Generator "x" is already registered`），避免静默覆盖。
 * - get 未注册 id：抛错（`Generator "x" is not registered`）。
 * - all()：返回副本（改返回数组不影响内部状态），并按注册序列出 id + generator。
 */
import { describe, expect, it } from "vitest";
import { createGeneratorRegistry } from "framework/map/generatorRegistry";
import type { MapGenerator } from "framework/map/generatorRegistry";
import type { MapRuntime } from "framework/map/types";

/**
 * 构造一个最小但类型完整的 MapGenerator（可区分不同生成器实例）。
 *
 * @param id 生成器 id（用于生成结果与生成器身份区分）
 * @returns 返回一个固定 MapRuntime 的生成器
 */
function fakeGenerator(id: string): MapGenerator {
  return () => {
    const runtime: MapRuntime = {
      id,
      name: id,
      grid: { width: 1, height: 1, tileWidth: 16, tileHeight: 16 },
      blocked: Uint8Array.of(0),
      spawns: { player: { x: 8, y: 8 }, npcs: [] },
      zones: [],
    };
    return runtime;
  };
}

describe("createGeneratorRegistry: 注册 / 查询", () => {
  it("register 后 get 返回同一个生成器；has(id) 对已注册 true、未注册 false", () => {
    const registry = createGeneratorRegistry();
    const genA = fakeGenerator("a");

    registry.register("a", genA);

    expect(registry.has("a")).toBe(true);
    expect(registry.has("missing")).toBe(false);
    expect(registry.get("a")).toBe(genA);
  });

  it("重复 register 抛错：Generator \"x\" is already registered", () => {
    const registry = createGeneratorRegistry();
    registry.register("x", fakeGenerator("x"));

    expect(() => registry.register("x", fakeGenerator("x2"))).toThrow(
      'Generator "x" is already registered',
    );
  });

  it("get 未注册 id 抛错：Generator \"nope\" is not registered", () => {
    const registry = createGeneratorRegistry();

    expect(() => registry.get("nope")).toThrow('Generator "nope" is not registered');
  });
});

describe("createGeneratorRegistry: all() 枚举", () => {
  it("all() 返回副本，列出注册的 id + generator；改返回数组不影响内部状态", () => {
    const registry = createGeneratorRegistry();
    const genA = fakeGenerator("a");
    const genB = fakeGenerator("b");
    registry.register("a", genA);
    registry.register("b", genB);

    const snapshot = registry.all();
    expect(snapshot).toHaveLength(2);
    expect(snapshot[0]!.id).toBe("a");
    expect(snapshot[0]!.generator).toBe(genA);
    expect(snapshot[1]!.id).toBe("b");
    expect(snapshot[1]!.generator).toBe(genB);

    // 篡改返回数组，不应影响内部注册表
    snapshot.length = 0;
    snapshot.push({ id: "zzz", generator: fakeGenerator("zzz") });

    expect(registry.all()).toHaveLength(2);
    expect(registry.has("a")).toBe(true);
    expect(registry.has("b")).toBe(true);
    expect(
      registry
        .all()
        .map((e) => e.id),
    ).toEqual(["a", "b"]);
  });
});
