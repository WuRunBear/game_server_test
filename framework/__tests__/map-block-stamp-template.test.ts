/**
 * "stamp-template" 生成积木测试（framework/map/generate/blocks/stampTemplate.ts）。
 *
 * 覆盖（docs/ecosystem-map-design.md §5.2 模板盖印契约）：
 * - ground 覆盖（含值域 >255 / 负数 / 非整数拒绝）；collision 覆盖（取反映射）；
 * - zones → regions：新区域名追加在既有 regions 末尾、regionOfTile 只重写
 *   覆盖格；同名 zone 合并同键；与既有区域重名沿用既有键与 meta；
 * - at 模式精确放置（含越界拒绝）；anchor 模板内校验与 region 模式锚点对齐；
 * - region 模式确定性：同 seed 同管道两次运行产出完全相同（候选 = ctx.rng
 *   纯函数）；候选耗尽 / 区域缺失 / 零覆盖 → 抛错；
 * - 参数 fail-fast：tiled/tiledPath 互斥、at/region 互斥、sizing 前置、
 *   region 模式要求前序 regions；
 * - 加载期约定端到端：tiledPath 经 loadGameDefinition 内联为 params.tiled、
 *   validateIntegrity 接受引用模板 zone 的实体规则。
 */
import { describe, it, expect, beforeAll, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bootstrapFramework, loadGameDefinition } from "framework/index";
import { stampTemplate } from "map/generate/blocks/stampTemplate";
import { registerBuiltinMapGenerators } from "map/generate/registerBuiltin";
import { createGeneratorRegistry } from "map/generate/generatorRegistry";
import { buildMapGeometry } from "map/generate/pipeline";
import { deriveStream } from "map/generate/rng";
import { createGeometryDraft } from "map/generate/types";
import type { GenerationContext, GeometryDraft, MapGenerationConfig } from "map/generate/types";
import type { EntityRule } from "map/evolution/schema";

/** 提取矩形区域内的行主序值（断言辅助）。 */
function rectValues(buf: Uint8Array, width: number, ox: number, oy: number, w: number, h: number): number[] {
  const out: number[] = [];
  for (let y = oy; y < oy + h; y++) {
    for (let x = ox; x < ox + w; x++) {
      out.push(buf[y * width + x]);
    }
  }
  return out;
}

/** 构造已定尺寸的草稿（全可走、tiles=0、regionOfTile=0、无区域）。 */
function makeSizedDraft(width = 10, height = 10, key = "stamp-map"): GeometryDraft {
  const draft = createGeometryDraft(key);
  draft.width = width;
  draft.height = height;
  draft.tileWidth = 16;
  draft.tileHeight = 16;
  draft.tiles = new Uint8Array(width * height);
  draft.walkable = new Uint8Array(width * height).fill(1);
  draft.regionOfTile = new Uint16Array(width * height);
  return draft;
}

/** 以给定 params 在草稿上运行 stamp-template（stepIndex 3 派生流，模拟管道后置位）。 */
function runBlock(params: unknown, draft: GeometryDraft, seed = 1): void {
  const ctx: GenerationContext = { key: draft.key, rng: deriveStream(seed, 3), geometry: draft, params };
  stampTemplate(ctx);
}

/** 主 fixture 的图层模板（4×3 / 16px：ground + collision + zones）。 */
const GROUND_DATA = [3, 3, 4, 4, 3, 3, 4, 4, 5, 5, 5, 5];
const COLLISION_DATA = [0, 1, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0];

/**
 * 构造主模板（4×3）：
 * - ground 行主序 [3,3,4,4 / 3,3,4,4 / 5,5,5,5]；
 * - collision 部分格阻挡；
 * - zones：plaza（矩形 32×16 → 模板格 (0,0)(1,0)）→ yard（矩形 32×32 →
 *   模板格 (2,1)(3,1)(2,2)(3,2)）。
 */
