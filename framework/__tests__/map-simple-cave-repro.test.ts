/**
 * simple / cave 两个内置地图生成器的可复现性与不变量测试。
 *
 * 直接调用 generateSimpleMap 与 generateCaveMap（不经 buildRuntime 注册表），
 * 验证纯生成算法本身的确定性 + 结构不变量：
 * - 可复现：同种子 → blocked 字节一致 + 玩家坐标一致（xorshift32 伪随机确定性）。
 * - simple：边界一圈全墙；玩家精确在地图中心；单个默认区域 id 1；无 npcSpawns → npcs 空。
 * - cave：边界一圈恒墙；玩家落在可走格；玩家像素坐标对齐 tile 中心；单个默认区域 id 1。
 */
import { describe, expect, it } from "vitest";
import { generateSimpleMap } from "framework/map/generated/simple";
import type { SimpleGeneratorOptions } from "framework/map/generated/simple";
import { generateCaveMap } from "framework/map/generated/cave";
import type { CaveGeneratorOptions } from "framework/map/generated/cave";

const S_W = 64;
const S_H = 64;
const S_T = 16;

/** 构造 simple 生成器参数（可覆盖 seed 等）。 */
function simpleOpts(seed: number, extra: Partial<SimpleGeneratorOptions> = {}): SimpleGeneratorOptions {
  return {
    id: "simple",
    name: "simple",
    seed,
    width: S_W,
    height: S_H,
    tileWidth: S_T,
    tileHeight: S_T,
    ...extra,
  };
}

describe("simple 生成器：可复现性与结构不变量", () => {
  it("同种子（seed=42）→ blocked 字节一致 + 玩家坐标一致", () => {
    const a = generateSimpleMap(simpleOpts(42));
    const b = generateSimpleMap(simpleOpts(42));

    expect(Array.from(a.blocked)).toEqual(Array.from(b.blocked));
    expect(a.spawns.player).toEqual(b.spawns.player);
  });

  it("边界一圈全墙", () => {
    const rt = generateSimpleMap(simpleOpts(42));
    const { blocked, grid } = rt;

    for (let y = 0; y < grid.height; y++) {
      expect(blocked[y * grid.width]).toBe(1); // 左列
      expect(blocked[y * grid.width + (grid.width - 1)]).toBe(1); // 右列
    }
    for (let x = 0; x < grid.width; x++) {
      expect(blocked[x]).toBe(1); // 顶行
      expect(blocked[(grid.height - 1) * grid.width + x]).toBe(1); // 底行
    }
  });

  it("玩家精确在地图中心 (width*tileW*0.5, height*tileH*0.5)", () => {
    const rt = generateSimpleMap(simpleOpts(42));

    expect(rt.spawns.player).toEqual({ x: S_W * S_T * 0.5, y: S_H * S_T * 0.5 });
  });

  it("单个默认区域（id 1, name default）；无 npcSpawns → npcs 为空", () => {
    const rt = generateSimpleMap(simpleOpts(42));

    expect(rt.zones).toHaveLength(1);
    expect(rt.zones[0]!.id).toBe(1);
    expect(rt.zones[0]!.name).toBe("default");
    expect(rt.spawns.npcs).toEqual([]);
  });
});

const C_W = 32;
const C_H = 32;
const C_T = 16;

/** 构造 cave 生成器参数（可覆盖 seed 等）。 */
function caveOpts(seed: number, extra: Partial<CaveGeneratorOptions> = {}): CaveGeneratorOptions {
  return {
    id: "cave",
    name: "cave",
    seed,
    width: C_W,
    height: C_H,
    tileWidth: C_T,
    tileHeight: C_T,
    ...extra,
  };
}

describe("cave 生成器：可复现性与结构不变量", () => {
  it("同种子（seed=2）→ blocked 字节一致 + 玩家坐标一致", () => {
    const a = generateCaveMap(caveOpts(2));
    const b = generateCaveMap(caveOpts(2));

    expect(Array.from(a.blocked)).toEqual(Array.from(b.blocked));
    expect(a.spawns.player).toEqual(b.spawns.player);
  });

  it("边界一圈恒墙", () => {
    const rt = generateCaveMap(caveOpts(2));
    const { blocked, grid } = rt;

    for (let y = 0; y < grid.height; y++) {
      expect(blocked[y * grid.width]).toBe(1); // 左列
      expect(blocked[y * grid.width + (grid.width - 1)]).toBe(1); // 右列
    }
    for (let x = 0; x < grid.width; x++) {
      expect(blocked[x]).toBe(1); // 顶行
      expect(blocked[(grid.height - 1) * grid.width + x]).toBe(1); // 底行
    }
  });

  it("玩家落在可走格（blocked=0）", () => {
    const rt = generateCaveMap(caveOpts(2));
    const player = rt.spawns.player!;
    const tx = Math.floor(player.x / C_T);
    const ty = Math.floor(player.y / C_T);
    const idx = ty * C_W + tx;

    expect(rt.blocked[idx]).toBe(0);
  });

  it("玩家像素坐标对齐 tile 中心 (x%tileW === tileW/2)", () => {
    const rt = generateCaveMap(caveOpts(2));
    const player = rt.spawns.player!;

    expect(player.x % C_T).toBe(C_T / 2);
    expect(player.y % C_T).toBe(C_T / 2);
  });

  it("单个默认区域（id 1, name default）", () => {
    const rt = generateCaveMap(caveOpts(2));

    expect(rt.zones).toHaveLength(1);
    expect(rt.zones[0]!.id).toBe(1);
    expect(rt.zones[0]!.name).toBe("default");
  });
});
