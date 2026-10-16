/**
 * 生成积木 "quantize-terrain"（framework/map/generate/blocks/quantizeTerrain.ts）。
 *
 * 连续高度场 → 离散层号（level）的量化积木：消费上游 "height-channel" 写入
 * aux 的连续 height 场（Float64Array，值 ∈ [0, 1)），按配置阈值带切成整数
 * level（写入 draft 的 level 缓冲），并派生 slope/cliff 边界语义 + walkable
 * 修正。对应地图系统 v2 设计 §7 的管线位置：噪声/连续场生产积木之后、
 * 分区/放置类积木之前。
 *
 * 行为（两趟，纯几何、无游戏语义）：
 * 1. 量化：level(i) = #{ t ∈ thresholds : height(i) ≥ t }，钳到 maxLevels-1
 *    （阈值 t 是第 k 带的下界：h < thresholds[0] → 0 层，依此类推）；
 * 2. 边界派生：对每格取 4-邻接的最大层差 maxDelta——
 *    - maxDelta ≥ 2 → cliff 语义（tiles=cliff 语义 id，walkable=0，不可走）；
 *    - maxDelta = 1 → slope 语义（tiles=slope 语义 id，walkable=1，可走；
 *      边界带两侧格同标——坡道带是完整的）；
 *    - maxDelta = 0 → 不修改（保持上游地面语义与通行位）；
 *    cliff 优先于 slope（一格同时邻接 1 层差与 ≥2 层差邻居时按 cliff 处理，
 *    否则会从崖腰直接跨上崖顶）。
 *
 * 上游衔接（与 GeometryDraft.aux 机制一致）：
 * - height 场经 branded 槽位 HEIGHT_FIELD 读取，缺失或长度不符即抛错
 *   （消费积木对上游依赖 fail-fast）；
 * - **不删除 aux 中的 height 场**：量化后连续梯度仍供下游积木消费
 *   （如 river 按量化前连续梯度定河道），冻结为 MapGeometry 时天然丢弃。
 *
 * 注意（配置责任）：slope 派生会把边界带格**置为可走**——不可通行地面
 * （如水面）与层边界重叠时会被改写成 slope。多场地叠加的图应把量化阈值
 * 与不可通行带对齐（如最低阈值放在水位之上，使岸线两侧同层），框架层
 * 不解释语义 id、不做该对齐。
 *
 * 参数（全部必填，非法即抛错）：
 * - thresholds: 分带阈值数组（升序严格递增，每个 ∈ (0, 1)，非空）；
 * - maxLevels: 层数上限（整数 ∈ [1, 128]，Int8 有符号容量；须
 *   ≥ thresholds.length + 1——声明的容量必须容纳全部分带，禁止静默压顶）；
 * - slopeSemantics / cliffSemantics: slope/cliff 的地面语义 id（整数 ∈
 *   [0, 255]，二者必须不同）。语义 id 的含义命名映射在 game 配置，框架
 *   只见数字。
 */

import { HEIGHT_FIELD } from "map/generate/blocks/heightChannel";
import type { GenerationContext } from "map/generate/types";
import { getAux } from "map/generate/types";

/** 收窄校验后的积木参数。 */
interface QuantizeTerrainParams {
  /** 分带阈值（升序严格递增，每个 ∈ (0, 1)）。 */
  thresholds: number[];
  /** 层数上限（整数 ∈ [1, 128]）。 */
  maxLevels: number;
  /** slope 语义 id（相邻层差 1 的边界带；可走）。 */
  slopeSemantics: number;
  /** cliff 语义 id（相邻层差 ≥2 的边界带；不可走）。 */
  cliffSemantics: number;
}

/** 参数错误统一出口：消息含地图 key 与具体原因。 */
function fail(mapKey: string, detail: string): never {
  throw new Error(`map "${mapKey}": quantize-terrain ${detail}`);
}

/**
 * 从 ctx.params 收窄积木参数：逐项校验，缺失/非法即抛出点名具体配置项的错误。
 *
 * @param params 管道透传的本步骤参数切片
 * @param mapKey 地图 key（错误消息定位用）
 * @returns 可信参数形状
 */