function makeTemplate(): Record<string, unknown> {
  return {
    width: 4,
    height: 3,
    tilewidth: 16,
    tileheight: 16,
    layers: [
      { type: "tilelayer", name: "ground", width: 4, height: 3, data: [...GROUND_DATA] },
      { type: "tilelayer", name: "collision", width: 4, height: 3, data: [...COLLISION_DATA] },
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
              { name: "zoneId", type: "int", value: 11 },
              { name: "name", type: "string", value: "plaza" },
            ],
          },
          {
            id: 2,
            type: "zone",
            name: "yard",
            x: 32,
            y: 16,
            width: 32,
            height: 32,
            properties: [{ name: "zoneId", type: "int", value: 12 }],
          },
        ],
      },
    ],
  };
}

/** 仅 ground 图层的 2×2 模板（值域/长度校验用）。 */
function groundOnlyTemplate(data: number[]): Record<string, unknown> {
  return {
    width: 2,
    height: 2,
    tilewidth: 16,
    tileheight: 16,
    layers: [{ type: "tilelayer", name: "ground", width: 2, height: 2, data }],
  };
}

/** 仅 collision 图层的模板（覆盖语义用）。 */
function collisionOnlyTemplate(data: number[], w = 2, h = 1): Record<string, unknown> {
  return {
    width: w,
    height: h,
    tilewidth: 16,
    tileheight: 16,
    layers: [{ type: "tilelayer", name: "collision", width: w, height: h, data }],
  };
}

describe("stamp-template: ground / collision 盖印覆盖", () => {
  it("at 模式精确放置：ground 整矩形覆盖 tiles、collision 取反覆盖 walkable、矩形外不动", () => {
    const draft = makeSizedDraft();
    draft.regions.set("plain", { name: "plain", meta: {} });
    runBlock({ tiled: makeTemplate(), at: { x: 2, y: 4 } }, draft);

    // ground：目标矩形 (2,4)~(5,6) 与模板数据逐格一致
    expect(rectValues(draft.tiles, 10, 2, 4, 4, 3)).toEqual(GROUND_DATA);
    // 矩形外不动
    expect(draft.tiles[0]).toBe(0);
    expect(draft.tiles[7 * 10 + 2]).toBe(0);

    // collision：非 0 → 0，0 → 1（与 tiled-source 同款取反映射）
    expect(rectValues(draft.walkable, 10, 2, 4, 4, 3)).toEqual([1, 0, 1, 0, 1, 1, 1, 1, 0, 1, 1, 1]);
    // 矩形外不动（全 1）
    expect(draft.walkable[0]).toBe(1);
    expect(draft.walkable[9 * 10 + 9]).toBe(1);
  });

  it("仅 collision 图层：walkable 覆盖、tiles 不动", () => {
    const draft = makeSizedDraft(4, 4);
    runBlock({ tiled: collisionOnlyTemplate([1, 0]), at: { x: 1, y: 1 } }, draft);

    expect(draft.walkable[1 * 4 + 1]).toBe(0);
    expect(draft.walkable[1 * 4 + 2]).toBe(1);
    expect(Array.from(draft.tiles)).toEqual(Array<number>(16).fill(0));
  });

  it("ground 值域：>255 / 负数 / 非整数 → 抛错且点名 data 下标（Uint8Array 前置校验）", () => {
    const draft = makeSizedDraft();
    expect(() => runBlock({ tiled: groundOnlyTemplate([0, 1, 2, 256]), at: { x: 0, y: 0 } }, draft)).toThrowError(
      /map "stamp-map".*ground tilelayer data\[3\].*\[0, 255\]/s,
    );
    expect(() => runBlock({ tiled: groundOnlyTemplate([0, 1, 2, -1]), at: { x: 0, y: 0 } }, draft)).toThrowError(
      /map "stamp-map".*ground tilelayer data\[3\]/s,
    );
    expect(() => runBlock({ tiled: groundOnlyTemplate([0, 1, 2, 1.5]), at: { x: 0, y: 0 } }, draft)).toThrowError(
      /map "stamp-map".*ground tilelayer data\[3\]/s,
    );
  });

  it("声明了 ground/collision 图层但 data 短于模板矩形 → 抛错（fail-fast，不截断）", () => {
    const draft = makeSizedDraft();
    expect(() => runBlock({ tiled: groundOnlyTemplate([1, 2, 3]), at: { x: 0, y: 0 } }, draft)).toThrowError(
      /map "stamp-map".*data length 3 < template area 4/s,
    );
  });

  it("at 模式模板矩形越界 → 抛错点名矩形与地图边界", () => {
    const draft = makeSizedDraft(10, 10);
    expect(() => runBlock({ tiled: makeTemplate(), at: { x: 8, y: 8 } }, draft)).toThrowError(
      /map "stamp-map".*template rect 4x3 at \(8, 8\).*exceeds map bounds 10x10/s,
    );
    // 贴边恰好放下 → 合法
    expect(() => runBlock({ tiled: makeTemplate(), at: { x: 6, y: 7 } }, draft)).not.toThrow();
  });
});

