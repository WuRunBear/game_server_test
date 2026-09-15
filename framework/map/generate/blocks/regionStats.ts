/**
 * 生成积木 "region-stats"（framework/map/generate/blocks/regionStats.ts）。
 *
 * 区域派生统计（后处理变换积木）：遍历一次 regionOfTile，为每个**有覆盖**
 * 的区域统计面积/质心/包围盒，写入该区域的 RegionMeta.meta（自由字典，
 * 框架不解释含义）。统计写入会改变 meta → 内容指纹随之变化，属预期。
 *
 * 参数（全部可选，缺省输出全部统计项）：
 * - metrics?: 统计项名单，条目为 "area" | "centroid" | "bounds"；
 *   缺省 = 三项全写；含未知项名时抛错（fail-fast）。
 *
 * 统计约定（坐标均为 tile 坐标）：
 * - area: 区域格数（number）；
 * - centroid: [cx, cy] 区域内格坐标均值（浮点）；
 * - bounds: { minX, minY, maxX, maxY } 行主序网格内的最小包围盒（含端点）。
 *
 * 零覆盖区域跳过（不写任何统计键）；meta 中同名旧键被覆盖。
 * 纯几何生产：不 import ECS/world，不做文件 I/O，不含游戏专属语义。
 */

import type { GenerationContext } from "map/generate/types";

/** 支持的统计项名（配置 metrics 的合法条目）。 */
const METRIC_NAMES = ["area", "centroid", "bounds"] as const;
/** 统计项名联合类型。 */
type MetricName = (typeof METRIC_NAMES)[number];

/** 收窄校验后的积木参数。 */
interface RegionStatsParams {
  /** 要写入的统计项集合（插入序决定写入顺序，重复项去重）。 */
  metrics: Set<MetricName>;
}

/** 参数错误统一出口：消息含地图 key 与具体原因。 */
function fail(mapKey: string, detail: string): never {
  throw new Error(`map "${mapKey}": region-stats ${detail}`);
}

/**
 * 从 ctx.params 收窄积木参数：metrics 缺省为全部统计项；提供时必须是
 * 字符串数组且条目全部合法（重复条目允许，去重后生效）。
 *
 * @param params 管道透传的本步骤参数切片
 * @param mapKey 地图 key（错误消息定位用）
 * @returns 收窄后的参数
 */
function parseParams(params: unknown, mapKey: string): RegionStatsParams {
  if (params === undefined || params === null) {
    return { metrics: new Set<MetricName>(METRIC_NAMES) };
  }
  if (typeof params !== "object" || Array.isArray(params)) {
    fail(mapKey, "params must be an object with optional metrics array");
  }
  const raw = (params as Record<string, unknown>).metrics;
  if (raw === undefined) {
    return { metrics: new Set<MetricName>(METRIC_NAMES) };
  }
  if (!Array.isArray(raw) || raw.length === 0) {
    fail(mapKey, "params.metrics must be a non-empty array of metric names");
  }
  const metrics = new Set<MetricName>();
  for (const entry of raw) {
    if (typeof entry !== "string" || !(METRIC_NAMES as readonly string[]).includes(entry)) {
      fail(
        mapKey,
        `params.metrics entries must be one of ${JSON.stringify(METRIC_NAMES)}, got ${JSON.stringify(entry)}`,
      );
    }
    metrics.add(entry as MetricName);
  }
  return { metrics };
}

/**
 * region-stats 生成积木：为每个有覆盖的区域派生统计写入 RegionMeta.meta。
 *
 * @param ctx 生成上下文（params 由本积木收窄校验）
 * @throws Error 当 params 非法，或草稿未定尺寸/缓冲未分配时（消息含地图 key）
 */
export function regionStats(ctx: GenerationContext): void {
  const { metrics } = parseParams(ctx.params, ctx.key);

  const { width, height, regions, regionOfTile } = ctx.geometry;
  const total = width * height;
  if (width <= 0 || height <= 0 || regionOfTile.length !== total || regionOfTile.length === 0) {
    throw new Error(
      `map "${ctx.key}": region-stats requires a sized draft with allocated regionOfTile (width=${width}, height=${height}, regionOfTile.length=${regionOfTile.length}) — a sizing block must run first`,
    );
  }

  // regions Map 插入序 = regionOfTile 索引序：按索引建「索引 → 区域名」表
  const namesByIndex: string[] = [];
  for (const [name] of regions) {
    namesByIndex.push(name);
  }

  // 单次遍历累积每区域统计：格数 / 坐标和（质心）/ 包围盒
  // （min* 初值取 int32 上界——Number.MAX_SAFE_INTEGER 溢出 Int32Array 不可用）
  const count = new Int32Array(namesByIndex.length);
  const sumX = new Float64Array(namesByIndex.length);
  const sumY = new Float64Array(namesByIndex.length);
  const minX = new Int32Array(namesByIndex.length).fill(2 ** 31 - 1);
  const minY = new Int32Array(namesByIndex.length).fill(2 ** 31 - 1);
  const maxX = new Int32Array(namesByIndex.length).fill(-1);
  const maxY = new Int32Array(namesByIndex.length).fill(-1);
  for (let i = 0; i < regionOfTile.length; i++) {
    const regionIndex = regionOfTile[i];
    if (regionIndex < 0 || regionIndex >= namesByIndex.length) {
      fail(ctx.key, `regionOfTile[${i}]=${regionIndex} out of range (regions count ${namesByIndex.length})`);
    }
    const x = i % width;
    const y = (i - x) / width;
    count[regionIndex]++;
    sumX[regionIndex] += x;
    sumY[regionIndex] += y;
    if (x < minX[regionIndex]) minX[regionIndex] = x;
    if (x > maxX[regionIndex]) maxX[regionIndex] = x;
    if (y < minY[regionIndex]) minY[regionIndex] = y;
    if (y > maxY[regionIndex]) maxY[regionIndex] = y;
  }

  // 写回 meta：仅统计项开启且区域有覆盖时写（零覆盖区域跳过）
  for (let index = 0; index < namesByIndex.length; index++) {
    if (count[index] === 0) continue;
    const region = regions.get(namesByIndex[index]);
    if (!region) continue;
    if (metrics.has("area")) {
      region.meta.area = count[index];
    }
    if (metrics.has("centroid")) {
      region.meta.centroid = [sumX[index] / count[index], sumY[index] / count[index]];
    }
    if (metrics.has("bounds")) {
      region.meta.bounds = { minX: minX[index], minY: minY[index], maxX: maxX[index], maxY: maxY[index] };
    }
  }
}
