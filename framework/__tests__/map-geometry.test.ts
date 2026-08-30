/**
 * MapGeometry 数据层测试（framework/__tests__/map-geometry.test.ts）。
 *
 * 覆盖 geometry 数据层三块能力（计划 todo 1 验收）：
 * - 快照序列化：serialize→deserialize 往返深相等（含 regions Map 与
 *   区域插入顺序），且 serialize 输出为纯 JSON 可序列化形态；
 * - 内容指纹：相同内容版本稳定；grid/tiles/walkable/regions/regionOfTile
 *   任一字段变化即版本变化；key/version 不参与指纹；
 * - 地理查询：界内返回正确值；越界坐标返回安全值（false/undefined/0），
 *   永不抛错。
 */
import { describe, expect, it } from "vitest";

import { regionOf, tileAt, walkableAt } from "map/geometry/query";
import { deserializeGeometry, serializeGeometry } from "map/geometry/snapshot";
import type { SerializedMapGeometry } from "map/geometry/snapshot";
import { computeGeometryVersion } from "map/geometry/version";
import type { MapGeometry, RegionMeta } from "map/geometry/types";

/**
 * 构造最小 MapGeometry 字面量（手构，不经过任何生成器）。
 *
 * 默认 4×4、16px/tile：
 * - tiles 全 1，仅 tiles[0]=2（区分语义 id）；
 * - walkable 全 1，仅 walkable[5]=0（(1,1) 格不可通行）；
 * - regions 插入序：0="wilderness"、1="inner"；首行 4 格 regionOfTile=1（"inner"），
 *   其余 0（"wilderness"）。
 * 每次调用产出全新实例（测试间互不共享可变引用）。
 */
function makeGeometry(): MapGeometry {
  const tiles = new Uint8Array(16).fill(1);
  tiles[0] = 2;
  const walkable = new Uint8Array(16).fill(1);
  walkable[5] = 0;
  const regionOfTile = new Uint16Array(16);
  for (let x = 0; x < 4; x++) regionOfTile[x] = 1;

  return {
    key: "test-geometry",
    grid: { width: 4, height: 4, tileWidth: 16, tileHeight: 16 },
    tiles,
    walkable,
    regions: new Map<string, RegionMeta>([
      ["wilderness", { name: "wilderness", meta: {} }],
      ["inner", { name: "inner", meta: { weight: 2 } }],
    ]),
    regionOfTile,
    version: "0123abcd",
  };
}

/** 深拷贝 MapGeometry（含 regions Map 条目与 meta），供逐字段变异测试。 */
function cloneGeometry(g: MapGeometry): MapGeometry {
  return {
    key: g.key,
    grid: { ...g.grid },
    tiles: Uint8Array.from(g.tiles),
    walkable: Uint8Array.from(g.walkable),
    regions: new Map(
      Array.from(g.regions, ([key, meta]): [string, RegionMeta] => [
        key,
        { name: meta.name, meta: { ...meta.meta } },
      ]),
    ),
    regionOfTile: Uint16Array.from(g.regionOfTile),
    version: g.version,
  };
}

describe("MapGeometry 快照序列化", () => {
  it("POSITIVE：serialize→deserialize 往返深相等（含 regions Map）", () => {
    const geometry = makeGeometry();

    const restored = deserializeGeometry(serializeGeometry(geometry));

    expect(restored).toEqual(geometry);
    expect(restored.regions).toBeInstanceOf(Map);
    expect(restored.tiles).toBeInstanceOf(Uint8Array);
    expect(restored.regionOfTile).toBeInstanceOf(Uint16Array);
  });

  it("POSITIVE：serialize 输出纯 JSON 形态，经 JSON 往返后 deserialize 仍深相等", () => {
    const geometry = makeGeometry();

    const snapshot = serializeGeometry(geometry);
    // 序列化形态断言：类型化数组 → number[]，Map → 普通对象
    expect(snapshot.tiles).toBeInstanceOf(Array);
    expect(snapshot.regionOfTile).toBeInstanceOf(Array);
    expect(snapshot.regions).not.toBeInstanceOf(Map);
    expect(snapshot.regions["inner"]).toEqual({ name: "inner", meta: { weight: 2 } });

    // 纯 JSON 可序列化：经真实 JSON 往返后仍能还原
    const json: SerializedMapGeometry = JSON.parse(JSON.stringify(snapshot));
    const restored = deserializeGeometry(json);

    expect(restored).toEqual(geometry);
    // 区域插入顺序经 JSON 往返保持，regionOf 解析不受影响
    expect(regionOf(restored, 0, 0)).toBe("inner");
    expect(regionOf(restored, 2, 2)).toBe("wilderness");
  });
});