describe("stamp-template: zones → regions 追加与重写", () => {
  it("新区域名追加在既有 regions 末尾；regionOfTile 只重写覆盖格、未覆盖格保持前序归属", () => {
    const draft = makeSizedDraft();
    draft.regions.set("plain", { name: "plain", meta: {} });
    runBlock({ tiled: makeTemplate(), at: { x: 2, y: 4 } }, draft);

    // 追加顺序：plain（既有）→ plaza → yard（声明序）
    expect([...draft.regions.keys()]).toEqual(["plain", "plaza", "yard"]);
    expect(draft.regions.get("plaza")?.meta).toEqual({ zoneId: 11 });
    expect(draft.regions.get("yard")?.meta).toEqual({ zoneId: 12 });

    // plaza 覆盖世界格 (2,4)(3,4)；yard 覆盖 (4,5)(5,5)(4,6)(5,6)
    expect(draft.regionOfTile[4 * 10 + 2]).toBe(1);
    expect(draft.regionOfTile[4 * 10 + 3]).toBe(1);
    expect(draft.regionOfTile[5 * 10 + 4]).toBe(2);
    expect(draft.regionOfTile[5 * 10 + 5]).toBe(2);
    expect(draft.regionOfTile[6 * 10 + 4]).toBe(2);
    expect(draft.regionOfTile[6 * 10 + 5]).toBe(2);
    // 盖印矩形内未被 zone 覆盖的格保持前序归属（plain = 0）
    expect(draft.regionOfTile[6 * 10 + 2]).toBe(0);
    // 矩形外完全不动
    expect(draft.regionOfTile[0]).toBe(0);
  });

  it("同名 zone 合并同一 regions 键（首个 zoneId 作 meta），两处覆盖格都指向该键", () => {
    const template: Record<string, unknown> = {
      width: 4,
      height: 2,
      tilewidth: 16,
      tileheight: 16,
      layers: [
        {
          type: "objectgroup",
          name: "zones",
          objects: [
            {
              id: 1,
              type: "zone",
              x: 0,
              y: 0,
              width: 16,
              height: 16,
              properties: [
                { name: "zoneId", type: "int", value: 11 },
                { name: "name", type: "string", value: "plaza" },
              ],
            },
            {
              id: 2,
              type: "zone",
              x: 32,
              y: 0,
              width: 16,
              height: 16,
              properties: [
                { name: "zoneId", type: "int", value: 99 },
                { name: "name", type: "string", value: "plaza" },
              ],
            },
          ],
        },
      ],
    };
    const draft = makeSizedDraft();
    draft.regions.set("plain", { name: "plain", meta: {} });
    runBlock({ tiled: template, at: { x: 0, y: 0 } }, draft);

    // 只有一个 plaza 键（不抛重名错）；meta 取首个声明
    expect([...draft.regions.keys()]).toEqual(["plain", "plaza"]);
    expect(draft.regions.get("plaza")?.meta).toEqual({ zoneId: 11 });
    // 两处矩形（模板格 (0,0) 与 (2,0)）都指向 plaza
    expect(draft.regionOfTile[0]).toBe(1);
    expect(draft.regionOfTile[2]).toBe(1);
  });

  it("zone 与既有区域重名：不新增键、不改既有 meta，仅重写覆盖格归属", () => {
    const template: Record<string, unknown> = {
      width: 2,
      height: 1,
      tilewidth: 16,
      tileheight: 16,
      layers: [
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
                { name: "zoneId", type: "int", value: 7 },
                { name: "name", type: "string", value: "village" },
              ],
            },
          ],
        },
      ],
    };
    const draft = makeSizedDraft();
    draft.regions.set("village", { name: "village", meta: {} });
    runBlock({ tiled: template, at: { x: 3, y: 3 } }, draft);

    expect([...draft.regions.keys()]).toEqual(["village"]);
    expect(draft.regions.get("village")?.meta).toEqual({});
    expect(draft.regionOfTile[3 * 10 + 3]).toBe(0);
    expect(draft.regionOfTile[3 * 10 + 4]).toBe(0);
  });

  it("仅 zones 图层（无 ground/collision）：区域追加、tiles/walkable 不动", () => {
    const template: Record<string, unknown> = {
      width: 2,
      height: 2,
      tilewidth: 16,
      tileheight: 16,
      layers: [
        {
          type: "objectgroup",
          name: "zones",
          objects: [
            { id: 1, type: "zone", x: 0, y: 0, width: 32, height: 32, properties: [{ name: "zoneId", type: "int", value: 5 }] },
          ],
        },
      ],
    };
    const draft = makeSizedDraft();
    draft.regions.set("plain", { name: "plain", meta: {} });
    runBlock({ tiled: template, at: { x: 1, y: 1 } }, draft);

    expect([...draft.regions.keys()]).toEqual(["plain", "zone_5"]);
    expect(Array.from(draft.tiles)).toEqual(Array<number>(100).fill(0));
    expect(draft.regionOfTile[1 * 10 + 1]).toBe(1);
    expect(draft.regionOfTile[2 * 10 + 2]).toBe(1);
  });
});