function parseParams(params: unknown, mapKey: string): QuantizeTerrainParams {
  if (typeof params !== "object" || params === null || Array.isArray(params)) {
    fail(mapKey, "params must be an object");
  }
  const raw = params as Record<string, unknown>;

  const thresholdsRaw = raw.thresholds;
  if (!Array.isArray(thresholdsRaw) || thresholdsRaw.length === 0) {
    fail(mapKey, "params.thresholds must be a non-empty array of band thresholds");
  }
  const thresholds: number[] = [];
  for (const entry of thresholdsRaw) {
    if (typeof entry !== "number" || !Number.isFinite(entry) || entry <= 0 || entry >= 1) {
      fail(mapKey, `params.thresholds entries must be numbers in (0, 1), got ${String(entry)}`);
    }
    thresholds.push(entry);
  }
  for (let i = 1; i < thresholds.length; i++) {
    if (thresholds[i] <= thresholds[i - 1]) {
      fail(mapKey, `params.thresholds must be strictly ascending (thresholds[${i}]=${thresholds[i]})`);
    }
  }

  const maxLevels = raw.maxLevels;
  if (typeof maxLevels !== "number" || !Number.isInteger(maxLevels) || maxLevels < 1 || maxLevels > 128) {
    fail(mapKey, `params.maxLevels must be an integer in [1, 128], got ${String(maxLevels)}`);
  }
  // 声明容量必须容纳全部分带（thresholds.length + 1 带）——钳制上限只为
  // 类型层安全兜底，禁止静默把顶层带压平成同一层
  if (thresholds.length + 1 > maxLevels) {
    fail(
      mapKey,
      `params.maxLevels (${maxLevels}) must cover all bands: thresholds.length + 1 = ${thresholds.length + 1}`,
    );
  }

  const semanticIds: [string, number][] = [];
  for (const key of ["slopeSemantics", "cliffSemantics"] as const) {
    const value = raw[key];
    if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > 255) {
      fail(mapKey, `params.${key} must be an integer semantic id in [0, 255], got ${String(value)}`);
    }
    semanticIds.push([key, value]);
  }
  if (semanticIds[0][1] === semanticIds[1][1]) {
    fail(mapKey, "params.slopeSemantics and params.cliffSemantics must be distinct");
  }

  return {
    thresholds,
    maxLevels,
    slopeSemantics: semanticIds[0][1],
    cliffSemantics: semanticIds[1][1],
  };
}

/**
 * quantize-terrain 生成积木：连续高度场 → 离散 level + slope/cliff 派生。
 *
 * @param ctx 生成上下文（params 由本积木收窄校验）
 * @throws Error 当 params 非法、草稿未定尺寸，或上游 height-channel
 *   未运行（aux 槽位无 height 场或长度不符）时——消息含地图 key
 */
export function quantizeTerrain(ctx: GenerationContext): void {
  const params = parseParams(ctx.params, ctx.key);
  const draft = ctx.geometry;
  const { width, height } = draft;
  const total = width * height;
  if (width <= 0 || height <= 0 || draft.walkable.length !== total || total === 0) {
    throw new Error(
      `map "${ctx.key}": quantize-terrain requires a sized draft (width=${width}, height=${height}, walkable.length=${draft.walkable.length}) — a sizing block must run first`,
    );
  }

  // 上游依赖：height 场必须已由 height-channel 写入 aux（不删除——下游
  // 积木仍可消费量化前的连续梯度）
  const field = getAux(draft, HEIGHT_FIELD);
  if (!field || field.length !== total) {
    throw new Error(
      `map "${ctx.key}": quantize-terrain requires an upstream "height-channel" step that fills the height field (field.length=${field?.length ?? "undefined"}, expected ${total})`,
    );
  }

  // 量化：level(i) = #{ t ∈ thresholds : height(i) ≥ t }，钳到 maxLevels-1
  // （parseParams 已保证分带数 ≤ maxLevels，钳制只为类型层兜底）
  const cap = params.maxLevels - 1;
  const level = draft.level.length === total ? draft.level : new Int8Array(total);
  draft.level = level;
  for (let i = 0; i < total; i++) {
    const h = field[i];
    let band = 0;
    for (const t of params.thresholds) {
      if (h >= t) band++;
      else break;
    }
    level[i] = Math.min(band, cap);
  }

  // 边界派生 + walkable 修正：只依赖 level（读 tiles/walkable 前不写它们，
  // 单趟安全）。maxDelta ≥ 2 → cliff（不可走）；= 1 → slope（可走）；否则不动。
  const { tiles, walkable } = draft;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      const own = level[i];
      let maxDelta = 0;
      // 4-邻接（越界跳过）
      if (x > 0) {
        const delta = Math.abs(level[i - 1] - own);
        if (delta > maxDelta) maxDelta = delta;
      }
      if (x < width - 1) {
        const delta = Math.abs(level[i + 1] - own);
        if (delta > maxDelta) maxDelta = delta;
      }
      if (y > 0) {
        const delta = Math.abs(level[i - width] - own);
        if (delta > maxDelta) maxDelta = delta;
      }
      if (y < height - 1) {
        const delta = Math.abs(level[i + width] - own);
        if (delta > maxDelta) maxDelta = delta;
      }

      if (maxDelta >= 2) {
        tiles[i] = params.cliffSemantics;
        walkable[i] = 0;
      } else if (maxDelta === 1) {
        tiles[i] = params.slopeSemantics;
        walkable[i] = 1;
      }
    }
  }
}
