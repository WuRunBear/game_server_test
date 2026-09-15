/**
 * 生成积木 "height-mask"（framework/map/generate/blocks/heightMask.ts）。
 *
 * aux 辅助通道消费者（多场叠加验证积木）：读取上游 "height-channel"
 * 写入的 height 场（经 HEIGHT_FIELD 槽位常量），按配置把场值落回地理
 * 缓冲——mode 二选一：
 * - "mask"：按高度区间重写 walkable（场值 ∈ [minLevel, maxLevel] → 1，
 *   否则 0），实现「按高度修饰通行位图」；
 * - "stats"：按 regionOfTile 汇总每区域的平均高度，写入该区域
 *   RegionMeta.meta.averageHeight（tile 坐标无关、纯数值）。
 *
 * 上游缺失（aux 槽位未写入）即抛错——消费积木对上游依赖 fail-fast。
 * 纯几何生产：不 import ECS/world，不做文件 I/O，不含游戏专属语义。
 */

import { HEIGHT_FIELD } from "map/generate/blocks/heightChannel";
import type { GenerationContext } from "map/generate/types";
import { getAux } from "map/generate/types";

/** 收窄校验后的积木参数。 */
interface HeightMaskParams {
  /** 消费模式："mask" = 按高度区间重写 walkable；"stats" = 区域平均高度。 */
  mode: "mask" | "stats";
  /** mask 模式高度区间下界（[0, 1]，缺省 0）。 */
  minLevel: number;
  /** mask 模式高度区间上界（[0, 1]，缺省 1）。 */
  maxLevel: number;
}

/** 参数错误统一出口：消息含地图 key 与具体原因。 */
function fail(mapKey: string, detail: string): never {
  throw new Error(`map "${mapKey}": height-mask ${detail}`);
}

/**
 * 从 ctx.params 收窄积木参数：mode 必填（"mask" | "stats"）；
 * minLevel/maxLevel 可选（缺省 0/1），提供时须 ∈ [0, 1] 且 min ≤ max。
 */
function parseParams(params: unknown, mapKey: string): HeightMaskParams {
  if (typeof params !== "object" || params === null || Array.isArray(params)) {
    fail(mapKey, "params must be an object with mode (\"mask\" | \"stats\")");
  }
  const raw = params as Record<string, unknown>;
  if (raw.mode !== "mask" && raw.mode !== "stats") {
    fail(mapKey, `params.mode must be "mask" or "stats", got ${String(raw.mode)}`);
  }
  let minLevel = 0;
  let maxLevel = 1;
  for (const [key, fallback] of [["minLevel", 0], ["maxLevel", 1]] as const) {
    const value = raw[key];
    if (value !== undefined) {
      if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) {
        fail(mapKey, `params.${key} must be a number in [0, 1], got ${String(value)}`);
      }
      if (key === "minLevel") minLevel = value;
      else maxLevel = value;
    }
  }
  if (minLevel > maxLevel) {
    fail(mapKey, `params.minLevel (${minLevel}) must be <= params.maxLevel (${maxLevel})`);
  }
  return { mode: raw.mode as HeightMaskParams["mode"], minLevel, maxLevel };
}

/**
 * height-mask 生成积木：把 aux 中的 height 场落回地理缓冲（mask/stats）。
 *
 * @param ctx 生成上下文（params 由本积木收窄校验）
 * @throws Error 当 params 非法、草稿未定尺寸，或上游 height-channel
 *   未运行（aux 槽位无 height 场）时——消息含地图 key
 */
export function heightMask(ctx: GenerationContext): void {
  const params = parseParams(ctx.params, ctx.key);
  const { width, height, regions, regionOfTile, walkable } = ctx.geometry;
  const total = width * height;
  if (width <= 0 || height <= 0 || walkable.length !== total || walkable.length === 0) {
    throw new Error(
      `map "${ctx.key}": height-mask requires a sized draft (width=${width}, height=${height}, walkable.length=${walkable.length}) — a sizing block must run first`,
    );
  }

  // 上游依赖：height 场必须已由 height-channel 写入 aux
  const field = getAux(ctx.geometry, HEIGHT_FIELD);
  if (!field || field.length !== total) {
    throw new Error(
      `map "${ctx.key}": height-mask requires an upstream "height-channel" step that fills the height field (field.length=${field?.length ?? "undefined"}, expected ${total})`,
    );
  }

  if (params.mode === "mask") {
    // 按高度区间重写 walkable
    for (let i = 0; i < total; i++) {
      walkable[i] = field[i] >= params.minLevel && field[i] <= params.maxLevel ? 1 : 0;
    }
    return;
  }

  // stats 模式：每区域平均高度（区域索引 → regions Map 插入序定位名称）
  const namesByIndex: string[] = [];
  for (const [name] of regions) {
    namesByIndex.push(name);
  }
  const count = new Int32Array(namesByIndex.length);
  const sum = new Float64Array(namesByIndex.length);
  for (let i = 0; i < total; i++) {
    const regionIndex = regionOfTile[i];
    if (regionIndex < 0 || regionIndex >= namesByIndex.length) {
      fail(ctx.key, `regionOfTile[${i}]=${regionIndex} out of range (regions count ${namesByIndex.length})`);
    }
    count[regionIndex]++;
    sum[regionIndex] += field[i];
  }
  for (let index = 0; index < namesByIndex.length; index++) {
    if (count[index] === 0) continue;
    const region = regions.get(namesByIndex[index]);
    if (region) {
      region.meta.averageHeight = sum[index] / count[index];
    }
  }
}