describe("computeGeometryVersion 内容指纹", () => {
  it("POSITIVE：相同内容两次计算版本一致", () => {
    const a = makeGeometry();
    const b = makeGeometry();

    expect(computeGeometryVersion(b)).toBe(computeGeometryVersion(a));
  });

  it("POSITIVE：grid 变化 → 版本变化", () => {
    const base = makeGeometry();
    const mutated = cloneGeometry(base);
    mutated.grid.tileWidth = 32;

    expect(computeGeometryVersion(mutated)).not.toBe(computeGeometryVersion(base));
  });

  it("POSITIVE：tiles 变化 → 版本变化", () => {
    const base = makeGeometry();
    const mutated = cloneGeometry(base);
    mutated.tiles[15] = 3;

    expect(computeGeometryVersion(mutated)).not.toBe(computeGeometryVersion(base));
  });

  it("POSITIVE：walkable 变化 → 版本变化", () => {
    const base = makeGeometry();
    const mutated = cloneGeometry(base);
    mutated.walkable[15] = 0;

    expect(computeGeometryVersion(mutated)).not.toBe(computeGeometryVersion(base));
  });

  it("POSITIVE：regions 变化（meta 变更 / 新增区域）→ 版本变化", () => {
    const base = makeGeometry();
    const metaMutated = cloneGeometry(base);
    // Map.set 对已存在键只更新值、保持原插入位置——仅 meta 内容变化
    metaMutated.regions.set("inner", { name: "inner", meta: { weight: 3 } });
    expect(computeGeometryVersion(metaMutated)).not.toBe(computeGeometryVersion(base));

    const added = cloneGeometry(base);
    added.regions.set("outer", { name: "outer", meta: {} });
    expect(computeGeometryVersion(added)).not.toBe(computeGeometryVersion(base));
  });

  it("POSITIVE：regionOfTile 变化 → 版本变化", () => {
    const base = makeGeometry();
    const mutated = cloneGeometry(base);
    mutated.regionOfTile[15] = 1;

    expect(computeGeometryVersion(mutated)).not.toBe(computeGeometryVersion(base));
  });

  it("POSITIVE：key 与 version 字段不参与指纹", () => {
    const base = makeGeometry();
    const mutated = cloneGeometry(base);
    mutated.key = "other-key";
    mutated.version = "ffffffff";

    expect(computeGeometryVersion(mutated)).toBe(computeGeometryVersion(base));
  });
});

describe("地理查询越界安全", () => {
  it("POSITIVE：界内查询返回正确的通行/区域/语义 id", () => {
    const geometry = makeGeometry();

    expect(walkableAt(geometry, 0, 0)).toBe(true);
    expect(walkableAt(geometry, 1, 1)).toBe(false);
    expect(regionOf(geometry, 0, 0)).toBe("inner");
    expect(regionOf(geometry, 2, 2)).toBe("wilderness");
    expect(tileAt(geometry, 0, 0)).toBe(2);
    expect(tileAt(geometry, 1, 1)).toBe(1);
  });

  it("POSITIVE：越界坐标返回安全值不抛错（负值/超宽/超高）", () => {
    const geometry = makeGeometry();
    const outOfBounds: Array<[number, number]> = [
      [-1, 0],
      [0, -1],
      [4, 0],
      [0, 4],
      [-1, -1],
      [100, 100],
    ];

    for (const [x, y] of outOfBounds) {
      expect(walkableAt(geometry, x, y)).toBe(false);
      expect(regionOf(geometry, x, y)).toBeUndefined();
      expect(tileAt(geometry, x, y)).toBe(0);
    }
  });

  it("POSITIVE：regionOfTile 索引未落到任何已注册区域 → undefined", () => {
    const geometry = makeGeometry();
    geometry.regionOfTile[8] = 9;

    expect(regionOf(geometry, 0, 2)).toBeUndefined();
  });
});
