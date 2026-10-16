/**
 * 生成积木 "river"（framework/map/generate/blocks/river.ts）。
 *
 * 河湖刻蚀积木：消费上游 "height-channel" 写入 aux 的连续 height 场
 * （经 HEIGHT_FIELD 槽位常量——quantize-terrain 量化后特意保留该场，本
 * 积木按量化前连续梯度定河道），用简化流累积（downslope + flow
 * accumulation）标出河道，并按配置水位标出湖泊：
 *
 * 1. downslope：每格指向 4-邻接中**严格更低**的最低邻格（并列取扫描序
 *    首个：左、右、上、下）；无严格更低邻格的格为汇（无 downslope）；
 * 2. flow accumulation：每格初始 1 股水流，按高度降序（同高按索引升序，
 *    确定性）逐格把自身累积汇入 downslope 目标——目标严格更低，故降序
 *    处理保证汇入先于其被处理（简化累积，不做 Strahler 宽度）；
 * 3. 标水：累积 ≥ flowThreshold 的格 → tiles = waterSemantics 且
 *    walkable = 0（水语义 id 的含义映射在 game 配置，框架只见数字）；
 * 4. 湖泊（lakeLevel 可选）：height < lakeLevel 的格同样标水（配置水位
 *    以下的洼地）。
 *
 * **管道顺序（已验证）**：本积木应跑在 quantize-terrain **之前**——连续
 * 场在 aux 中与位置无关（quantize 前后都可读），顺序的实质是谁最后写
 * tiles/walkable：quantize 的 slope/cliff 派生只依赖 level、会强制改写
 * 边界带格，跑在后面意味着层界处的水格被收编为 slope/cliff（水语义格
 * 终态恒 walkable=0，多层结构不变式不被水道切断）；反之 river 跑在
 * quantize 之后会让水格覆写 slope 带，可能把多层地形的可走域切成多个
 * 连通域（出口校验硬错误）。代价：河道在层界带处视觉断开（量化阈值与
 * lakeLevel 对齐可使湖体完整保留，见 quantize-terrain 模块注释）。
 *
 * 纯几何生产：无随机性（纯函数），不 import ECS/world，不含游戏专属语义。
 */

import { HEIGHT_FIELD } from "map/generate/blocks/heightChannel";
import type { GenerationContext } from "map/generate/types";
import { getAux } from "map/generate/types";

/** 语义 id 上界：tiles 缓冲是 Uint8Array，语义 id 必须落在单字节内。 */
const MAX_SEMANTIC_ID = 255;

/** 收窄校验后的积木参数。 */
interface RiverParams {
  /** 成流水流阈值（格累积水流数 ≥ 该值 → 标水；整数 ≥ 2）。 */
  flowThreshold: number;
  /** 水语义 id（河道与湖泊格写入该值，0–255）。 */
  waterSemantics: number;
  /** 湖泊水位（height < lakeLevel → 标水）；undefined = 不标湖。 */
  lakeLevel: number | undefined;
}

/** 参数错误统一出口：消息含地图 key 与具体原因。 */
function fail(mapKey: string, detail: string): never {
  throw new Error(`map "${mapKey}": river ${detail}`);
}

/**
 * 从 ctx.params 收窄积木参数：flowThreshold 必填（整数 ≥ 2——1 股即自身，
 * 全图成水必是配置错误）；waterSemantics 必填（[0, 255] 整数）；
 * lakeLevel 可选（∈ (0, 1) 的连续场水位，省略 = 不标湖）。
 *
 * @param params 管道透传的本步骤参数切片
 * @param mapKey 地图 key（错误消息定位用）
 * @returns 可信参数形状
 */
