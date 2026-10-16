/**
 * 生成积木 ca-cave 测试（framework/__tests__/map-block-ca-cave.test.ts）。
 *
 * 覆盖（地图切片 8，元胞自动机洞穴）：
 * - CA 4-5 规则：全墙/全地是规则不动点（迭代收敛）；孤立单格墙被侵蚀；
 *   二值化写回——终态 tiles 只含墙/地面两语义且 walkable 一致
 *   （地面 ⇔ 可走）；迭代轮数上限有界（收敛后更大上限输出不变）；
 * - 初始位图来源：缺省取自 tiles（tiles == wallSemantics）；
 *   initialWallProbability 随机填充（同 seed 确定复现，p=1 全墙 / p=0 全地）；
 * - 连通保证（切片 8 验收核心）：双腔室地图——
 *   "tunnel"（缺省）雕隧道后全部地面单一 4-连通域；
 *   "remove" 次域填回墙（无孤立地面）；
 * - 参数 fail-fast：墙/地面语义互异、iterations ∈ [1,32]、
 *   initialWallProbability ∈ [0,1]、isolation 枚举、未定尺寸草稿。
 */
import { describe, expect, it } from "vitest";

import { caCave } from "map/generate/blocks/caCave";
import { createRng } from "map/generate/rng";
import { createGeometryDraft, type GenerationContext, type GeometryDraft } from "map/generate/types";

/** 测试图 key（错误消息定位用）。 */
const KEY = "ca-cave-test";

/** 墙/地面语义 id。 */
const WALL = 1;
const FLOOR = 2;

/** 构造 width×height 草稿，tiles 按给定行字符串布点（"#"=墙，"."=地面）。 */
function makeDraftFromRows(rows: string[]): GeometryDraft {
  const height = rows.length;
  const width = rows[0].length;
  const draft = createGeometryDraft(KEY);
  draft.width = width;
  draft.height = height;
  draft.tileWidth = 16;
  draft.tileHeight = 16;
  draft.tiles = new Uint8Array(width * height);
  draft.walkable = new Uint8Array(width * height);
  draft.regions.set("region-a", { name: "region-a", meta: {} });
  draft.regionOfTile = new Uint16Array(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const index = y * width + x;
      const isWall = rows[y][x] === "#";
      draft.tiles[index] = isWall ? WALL : FLOOR;
      draft.walkable[index] = isWall ? 0 : 1;
    }
  }
  return draft;
}

/** 构造执行上下文。 */
function makeCtx(draft: GeometryDraft, params: unknown, seed = 7): GenerationContext {
  return { key: KEY, rng: createRng(seed), geometry: draft, params };
}

/** 测试侧 4-邻接连通域计数（地面 = walkable 1）。 */
function countWalkableDomains(draft: GeometryDraft): number[] {
  const { width, height, walkable } = draft;
  const seen = new Uint8Array(walkable.length);
  const sizes: number[] = [];
  for (let start = 0; start < walkable.length; start++) {
    if (walkable[start] !== 1 || seen[start] === 1) continue;
    let size = 0;
    const stack = [start];
    seen[start] = 1;
    while (stack.length > 0) {
      const index = stack.pop() as number;
      size++;
      const x = index % width;
      const y = (index - x) / width;
      if (x > 0 && walkable[index - 1] === 1 && seen[index - 1] === 0) {
        seen[index - 1] = 1;
        stack.push(index - 1);
      }
      if (x < width - 1 && walkable[index + 1] === 1 && seen[index + 1] === 0) {
        seen[index + 1] = 1;
        stack.push(index + 1);
      }
      if (y > 0 && walkable[index - width] === 1 && seen[index - width] === 0) {
        seen[index - width] = 1;
        stack.push(index - width);
      }
      if (y < height - 1 && walkable[index + width] === 1 && seen[index + width] === 0) {
        seen[index + width] = 1;
        stack.push(index + width);
      }
    }
    sizes.push(size);
  }
  return sizes;
}

/**
 * 双腔室 15×8 地图：两间 6×6 洞室（x1-6 与 x9-13，y1-6），x7-8 双厚墙列
 * 隔开（单厚墙会被 CA 自身蚀穿，无法用于隔离测试）。
 */
function makeBigChambersDraft(): GeometryDraft {
  return makeDraftFromRows([
    "###############",
    "#......##.....#",
    "#......##.....#",
    "#......##.....#",
    "#......##.....#",
    "#......##.....#",
    "#......##.....#",
    "###############",
  ]);
}