describe("stamp-template: region 模式确定性选点", () => {
  /** 20×20 草稿：grassland（index 0）= 左上 10×10 象限，其余 wilderness。 */
  function makeRegionDraft(): GeometryDraft {
    const draft = makeSizedDraft(20, 20, "region-map");
    draft.regions.set("grassland", { name: "grassland", meta: {} });
    draft.regions.set("wilderness", { name: "wilderness", meta: {} });
    for (let y = 0; y < 20; y++) {
      for (let x = 0; x < 20; x++) {
        draft.regionOfTile[y * 20 + x] = x < 10 && y < 10 ? 0 : 1;
      }
    }
    return draft;
  }

  /** 3×2 纯 ground 模板（值全 1，用于定位盖印原点）。 */
  const REGION_TEMPLATE = {
    width: 3,
    height: 2,
    tilewidth: 16,
    tileheight: 16,
    layers: [{ type: "tilelayer", name: "ground", width: 3, height: 2, data: [1, 1, 1, 1, 1, 1] }],
  };

  /** 找 ground 盖印原点（tiles 中第一个非 0 值）。 */
  function stampedOrigin(draft: GeometryDraft): { x: number; y: number } {
    const index = Array.from(draft.tiles).indexOf(1);
    expect(index).toBeGreaterThanOrEqual(0);
    return { x: index % draft.width, y: Math.floor(index / draft.width) };
  }

  it("同 seed 同管道两次运行：盖印位置与全部缓冲完全一致（候选 = ctx.rng 纯函数）", () => {
    const a = makeRegionDraft();
    const b = makeRegionDraft();
    runBlock({ tiled: REGION_TEMPLATE, region: "grassland" }, a, 1);
    runBlock({ tiled: REGION_TEMPLATE, region: "grassland" }, b, 1);

    expect(stampedOrigin(a)).toEqual(stampedOrigin(b));
    expect(Array.from(a.tiles)).toEqual(Array.from(b.tiles));
    expect(Array.from(a.walkable)).toEqual(Array.from(b.walkable));
    expect(Array.from(a.regionOfTile)).toEqual(Array.from(b.regionOfTile));
    expect([...a.regions.entries()]).toEqual([...b.regions.entries()]);
  });

  it("锚点对齐：anchor 格对齐选点格（模板原点 = 选点 - anchor）", () => {
    // plain 区域恰好只有 (5,5) 一格 → 选点确定
    const draft = makeSizedDraft(10, 10, "anchor-map");
    draft.regions.set("plain", { name: "plain", meta: {} });
    draft.regions.set("void", { name: "void", meta: {} });
    for (let i = 0; i < 100; i++) draft.regionOfTile[i] = i === 55 ? 0 : 1;

    const anchorTemplate = {
      width: 3,
      height: 3,
      tilewidth: 16,
      tileheight: 16,
      layers: [{ type: "tilelayer", name: "ground", width: 3, height: 3, data: Array<number>(9).fill(7) }],
    };
    runBlock({ tiled: anchorTemplate, region: "plain", anchor: { x: 1, y: 1 } }, draft, 1);

    // 选点 (5,5) - anchor (1,1) = 原点 (4,4)：矩形 (4,4)~(6,6)，中心即 (5,5)
    expect(rectValues(draft.tiles, 10, 4, 4, 3, 3)).toEqual(Array<number>(9).fill(7));
    expect(draft.tiles[5 * 10 + 5]).toBe(7);
    expect(draft.tiles[4 * 10 + 4]).toBe(7);
    expect(draft.tiles[3 * 10 + 3]).toBe(0);
  });

  it("候选耗尽 → 抛错点名区域与模板尺寸（宁可失败不静默跳过）", () => {
    // plain 仅 (5,5) 一格；6×6 模板从 (5,5) 起必然越界 → 32 次候选全被过滤
    const draft = makeSizedDraft(10, 10, "exhausted-map");
    draft.regions.set("plain", { name: "plain", meta: {} });
    draft.regions.set("void", { name: "void", meta: {} });
    for (let i = 0; i < 100; i++) draft.regionOfTile[i] = i === 55 ? 0 : 1;

    const bigTemplate = {
      width: 6,
      height: 6,
      tilewidth: 16,
      tileheight: 16,
      layers: [{ type: "tilelayer", name: "ground", width: 6, height: 6, data: Array<number>(36).fill(1) }],
    };
    expect(() => runBlock({ tiled: bigTemplate, region: "plain" }, draft, 1)).toThrowError(
      /map "exhausted-map".*candidates exhausted.*template 6x6.*region "plain"/s,
    );
  });

  it("目标区域不存在 → 抛错点名区域", () => {
    const draft = makeRegionDraft();
    expect(() => runBlock({ tiled: REGION_TEMPLATE, region: "nope" }, draft, 1)).toThrowError(
      /map "region-map".*region "nope" does not exist/s,
    );
  });

  it("目标区域零覆盖 → 抛错", () => {
    const draft = makeSizedDraft(10, 10, "ghost-map");
    draft.regions.set("plain", { name: "plain", meta: {} });
    draft.regions.set("ghost", { name: "ghost", meta: {} });
    // 全部格指向 plain（0），ghost 无覆盖
    expect(() => runBlock({ tiled: REGION_TEMPLATE, region: "ghost" }, draft, 1)).toThrowError(
      /map "ghost-map".*region "ghost" covers no tiles/s,
    );
  });

  it("region 模式要求前序积木已建 regions（regions 为空 → 抛错）", () => {
    const draft = makeSizedDraft(10, 10, "no-regions-map");
    expect(() => runBlock({ tiled: REGION_TEMPLATE, region: "plain" }, draft, 1)).toThrowError(
      /map "no-regions-map".*region mode requires regions built by a prior pipeline block/s,
    );
  });
});