function parseParams(params: unknown, mapKey: string): RiverParams {
  if (typeof params !== "object" || params === null || Array.isArray(params)) {
    fail(mapKey, "params must be an object with flowThreshold / waterSemantics (and optional lakeLevel)");
  }
  const raw = params as Record<string, unknown>;

  const flowThreshold = raw.flowThreshold;
  if (typeof flowThreshold !== "number" || !Number.isInteger(flowThreshold) || flowThreshold < 2) {
    fail(mapKey, `params.flowThreshold must be an integer >= 2, got ${String(flowThreshold)}`);
  }

  const waterSemantics = raw.waterSemantics;
  if (
    typeof waterSemantics !== "number" ||
    !Number.isInteger(waterSemantics) ||
    waterSemantics < 0 ||
    waterSemantics > MAX_SEMANTIC_ID
  ) {
    fail(mapKey, `params.waterSemantics must be an integer in [0, 255], got ${String(waterSemantics)}`);
  }

  let lakeLevel: number | undefined;
  if (raw.lakeLevel !== undefined) {
    const value = raw.lakeLevel;
    if (typeof value !== "number" || !Number.isFinite(value) || value <= 0 || value >= 1) {
      fail(mapKey, `params.lakeLevel must be a number in (0, 1), got ${String(value)}`);
    }
    lakeLevel = value;
  }

  return { flowThreshold, waterSemantics, lakeLevel };
}

/**
 * river 生成积木：在已定尺寸草稿上按连续高度场刻蚀河道与湖泊。
 *
 * @param ctx 生成上下文（params 由本积木收窄校验）
 * @throws Error 当 params 非法、草稿未定尺寸/缓冲未分配，或上游
 *   height-channel 未运行（aux 槽位无 height 场或长度不符）时——消息含地图 key
 */
export function river(ctx: GenerationContext): void {
  const params = parseParams(ctx.params, ctx.key);
  const draft = ctx.geometry;
  const { width, height } = draft;
  const total = width * height;
  if (width <= 0 || height <= 0 || draft.tiles.length !== total || draft.walkable.length !== total || total === 0) {
    throw new Error(
      `map "${ctx.key}": river requires a sized draft (width=${width}, height=${height}, tiles.length=${draft.tiles.length}) — a sizing block must run first`,
    );
  }

  // 上游依赖：height 场必须已由 height-channel 写入 aux（quantize 前后均可——
  // quantize 保留该场，管道顺序见模块注释）
  const field = getAux(draft, HEIGHT_FIELD);
  if (!field || field.length !== total) {
    throw new Error(
      `map "${ctx.key}": river requires an upstream "height-channel" step that fills the height field (field.length=${field?.length ?? "undefined"}, expected ${total})`,
    );
  }

  // downslope：每格 4-邻接中严格更低的最低邻格（并列取扫描序首个：左、右、
  // 上、下）；无则 -1（汇）。扫描序固定 → 完全确定。
  const downslope = new Int32Array(total).fill(-1);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const index = y * width + x;
      const own = field[index];
      let best = -1;
      let bestHeight = own;
      if (x > 0 && field[index - 1] < bestHeight) {
        best = index - 1;
        bestHeight = field[index - 1];
      }
      if (x < width - 1 && field[index + 1] < bestHeight) {
        best = index + 1;
        bestHeight = field[index + 1];
      }
      if (y > 0 && field[index - width] < bestHeight) {
        best = index - width;
        bestHeight = field[index - width];
      }
      if (y < height - 1 && field[index + width] < bestHeight) {
        best = index + width;
        bestHeight = field[index + width];
      }
      downslope[index] = best;
    }
  }

  // 处理序：高度降序（同高按索引升序）——downslope 目标严格更低，必在
  // 更晚位置，降序处理时其累积已收齐全部上游汇入
  const order: number[] = new Array(total);
  for (let i = 0; i < total; i++) order[i] = i;
  order.sort((a, b) => field[b] - field[a] || a - b);

  // flow accumulation：每格 1 股，逐格汇入 downslope 目标
  const flow = new Float64Array(total).fill(1);
  for (const index of order) {
    const target = downslope[index];
    if (target >= 0) {
      flow[target] += flow[index];
    }
  }

  // 标水：汇流超阈值（河道）或低于配置水位（湖泊）→ 水语义 + 不可通行
  const { tiles, walkable } = draft;
  for (let i = 0; i < total; i++) {
    if (flow[i] >= params.flowThreshold || (params.lakeLevel !== undefined && field[i] < params.lakeLevel)) {
      tiles[i] = params.waterSemantics;
      walkable[i] = 0;
    }
  }
}