describe("ca-cave：CA 4-5 规则与收敛", () => {
  it("POSITIVE：全墙输入是不动点——迭代后仍全墙（越界计墙，边界趋实）", () => {
    const draft = makeDraftFromRows(["###", "###", "###"]);
    caCave(makeCtx(draft, { wallSemantics: WALL, floorSemantics: FLOOR, iterations: 8 }));
    expect([...draft.tiles]).toEqual(new Array(9).fill(WALL));
    expect([...draft.walkable]).toEqual(new Array(9).fill(0));
  });

  it("POSITIVE：全地小图被边界墙吞没（越界计墙 → 地图角 5 胞墙 ≥ 5 恒成墙）", () => {
    // 5×5 全地跑 1 轮：仅四角（各 5 个越界邻格）成墙，其余保持地面
    const draft = makeDraftFromRows([".....", ".....", ".....", ".....", "....."]);
    caCave(makeCtx(draft, { wallSemantics: WALL, floorSemantics: FLOOR, iterations: 1 }));
    for (let y = 0; y < 5; y++) {
      for (let x = 0; x < 5; x++) {
        const isCorner = (x === 0 || x === 4) && (y === 0 || y === 4);
        expect(draft.tiles[y * 5 + x]).toBe(isCorner ? WALL : FLOOR);
      }
    }
  });

  it("POSITIVE：孤立单格墙被侵蚀（内部 9 胞墙数 1 < 5 → 地面）", () => {
    // 7×7 全地中央一格墙：中央远离边界（越界不计入其 9 胞）→ 1 < 5 侵蚀
    const draft = makeDraftFromRows([
      ".......",
      ".......",
      ".......",
      "...#...",
      ".......",
      ".......",
      ".......",
    ]);
    caCave(makeCtx(draft, { wallSemantics: WALL, floorSemantics: FLOOR, iterations: 2 }));
    expect(draft.tiles[3 * 7 + 3]).toBe(FLOOR);
    expect(countWalkableDomains(draft)).toHaveLength(1);
  });

  it("POSITIVE：二值化写回——终态只含墙/地两语义且地面 ⇔ walkable=1", () => {
    // 混合上游语义：先布点，再把两格改成任意其他上游语义（9），CA 后全图二值化
    const draft = makeDraftFromRows([
      "###....",
      "#......",
      "#......",
      "###....",
    ]);
    draft.tiles[9] = 9; // (2,2)：任意上游其他语义
    draft.tiles[10] = 9; // (3,2)
    caCave(makeCtx(draft, { wallSemantics: WALL, floorSemantics: FLOOR, iterations: 3 }));
    for (let i = 0; i < draft.tiles.length; i++) {
      expect([WALL, FLOOR]).toContain(draft.tiles[i]);
      expect(draft.walkable[i]).toBe(draft.tiles[i] === FLOOR ? 1 : 0);
    }
  });

  it("POSITIVE：迭代收敛——收敛后更大的轮数上限输出不变（有界定点）", () => {
    const makeSnapshot = (iterations: number): { tiles: number[]; walkable: number[] } => {
      const draft = makeBigChambersDraft();
      caCave(makeCtx(draft, { wallSemantics: WALL, floorSemantics: FLOOR, iterations }, 99));
      return { tiles: [...draft.tiles], walkable: [...draft.walkable] };
    };
    const at4 = makeSnapshot(4);
    const at12 = makeSnapshot(12);
    expect(at12).toEqual(at4);
  });
});

describe("ca-cave：初始墙壁位图来源", () => {
  it("POSITIVE：缺省取自 tiles（tiles == wallSemantics 的格为墙）", () => {
    // 7×7 全地中央一格墙：初始位图取自 tiles → 中央被 CA 侵蚀（若初始
    // 位图来自随机填充则断言无意义）；同时四角由越界计墙成墙
    const draft = makeDraftFromRows([
      ".......",
      ".......",
      ".......",
      "...#...",
      ".......",
      ".......",
      ".......",
    ]);
    caCave(makeCtx(draft, { wallSemantics: WALL, floorSemantics: FLOOR, iterations: 2 }));
    expect(draft.tiles[3 * 7 + 3]).toBe(FLOOR); // 中央墙被侵蚀
    expect(draft.tiles[0]).toBe(WALL); // 地图角（5 越界墙 ≥ 5）
    expect(draft.tiles[3 * 7]).toBe(FLOOR); // 边中格（3 越界 + 2 角墙 < 5）保持地面
  });

  it("POSITIVE：initialWallProbability 随机填充——同 seed 确定复现；p=1 全墙不动", () => {
    const run = (seed: number, probability: number): number[] => {
      const draft = makeDraftFromRows(["..", ".."]); // 上游布局被替换
      caCave(makeCtx(draft, { wallSemantics: WALL, floorSemantics: FLOOR, iterations: 2, initialWallProbability: probability }, seed));
      return [...draft.tiles];
    };
    expect(run(7, 0.5)).toEqual(run(7, 0.5)); // 同 seed 同参数确定复现
    expect(run(7, 1)).toEqual(new Array(4).fill(WALL)); // 全墙是不动点
  });
});

