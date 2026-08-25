/**
 * Tiled 导入（mapRuntimeFromTiled）测试。
 *
 * 通过 `mapRuntimeFromTiled(id, name, json)` 间接覆盖 tiled.ts 的 parseCollision /
 * parseZones / parseSpawns 三个内部解析函数：
 * - collision tilelayer：非 0 tile → blocked=1，0 → 可走；缺失 collision 层 → 全 0；
 *   数据不足 grid 大小时剩余格为 0（Math.min 截断语义）。
 * - zones objectgroup：type="zone" + properties.zoneId + polygon → 顶点（相对对象原点 + 对象坐标）；
 *   无 polygon 时退回矩形（x/y/width/height 围成 4 顶点）；缺 zoneId → 整块跳过；非 zone 类型跳过。
 * - objects objectgroup：type="spawn_player" → player 位置；type="spawn_npc" →
 *   npcs，kind 来自 properties.npcKind（缺省 "npc"），zoneId 来自 properties。
 * - 手护：width/height/tilewidth/tileheight 从 Tiled 顶层 JSON 读取并映射进 grid；
 *   缺省 tile 尺寸回退为 1。
 */
import { describe, expect, it } from "vitest";
import { mapRuntimeFromTiled } from "framework/map/tiled";

/**
 * 构造一个 Tiled 导出 JSON 顶层的半成品（默认 3×3 / 16px tile，可覆盖）。
 *
 * @param overrides 可覆盖 width/height/tilewidth/tileheight/layers
 * @returns 顶层 JSON 对象（作为 mapRuntimeFromTiled 的 json 入参）
 */
function tiledMap(
  overrides: {
    width?: number;
    height?: number;
    tilewidth?: number;
    tileheight?: number;
    layers?: unknown[];
  } = {},
): Record<string, unknown> {
  return {
    width: overrides.width ?? 3,
    height: overrides.height ?? 3,
    tilewidth: overrides.tilewidth ?? 16,
    tileheight: overrides.tileheight ?? 16,
    ...(overrides.layers !== undefined ? { layers: overrides.layers } : {}),
  };
}

describe("mapRuntimeFromTiled: collision tilelayer → blocked 网格", () => {
  it("非 0 tile 记为阻挡(blocked=1)、0 记为可走(blocked=0)，按行展平", () => {
    const rt = mapRuntimeFromTiled(
      "c1",
      "collision-map",
      tiledMap({
        layers: [
          {
            type: "tilelayer",
            name: "collision",
            width: 3,
            height: 3,
            data: [1, 0, 1, 0, 1, 0, 1, 1, 0],
          },
        ],
      }),
    );

    expect(Array.from(rt.blocked)).toEqual([1, 0, 1, 0, 1, 0, 1, 1, 0]);
  });

  it("缺失 collision 层 → 全 0（阻挡网格长度 = width*height）", () => {
    const rt = mapRuntimeFromTiled("c2", "no-collision", tiledMap({ layers: [] }));

    expect(rt.blocked.length).toBe(9);
    expect(Array.from(rt.blocked)).toEqual(Array<number>(9).fill(0));
  });

  it("collision 数据短于 grid → 超出部分为 0（Math.min 截断语义）", () => {
    // 9 格 grid，只给 5 个数据：前 5 个按 data 映射，后 4 个保持 0
    const rt = mapRuntimeFromTiled(
      "c3",
      "short-data",
      tiledMap({
        layers: [
          {
            type: "tilelayer",
            name: "collision",
            width: 3,
            height: 3,
            data: [1, 1, 1, 1, 1],
          },
        ],
      }),
    );

    expect(Array.from(rt.blocked)).toEqual([1, 1, 1, 1, 1, 0, 0, 0, 0]);
  });
});

