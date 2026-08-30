/**
 * "tiled-source" 生成积木测试（framework/map/generate/blocks/tiledSource.ts）。
 *
 * 覆盖（D12：Tiled 能力保留为积木，不增强）：
 * - walkable 反转与截断语义：collision data=1 → walkable=0（逐格内联期望值
 *   钉死）；数据短于网格的剩余格可走（Math.min 截断语义）；
 * - zones → regions：区域名按声明顺序写入 regions（插入顺序即索引序），
 *   regionOfTile 索引可解析回正确区域名（tile 中心点落在多边形内栅格化）；
 * - 确定性：同一 fixture 两次运行（不同 rng 流）产出深相等——Tiled 导入
 *   完全由 JSON 决定，不使用 ctx.rng；
 * - 畸形内联 JSON：缺 layers / 尺寸越界 / 非对象 / zone 重名 → 抛错且消息
 *   含地图 key；
 * - path 拒绝：path 参数与字符串形式的 tiled 一律拒绝（积木不做文件 I/O）。
 */
import { describe, expect, it } from "vitest";
import { tiledSource } from "map/generate/blocks/tiledSource";
import { deriveStream } from "map/generate/rng";
import { createGeometryDraft } from "map/generate/types";
import type { GenerationContext, GeometryDraft } from "map/generate/types";

/** 主 fixture 的 collision 数据：10 项 < 4×3=12 格（钉住截断语义：剩余格可走）。 */
const COLLISION_DATA = [1, 0, 0, 1, 0, 1, 0, 0, 0, 0];

/**
 * 构造最小手写 Tiled 导出 JSON（4×3 / 16px tile）：
 * - collision tilelayer：部分格阻挡；
 * - zones objectgroup：meadow（矩形兜底，名字来自 properties.name）→
 *   grove（多边形，名字来自对象 name）→ 两个应被跳过的对象（非 zone 类型 /
 *   缺 zoneId）。
 *
 * @returns 内联 Tiled JSON 对象
 */
function makeTiledJson(): Record<string, unknown> {
  return {
    width: 4,
    height: 3,
    tilewidth: 16,
    tileheight: 16,
    layers: [
      {
        type: "tilelayer",
        name: "collision",
        width: 4,
        height: 3,
        data: [...COLLISION_DATA],
      },
      {
        type: "objectgroup",
        name: "zones",
        objects: [
          {
            id: 1,
            type: "zone",
            x: 0,
            y: 0,
            width: 32,
            height: 16,
            properties: [
              { name: "zoneId", type: "int", value: 3 },
              { name: "name", type: "string", value: "meadow" },
            ],
          },
          {
            id: 2,
            type: "zone",
            name: "grove",
            x: 32,
            y: 0,
            polygon: [
              { x: 0, y: 0 },
              { x: 32, y: 0 },
              { x: 32, y: 32 },
              { x: 0, y: 32 },
            ],
            properties: [{ name: "zoneId", type: "int", value: 7 }],
          },
          // 非 zone 类型（即使带 zoneId）→ 跳过（与旧解析一致）
          {
            id: 3,
            type: "decoration",
            x: 0,
            y: 0,
            width: 64,
            height: 48,
            properties: [{ name: "zoneId", type: "int", value: 99 }],
          },
          // 缺 zoneId → 跳过（与旧解析一致）
          { id: 4, type: "zone", x: 0, y: 0, width: 8, height: 8 },
        ],
      },
    ],
  };
}

/**
 * 以给定 params 运行 tiled-source 积木，返回写入后的几何草稿。
 *
 * @param params 积木参数切片
 * @param key 地图 key（默认 "tiled-map"）
 * @param seed rng 流种子（积木不应消费 rng；不同 seed 结果必须一致）
 * @returns 写入后的 GeometryDraft
 */
function runBlock(params: unknown, key = "tiled-map", seed = 1): GeometryDraft {
  const geometry = createGeometryDraft(key);
  const ctx: GenerationContext = {
    key,
    rng: deriveStream(seed, 0),
    geometry,
    params,
  };
  tiledSource(ctx);
  return geometry;
}

describe("tiled-source: walkable 反转与截断语义（内联期望值）", () => {
  it("collision data=1 → walkable=0（逐格内联期望）；数据短于网格的剩余格可走；尺寸一致", () => {
    const draft = runBlock({ tiled: makeTiledJson() });

    // 尺寸与 tile 像素尺寸（fixture：4×3 / 16px）
    expect(draft.width).toBe(4);
    expect(draft.height).toBe(3);
    expect(draft.tileWidth).toBe(16);
    expect(draft.tileHeight).toBe(16);

    // 逐格内联期望：COLLISION_DATA 前 10 项按 1→0 / 0→1 反转；
    // 末尾 2 格（数据 10 项 < 4×3=12 格）截断语义 → 可走
    expect(Array.from(draft.walkable)).toEqual([0, 1, 1, 0, 1, 0, 1, 1, 1, 1, 1, 1]);

    // Tiled 导入不携带地面语义：tiles 恒 0
    expect(Array.from(draft.tiles)).toEqual(Array<number>(12).fill(0));
  });

  it("缺失 collision 层 → 全可走", () => {
    const json = { width: 2, height: 2, tilewidth: 16, tileheight: 16, layers: [] };
    const draft = runBlock({ tiled: json });

    expect(Array.from(draft.walkable)).toEqual([1, 1, 1, 1]);
  });
});