describe("stamp-template: 参数 fail-fast", () => {
  it("at + region 同时声明 → 抛错；都缺 → 抛错", () => {
    const draft = makeSizedDraft();
    draft.regions.set("plain", { name: "plain", meta: {} });
    expect(() => runBlock({ tiled: makeTemplate(), at: { x: 0, y: 0 }, region: "plain" }, draft)).toThrowError(
      /map "stamp-map".*exactly one of at \/ region/s,
    );
    expect(() => runBlock({ tiled: makeTemplate() }, draft)).toThrowError(
      /map "stamp-map".*exactly one of at \/ region/s,
    );
  });

  it("缺 tiled / tiled 为字符串 / tiledPath 未内联 / path 参数 → 各自抛错（积木零文件 I/O）", () => {
    const draft = makeSizedDraft();
    expect(() => runBlock({}, draft)).toThrowError(/map "stamp-map".*tiled is required/s);
    expect(() => runBlock({ tiled: "game/maps/tpl.json" }, draft)).toThrowError(
      /map "stamp-map".*not a file path/s,
    );
    expect(() => runBlock({ tiled: makeTemplate(), tiledPath: "game/maps/tpl.json", at: { x: 0, y: 0 } }, draft)).toThrowError(
      /map "stamp-map".*tiledPath.*no file I\/O/s,
    );
    expect(() => runBlock({ path: "game/maps/tpl.json" }, draft)).toThrowError(
      /map "stamp-map".*"path".*no file I\/O/s,
    );
  });

  it("anchor 非法（越出模板 / 负数 / 非对象）→ 抛错", () => {
    const draft = makeSizedDraft();
    expect(() => runBlock({ tiled: makeTemplate(), at: { x: 0, y: 0 }, anchor: { x: 4, y: 0 } }, draft)).toThrowError(
      /map "stamp-map".*anchor \(4, 0\).*inside the template rect 4x3/s,
    );
    expect(() => runBlock({ tiled: makeTemplate(), at: { x: 0, y: 0 }, anchor: { x: -1, y: 0 } }, draft)).toThrowError(
      /map "stamp-map".*anchor must have non-negative integer/s,
    );
    expect(() => runBlock({ tiled: makeTemplate(), at: { x: 0, y: 0 }, anchor: "center" }, draft)).toThrowError(
      /map "stamp-map".*anchor must be a tile position object/s,
    );
  });

  it("at / region 形状非法 → 抛错点名参数", () => {
    const draft = makeSizedDraft();
    expect(() => runBlock({ tiled: makeTemplate(), at: { x: 0.5, y: 0 } }, draft)).toThrowError(
      /map "stamp-map".*at must have non-negative integer/s,
    );
    expect(() => runBlock({ tiled: makeTemplate(), at: "origin" }, draft)).toThrowError(
      /map "stamp-map".*at must be a tile position object/s,
    );
    expect(() => runBlock({ tiled: makeTemplate(), region: 42 }, draft)).toThrowError(
      /map "stamp-map".*region must be a non-empty string/s,
    );
  });

  it("模板缺 layers / 尺寸非法 / 三约定图层全缺 → 抛错且含地图 key", () => {
    const draft = makeSizedDraft();
    expect(() => runBlock({ tiled: { width: 4, height: 3 }, at: { x: 0, y: 0 } }, draft)).toThrowError(
      /map "stamp-map".*layers/s,
    );
    expect(() => runBlock({ tiled: { width: 0, height: 3, layers: [] }, at: { x: 0, y: 0 } }, draft)).toThrowError(
      /map "stamp-map".*dimensions/s,
    );
    expect(() => runBlock({ tiled: { width: 4, height: 3, tilewidth: 16, tileheight: 16, layers: [] }, at: { x: 0, y: 0 } }, draft)).toThrowError(
      /map "stamp-map".*at least one of the "ground" \/ "collision"/s,
    );
  });

  it("sizing 前置：未定尺寸的草稿 → 抛错点名需先跑 sizing 积木", () => {
    const draft = createGeometryDraft("raw-map");
    expect(() => runBlock({ tiled: makeTemplate(), at: { x: 0, y: 0 } }, draft)).toThrowError(
      /map "raw-map".*a sizing block must run first/s,
    );
  });

  it("at 模式不要求 regions（区域为空也放行；regions 为空由出口校验兜底）", () => {
    const draft = makeSizedDraft(4, 4, "at-empty-regions");
    expect(() => runBlock({ tiled: groundOnlyTemplate([1, 1, 1, 1]), at: { x: 0, y: 0 } }, draft)).not.toThrow();
  });
});