describe("mapRuntimeFromTiled: zones objectgroup → 区域多边形", () => {
  it("type=zone + zoneId + polygon → 顶点 = 对象坐标 + polygon 相对偏移", () => {
    const rt = mapRuntimeFromTiled(
      "z1",
      "zones-map",
      tiledMap({
        layers: [
          {
            type: "objectgroup",
            name: "zones",
            objects: [
              {
                id: 1,
                type: "zone",
                x: 100,
                y: 200,
                polygon: [
                  { x: 0, y: 0 },
                  { x: 10, y: 0 },
                  { x: 10, y: 10 },
                  { x: 0, y: 10 },
                ],
                properties: [{ name: "zoneId", type: "int", value: 7 }],
              },
            ],
          },
        ],
      }),
    );

    expect(rt.zones).toHaveLength(1);
    expect(rt.zones[0]!.id).toBe(7);
    expect(rt.zones[0]!.polygon).toEqual([
      { x: 100, y: 200 },
      { x: 110, y: 200 },
      { x: 110, y: 210 },
      { x: 100, y: 210 },
    ]);
  });

  it("无 polygon 时退回矩形（x/y/width/height 围成 4 顶点）", () => {
    const rt = mapRuntimeFromTiled(
      "z2",
      "zones-map",
      tiledMap({
        layers: [
          {
            type: "objectgroup",
            name: "zones",
            objects: [
              {
                id: 2,
                type: "zone",
                x: 50,
                y: 60,
                width: 20,
                height: 30,
                properties: [{ name: "zoneId", type: "int", value: 8 }],
              },
            ],
          },
        ],
      }),
    );

    expect(rt.zones).toHaveLength(1);
    expect(rt.zones[0]!.polygon).toEqual([
      { x: 50, y: 60 },
      { x: 70, y: 60 },
      { x: 70, y: 90 },
      { x: 50, y: 90 },
    ]);
  });

  it("缺 zoneId 的对象整块跳过；非 zone 类型对象跳过", () => {
    const rt = mapRuntimeFromTiled(
      "z3",
      "zones-map",
      tiledMap({
        layers: [
          {
            type: "objectgroup",
            name: "zones",
            objects: [
              // 缺 zoneId → 跳过
              { id: 3, type: "zone", x: 0, y: 0, width: 10, height: 10 },
              // 非 zone 类型（即使有 zoneId）→ 跳过
              {
                id: 4,
                type: "other",
                x: 5,
                y: 5,
                width: 10,
                height: 10,
                properties: [{ name: "zoneId", type: "int", value: 99 }],
              },
              // 有效 zone
              {
                id: 5,
                type: "zone",
                x: 1,
                y: 1,
                width: 10,
                height: 10,
                properties: [{ name: "zoneId", type: "int", value: 9 }],
              },
            ],
          },
        ],
      }),
    );

    expect(rt.zones).toHaveLength(1);
    expect(rt.zones[0]!.id).toBe(9);
  });
});

describe("mapRuntimeFromTiled: objects objectgroup → 出生点", () => {
  it("spawn_player → player 位置；spawn_npc → npcs（kind/zoneId 取自 properties）", () => {
    const rt = mapRuntimeFromTiled(
      "o1",
      "objects-map",
      tiledMap({
        layers: [
          {
            type: "objectgroup",
            name: "objects",
            objects: [
              { id: 1, type: "spawn_player", x: 12, y: 34 },
              {
                id: 2,
                type: "spawn_npc",
                x: 100,
                y: 200,
                properties: [
                  { name: "npcKind", type: "string", value: "goblin" },
                  { name: "zoneId", type: "int", value: 5 },
                ],
              },
            ],
          },
        ],
      }),
    );

    expect(rt.spawns.player).toEqual({ x: 12, y: 34 });
    expect(rt.spawns.npcs).toHaveLength(1);
    expect(rt.spawns.npcs[0]!.kind).toBe("goblin");
    expect(rt.spawns.npcs[0]!.pos).toEqual({ x: 100, y: 200 });
    expect(rt.spawns.npcs[0]!.zoneId).toBe(5);
  });

  it("spawn_npc 无 npcKind → kind 缺省 'npc'；无 zoneId → zoneId 为 undefined", () => {
    const rt = mapRuntimeFromTiled(
      "o2",
      "objects-map",
      tiledMap({
        layers: [
          {
            type: "objectgroup",
            name: "objects",
            objects: [{ id: 1, type: "spawn_npc", x: 1, y: 2 }],
          },
        ],
      }),
    );

    expect(rt.spawns.npcs).toHaveLength(1);
    expect(rt.spawns.npcs[0]!.kind).toBe("npc");
    expect(rt.spawns.npcs[0]!.pos).toEqual({ x: 1, y: 2 });
    expect(rt.spawns.npcs[0]!.zoneId).toBeUndefined();
  });
});

describe("mapRuntimeFromTiled: 手护 grid 映射", () => {
  it("width/height/tilewidth/tileheight 从 Tiled JSON 读取并映射进 grid（行主序索引用例）", () => {
    // 8 列的 data（48 格），标记 (0,0) 与 (1,1) 两个非 0 格
    const data = Array<number>(48).fill(0);
    data[0] = 1; // 行 0 列 0
    data[1 * 8 + 1] = 1; // 行 1 列 1

    const rt = mapRuntimeFromTiled(
      "h1",
      "hand-map",
      tiledMap({
        width: 8,
        height: 6,
        tilewidth: 32,
        tileheight: 48,
        layers: [
          {
            type: "tilelayer",
            name: "collision",
            width: 8,
            height: 6,
            data,
          },
        ],
      }),
    );

    expect(rt.id).toBe("h1");
    expect(rt.name).toBe("hand-map");
    expect(rt.grid).toEqual({ width: 8, height: 6, tileWidth: 32, tileHeight: 48 });
    expect(rt.blocked.length).toBe(48);
    // 行主序：行 1 列 1 → idx = 1*8 + 1 = 9
    expect(rt.blocked[1 * 8 + 1]).toBe(1);
    expect(rt.blocked[0]).toBe(1);
    // 未标记的格为 0
    expect(rt.blocked[2]).toBe(0);
    expect(rt.blocked[47]).toBe(0);
  });

  it("缺省 tilewidth/tileheight 回退为 1", () => {
    const rt = mapRuntimeFromTiled("h2", "no-tile-size", {
      width: 2,
      height: 2,
      layers: [],
    });

    expect(rt.grid.tileWidth).toBe(1);
    expect(rt.grid.tileHeight).toBe(1);
  });
});