describe("tiled-source: zones → regions 映射", () => {
  it("区域名按声明顺序写入 regions；regionOfTile 索引解析回正确区域名", () => {
    const draft = runBlock({ tiled: makeTiledJson() });

    // 插入顺序 = 声明顺序（meadow → grove），兜底区 wilderness 追加在后
    expect([...draft.regions.keys()]).toEqual(["meadow", "grove", "wilderness"]);

    // 栅格化（tile 中心点，行主序）：meadow 覆盖 (0,0)(1,0)，grove 覆盖
    // (2,0)(3,0)(2,1)(3,1)，其余 → wilderness
    expect(Array.from(draft.regionOfTile)).toEqual([0, 0, 1, 1, 2, 2, 1, 1, 2, 2, 2, 2]);

    // 索引可解析回区域名
    const names = [...draft.regions.keys()];
    expect(names[draft.regionOfTile[0]]).toBe("meadow");
    expect(names[draft.regionOfTile[2]]).toBe("grove");
    expect(names[draft.regionOfTile[4]]).toBe("wilderness");

    // zoneId 保留进 RegionMeta.meta；兜底区 meta 为空
    expect(draft.regions.get("meadow")?.meta).toEqual({ zoneId: 3 });
    expect(draft.regions.get("grove")?.meta).toEqual({ zoneId: 7 });
    expect(draft.regions.get("wilderness")?.meta).toEqual({});
  });

  it("非 zone 类型与缺 zoneId 的对象跳过（与旧解析一致）", () => {
    const draft = runBlock({ tiled: makeTiledJson() });

    // fixture 中 decoration（带 zoneId=99）与缺 zoneId 的 zone 均不入 regions
    expect(draft.regions.has("zone_99")).toBe(false);
    expect([...draft.regions.keys()]).toEqual(["meadow", "grove", "wilderness"]);
  });
});

describe("tiled-source: 确定性", () => {
  it("同一 fixture 两次运行（不同 rng 流）产出深相等——不消费 ctx.rng", () => {
    const a = runBlock({ tiled: makeTiledJson() }, "tiled-map", 1);
    const b = runBlock({ tiled: makeTiledJson() }, "tiled-map", 4242);

    expect(a.width).toBe(b.width);
    expect(a.height).toBe(b.height);
    expect(Array.from(a.tiles)).toEqual(Array.from(b.tiles));
    expect(Array.from(a.walkable)).toEqual(Array.from(b.walkable));
    expect(Array.from(a.regionOfTile)).toEqual(Array.from(b.regionOfTile));
    expect([...a.regions.entries()]).toEqual([...b.regions.entries()]);
  });
});

describe("tiled-source: 畸形内联 JSON 拒绝（消息含地图 key）", () => {
  it("缺 layers 数组 → 抛错且含 map key", () => {
    expect(() => runBlock({ tiled: { width: 4, height: 3 } })).toThrowError(/map "tiled-map".*layers/s);
  });

  it("尺寸越界（width=0 / height 为负 / 非数值）→ 抛错且含 map key", () => {
    expect(() => runBlock({ tiled: { width: 0, height: 3, layers: [] } })).toThrowError(
      /map "tiled-map".*dimensions/s,
    );
    expect(() => runBlock({ tiled: { width: 4, height: -2, layers: [] } })).toThrowError(
      /map "tiled-map".*dimensions/s,
    );
    expect(() => runBlock({ tiled: { width: "4", height: 3, layers: [] } })).toThrowError(
      /map "tiled-map".*dimensions/s,
    );
  });

  it("tile 像素尺寸非法（≤0 / 非数值）→ 抛错且含 map key", () => {
    expect(() =>
      runBlock({ tiled: { width: 4, height: 3, tilewidth: 0, tileheight: 16, layers: [] } }),
    ).toThrowError(/map "tiled-map".*tile size/s);
    expect(() =>
      runBlock({ tiled: { width: 4, height: 3, tilewidth: 16, tileheight: "16", layers: [] } }),
    ).toThrowError(/map "tiled-map".*tile size/s);
  });

  it("tiled 非对象（数字 / null / 数组）→ 抛错且含 map key", () => {
    expect(() => runBlock({ tiled: 42 })).toThrowError(/map "tiled-map".*inline Tiled JSON/s);
    expect(() => runBlock({ tiled: null })).toThrowError(/map "tiled-map".*inline Tiled JSON/s);
    expect(() => runBlock({ tiled: [1, 2] })).toThrowError(/map "tiled-map".*inline Tiled JSON/s);
  });

  it("两个 zone 解析出相同区域名 → 抛错且含 map key", () => {
    const json = {
      width: 2,
      height: 2,
      tilewidth: 16,
      tileheight: 16,
      layers: [
        {
          type: "objectgroup",
          name: "zones",
          objects: [
            { id: 1, type: "zone", x: 0, y: 0, width: 8, height: 8,
              properties: [{ name: "zoneId", type: "int", value: 1 }, { name: "name", type: "string", value: "twin" }] },
            { id: 2, type: "zone", x: 8, y: 8, width: 8, height: 8,
              properties: [{ name: "zoneId", type: "int", value: 2 }, { name: "name", type: "string", value: "twin" }] },
          ],
        },
      ],
    };
    expect(() => runBlock({ tiled: json })).toThrowError(/map "tiled-map".*duplicate zone name/s);
  });
});

describe("tiled-source: path 拒绝（积木不做文件 I/O）", () => {
  it("params.path → 抛错并指明应内联 JSON", () => {
    expect(() => runBlock({ path: "game/maps/island.json" })).toThrowError(
      /map "tiled-map".*"path".*no file I\/O/s,
    );
  });

  it("params.tiled 为字符串（路径形式）→ 抛错并指明应内联 JSON", () => {
    expect(() => runBlock({ tiled: "game/maps/island.json" })).toThrowError(
      /map "tiled-map".*not a file path.*no file I\/O/s,
    );
  });
});
