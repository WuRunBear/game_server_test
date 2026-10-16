/**
 * 多层地形可达性校验测试（framework/__tests__/map-validate-level.test.ts）。
 *
 * 覆盖（地图切片 4B · validate 升级）：
 * - level 缓冲长度校验：非 0 长但与 width×height 不符 → 硬错误；
 *   0 长（未量化草稿）→ 跳过 level 校验（冻结归一化前移交）；
 * - flat 图自动跳过：level 全 0 的图不触发多层校验（现有图零影响）；
 * - ① 相邻层差约束（硬错误）：|Δlevel| ≥ 2 的相邻格两侧都可走 → 报错
 *   （消息含格坐标与层差）；至少一侧不可走（cliff）→ 通过；
 * - ② slope 链连通（硬错误）：非平坦多层地形上可通行区分裂为多个连通域
 *   → 报错；slope 带把台地连成单域 → 通过。
 *
 * 校验分级依据（报告口径）：①② 均为硬错误——量化积木的产出天然满足
 * 两者，违反只来自手改/错配几何；孤立可走域上的演化刷怪不可达，属
 * 玩法损坏而非统计可疑，与「regionOfTile 索引越界即抛错」同级。
 */
import { describe, expect, it } from "vitest";

import { validateMapGeometry } from "map/generate/validate";
import { createGeometryDraft } from "map/generate/types";
import type { GeometryDraft } from "map/generate/types";

/**
 * 构造最小合法草稿（4×4、单区域、tiles 全 1），由调用方覆写 level/walkable。
 */
function makeDraft(): GeometryDraft {
  const draft = createGeometryDraft("level-validate-test");
  draft.width = 4;
  draft.height = 4;
  draft.tileWidth = 16;
  draft.tileHeight = 16;
  draft.tiles = new Uint8Array(16).fill(1);
  draft.walkable = new Uint8Array(16).fill(1);
  draft.level = new Int8Array(16);
  draft.regionOfTile = new Uint16Array(16);
  draft.regions.set("plain", { name: "plain", meta: {} });
  return draft;
}

describe("level 缓冲结构校验", () => {
  it("NEGATIVE：level 非 0 长但与 width×height 不符 → 硬错误", () => {
    const draft = makeDraft();
    draft.level = new Int8Array(12);

    expect(() => validateMapGeometry(draft)).toThrowError(/level length 12 != width\*height 16/);
  });

  it("POSITIVE：level 0 长（未量化草稿）→ 跳过 level 长度与多层校验", () => {
    const draft = makeDraft();
    draft.level = new Int8Array(0);

    expect(validateMapGeometry(draft)).toEqual([]);
  });

  it("POSITIVE：flat 图（level 全 0）→ 多层校验自动跳过（现有图零影响）", () => {
    const draft = makeDraft();
    // 平坦但可走区分裂：flat 语义下只走既有的软告警连通性，不抛硬错误
    draft.walkable[0] = 0;
    draft.walkable[1] = 0;
    draft.walkable[4] = 0;
    draft.walkable[5] = 0;

    expect(() => validateMapGeometry(draft)).not.toThrow();
  });
});

describe("① 相邻层差约束（|Δlevel| ≥ 2 必须有不可走侧）", () => {
  it("NEGATIVE：两侧都可走的 2 层台阶 → 硬错误（消息含坐标与层差）", () => {
    const draft = makeDraft();
    // 左列 level 2、其余 level 0；全部可走 → (0,y)-(1,y) 对是可走 2 层台阶
    for (let y = 0; y < 4; y++) draft.level[y * 4] = 2;

    expect(() => validateMapGeometry(draft)).toThrowError(
      /walkable step of 2 between \(0,0\) and \(1,0\) has no impassable \(cliff\) side/,
    );
  });

  it("POSITIVE：高侧不可走（cliff）→ 通过", () => {
    const draft = makeDraft();
    for (let y = 0; y < 4; y++) {
      draft.level[y * 4] = 2;
      draft.walkable[y * 4] = 0; // cliff 格
    }

    expect(validateMapGeometry(draft)).toEqual([]);
  });

  it("POSITIVE：低侧不可走 → 通过（约束是「至少一侧」，不限定高低侧）", () => {
    const draft = makeDraft();
    // 中间两列（x=1/2）level 2 可走高台，两侧低地（x=0/3）不可走：
    // Δ≥2 边界对的低侧均不可走 → ①通过；可走区只剩高台单一连通域 → ②通过
    for (let y = 0; y < 4; y++) {
      draft.level[y * 4 + 1] = 2;
      draft.level[y * 4 + 2] = 2;
      draft.walkable[y * 4] = 0;
      draft.walkable[y * 4 + 3] = 0;
    }

    expect(validateMapGeometry(draft)).toEqual([]);
  });
});

describe("② slope 链连通（多层地形可走区必须单连通域）", () => {
  it("NEGATIVE：两片不同层台地间无 slope 链（各自成域）→ 硬错误", () => {
    const draft = makeDraft();
    // x=0 列：level 2、可走；x=1/2 列：level 0、不可走（隔断带，含 cliff 侧）；
    // x=3 列：level 0、可走。①通过（Δ≥2 对均有不可走侧），②报 2 个连通域。
    for (let y = 0; y < 4; y++) {
      draft.level[y * 4] = 2;
      draft.walkable[y * 4 + 1] = 0;
      draft.walkable[y * 4 + 2] = 0;
    }

    expect(() => validateMapGeometry(draft)).toThrowError(
      /multi-level terrain splits walkable area into 2 domains .* slope chain between plateaus is cut/,
    );
  });

  it("POSITIVE：slope 带把两级台地连成单域 → 通过", () => {
    const draft = makeDraft();
    // 左两列 level 1、右两列 level 0，全部可走（Δ=1 边界带即 slope）
    for (let y = 0; y < 4; y++) {
      draft.level[y * 4] = 1;
      draft.level[y * 4 + 1] = 1;
    }

    expect(validateMapGeometry(draft)).toEqual([]);
  });
});