describe("stamp-template: buildMapGeometry 端到端", () => {
  /** noise-terrain → climate-regions → stamp-template(region) 完整管道。 */
  function makeConfig(seed: number): MapGenerationConfig {
    return {
      key: "stamp-e2e",
      seed,
      pipeline: [
        {
          generator: "noise-terrain",
          params: {
            width: 24,
            height: 24,
            tileWidth: 16,
            tileHeight: 16,
            bandLevel: 0.3,
            groundPalette: { "1": 0.3, "2": 1 },
            nonWalkableSemantics: [1],
          },
        },
        { generator: "climate-regions", params: { names: ["plain"], style: "noise", minArea: 100 } },
        {
          generator: "stamp-template",
          params: {
            region: "plain",
            tiled: {
              width: 3,
              height: 2,
              tilewidth: 16,
              tileheight: 16,
              layers: [
                { type: "tilelayer", name: "ground", width: 3, height: 2, data: [3, 3, 3, 3, 3, 3] },
                {
                  type: "objectgroup",
                  name: "zones",
                  objects: [
                    {
                      id: 1,
                      type: "zone",
                      x: 0,
                      y: 0,
                      width: 48,
                      height: 32,
                      properties: [
                        { name: "zoneId", type: "int", value: 1 },
                        { name: "name", type: "string", value: "plaza" },
                      ],
                    },
                  ],
                },
              ],
            },
          },
        },
      ],
    };
  }

  it("管道接线：模板 zone 追加在 regions 末尾且有覆盖；出口校验通过", () => {
    const registry = createGeneratorRegistry();
    registerBuiltinMapGenerators(registry);
    const geometry = buildMapGeometry(makeConfig(99), registry);

    const names = [...geometry.regions.keys()];
    expect(names).toContain("plain");
    expect(names).toContain("plaza");
    // plaza 追加在 climate 区之后且有覆盖格
    expect(names.indexOf("plaza")).toBeGreaterThan(names.indexOf("plain"));
    const plazaIndex = names.indexOf("plaza");
    expect(Array.from(geometry.regionOfTile).some((v) => v === plazaIndex)).toBe(true);
    expect(geometry.version).not.toBe("");
  });

  it("确定性：同 seed 同管道两次运行产出相同内容指纹（选点为纯函数）", () => {
    const registry = createGeneratorRegistry();
    registerBuiltinMapGenerators(registry);
    const a = buildMapGeometry(makeConfig(99), registry);
    const b = buildMapGeometry(makeConfig(99), registry);
    expect(a.version).toBe(b.version);
  });
});