describe("ca-cave：连通保证", () => {
  it("POSITIVE：tunnel（缺省）——CA 后双域雕隧道接入主域，全部地面单一 4-连通域", () => {
    const draft = makeBigChambersDraft();
    caCave(makeCtx(draft, { wallSemantics: WALL, floorSemantics: FLOOR, iterations: 8 }, 99));

    expect(countWalkableDomains(draft)).toHaveLength(1);
    const floorCount = [...draft.walkable].filter((value) => value === 1).length;
    expect(floorCount).toBe(60); // CA 后 58 格 + 隧道雕出 2 格
  });

  it("POSITIVE：remove——次域整体填回墙，无孤立地面残留", () => {
    const draft = makeBigChambersDraft();
    caCave(
      makeCtx(draft, { wallSemantics: WALL, floorSemantics: FLOOR, iterations: 8, isolation: "remove" }, 99),
    );

    expect(countWalkableDomains(draft)).toHaveLength(1);
    const floorCount = [...draft.walkable].filter((value) => value === 1).length;
    expect(floorCount).toBe(32); // 主域（较大腔室）幸存，次域填回墙
  });

  it("POSITIVE：tunnel 与 remove 差分——两条路径都对孤立域做了真实处理", () => {
    // tunnel 保留并连通两域（60 格）> remove 剔除次域（26 格）；
    // 若任一路径空转（CA 已合并 / 未处理），两侧格数会相等
    const run = (isolation: string): number => {
      const draft = makeBigChambersDraft();
      caCave(makeCtx(draft, { wallSemantics: WALL, floorSemantics: FLOOR, iterations: 8, isolation }, 99));
      return [...draft.walkable].filter((value) => value === 1).length;
    };
    expect(run("tunnel")).toBeGreaterThan(run("remove"));
  });

  it("POSITIVE：单连通域输入不做任何连通处理（无事可做早退）", () => {
    // 7×7 环形：CA 收敛后内部 5×5 去四角仍为单一连通域（小环内域会被
    // 边界墙吞没，故取大环）
    const draft = makeDraftFromRows([
      "#######",
      "#.....#",
      "#.....#",
      "#.....#",
      "#.....#",
      "#.....#",
      "#######",
    ]);
    caCave(makeCtx(draft, { wallSemantics: WALL, floorSemantics: FLOOR, iterations: 2 }));
    expect(countWalkableDomains(draft)).toHaveLength(1);
  });
});

describe("ca-cave：参数 fail-fast", () => {
  it("NEGATIVE：墙/地面语义相同 → 抛错点名两个参数", () => {
    const draft = makeDraftFromRows(["...", "..."]);
    expect(() =>
      caCave(makeCtx(draft, { wallSemantics: WALL, floorSemantics: WALL })),
    ).toThrowError(/params\.wallSemantics and params\.floorSemantics must be distinct/);
  });

  it("NEGATIVE：语义 id 越界 → 抛错点名参数", () => {
    const draft = makeDraftFromRows(["...", "..."]);
    expect(() =>
      caCave(makeCtx(draft, { wallSemantics: 256, floorSemantics: FLOOR })),
    ).toThrowError(/params\.wallSemantics must be an integer semantic id in \[0, 255\], got 256/);
    expect(() =>
      caCave(makeCtx(draft, { wallSemantics: WALL, floorSemantics: -1 })),
    ).toThrowError(/params\.floorSemantics must be an integer semantic id in \[0, 255\], got -1/);
  });

  it("NEGATIVE：iterations 越出 [1, 32] → 抛错点名 params.iterations", () => {
    const draft = makeDraftFromRows(["...", "..."]);
    expect(() =>
      caCave(makeCtx(draft, { wallSemantics: WALL, floorSemantics: FLOOR, iterations: 0 })),
    ).toThrowError(/params\.iterations must be an integer in \[1, 32\], got 0/);
    expect(() =>
      caCave(makeCtx(draft, { wallSemantics: WALL, floorSemantics: FLOOR, iterations: 33 })),
    ).toThrowError(/params\.iterations must be an integer in \[1, 32\], got 33/);
  });

  it("NEGATIVE：initialWallProbability 越出 [0, 1] → 抛错点名参数", () => {
    const draft = makeDraftFromRows(["...", "..."]);
    expect(() =>
      caCave(makeCtx(draft, { wallSemantics: WALL, floorSemantics: FLOOR, initialWallProbability: -0.1 })),
    ).toThrowError(/params\.initialWallProbability must be a number in \[0, 1\], got -0\.1/);
    expect(() =>
      caCave(makeCtx(draft, { wallSemantics: WALL, floorSemantics: FLOOR, initialWallProbability: 1.5 })),
    ).toThrowError(/params\.initialWallProbability must be a number in \[0, 1\], got 1\.5/);
  });

  it("NEGATIVE：isolation 非法枚举 → 抛错点名 params.isolation", () => {
    const draft = makeDraftFromRows(["...", "..."]);
    expect(() =>
      caCave(makeCtx(draft, { wallSemantics: WALL, floorSemantics: FLOOR, isolation: "ignore" })),
    ).toThrowError(/params\.isolation must be "tunnel" or "remove", got ignore/);
  });

  it("NEGATIVE：未定尺寸草稿 → 抛错点名地图 key 与前置积木要求", () => {
    const draft = createGeometryDraft(KEY);
    expect(() =>
      caCave(makeCtx(draft, { wallSemantics: WALL, floorSemantics: FLOOR })),
    ).toThrowError(/map "ca-cave-test": ca-cave requires a sized draft/);
  });
});