/**
 * tiledPath 加载期内联端到端（loadGameDefinition + validateIntegrity）：
 * 临时 game 目录驱动真实加载链路（zod → resolveMapConfigs 内联 → 完整性校验）。
 */
describe("stamp-template: tiledPath 加载期内联与规则引用校验", () => {
  beforeAll(() => {
    bootstrapFramework();
  });

  const GAME_JSON = {
    id: "stamp-template-fixture",
    tickRate: 20,
    map: { registry: "./maps/registry.json", entityRules: "./maps/entity-rules.json" },
    entities: "./entities/*.json",
    systems: [],
  };

  const TEMPLATE_JSON = {
    width: 2,
    height: 2,
    tilewidth: 16,
    tileheight: 16,
    layers: [
      { type: "tilelayer", name: "ground", width: 2, height: 2, data: [3, 3, 3, 3] },
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
            height: 32,
            properties: [
              { name: "zoneId", type: "int", value: 1 },
              { name: "name", type: "string", value: "plaza" },
            ],
          },
        ],
      },
    ],
  };

  function makeRegistryJson(stampParams: Record<string, unknown>): Record<string, unknown> {
    return {
      maps: {
        village: {
          kind: "pipeline",
          seed: 7,
          initialAgeTicks: 0,
          pipeline: [
            {
              generator: "noise-terrain",
              params: {
                width: 16,
                height: 16,
                tileWidth: 16,
                tileHeight: 16,
                bandLevel: 0.3,
                groundPalette: { "1": 0.3, "2": 1 },
                nonWalkableSemantics: [1],
              },
            },
            { generator: "climate-regions", params: { names: ["plain"], style: "noise" } },
            { generator: "stamp-template", params: stampParams },
          ],
        },
      },
    };
  }

  /** 在临时目录组装最小 game 配置（tiledPath 相对 maps/registry.json 解析）。 */
  function writeGameDir(stampParams: Record<string, unknown>, rules: EntityRule[], withTemplateFile = true): string {
    const dir = mkdtempSync(join(tmpdir(), "stamp-template-"));
    mkdirSync(join(dir, "entities"), { recursive: true });
    mkdirSync(join(dir, "maps", "templates"), { recursive: true });
    writeFileSync(join(dir, "game.json"), JSON.stringify(GAME_JSON));
    writeFileSync(join(dir, "entities", "kind.json"), JSON.stringify({ kind: "kind_a", components: {} }));
    writeFileSync(join(dir, "maps", "registry.json"), JSON.stringify(makeRegistryJson(stampParams)));
    if (withTemplateFile) {
      writeFileSync(join(dir, "maps", "templates", "plaza.json"), JSON.stringify(TEMPLATE_JSON));
    }
    writeFileSync(join(dir, "maps", "entity-rules.json"), JSON.stringify({ rules }));
    return dir;
  }

  const dirs: string[] = [];
  const makeDir = (...args: Parameters<typeof writeGameDir>): string => {
    const dir = writeGameDir(...args);
    dirs.push(dir);
    return dir;
  };

  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it("tiledPath 读文件内联为 params.tiled 并移除 tiledPath（路径相对地图注册表文件目录）", () => {
    const dir = makeDir({ tiledPath: "templates/plaza.json", at: { x: 1, y: 1 } }, []);
    const loaded = loadGameDefinition({ gameJsonPath: join(dir, "game.json") });

    const config = loaded.resolvedMapConfigs.find((c) => c.key === "village");
    expect(config).toBeDefined();
    const step = config!.pipeline[2];
    expect(step.generator).toBe("stamp-template");
    expect(step.params!.tiled).toEqual(TEMPLATE_JSON);
    expect(step.params!.tiledPath).toBeUndefined();
    expect(step.params!.at).toEqual({ x: 1, y: 1 });
  });

  it("validateIntegrity 接受引用模板 zone 的实体规则", () => {
    const dir = makeDir(
      { tiledPath: "templates/plaza.json", at: { x: 1, y: 1 } },
      [{ mode: "density", map: "village", region: "plaza", kind: "kind_a", max: 1, every: 10 }],
    );
    expect(() => loadGameDefinition({ gameJsonPath: join(dir, "game.json") })).not.toThrow();
  });

  it("模板文件缺失 → 抛错点名 map key、步骤与路径", () => {
    const dir = makeDir({ tiledPath: "templates/missing.json", at: { x: 1, y: 1 } }, [], false);
    expect(() => loadGameDefinition({ gameJsonPath: join(dir, "game.json") })).toThrowError(
      /map "village" pipeline step 2 \(stamp-template\).*templates\/missing\.json.*failed to load/s,
    );
  });

  it("tiled 与 tiledPath 同时声明 → 抛错", () => {
    const dir = makeDir(
      { tiled: TEMPLATE_JSON, tiledPath: "templates/plaza.json", at: { x: 1, y: 1 } },
      [],
    );
    expect(() => loadGameDefinition({ gameJsonPath: join(dir, "game.json") })).toThrowError(
      /map "village" pipeline step 2 \(stamp-template\).*both "tiled" and "tiledPath"/s,
    );
  });
});
