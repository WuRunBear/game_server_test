export interface Metrics {
  tickCount: number;
  lastTickMs: number;
  avgTickMs: number;
}

/**
 * 创建指标收集器的初始状态。
 *
 * @returns Metrics
 */
export function createMetrics(): Metrics {
  return {
    tickCount: 0,
    lastTickMs: 0,
    avgTickMs: 0,
  };
}

/**
 * 记录一次 tick 的耗时，并更新滑动平均值。
 *
 * @param metrics 指标对象（会被原地更新）
 * @param tickMs 本帧耗时（毫秒）
 */
export function recordTick(metrics: Metrics, tickMs: number): void {
  metrics.tickCount += 1;
  metrics.lastTickMs = tickMs;

  const alpha = 0.05;
  metrics.avgTickMs =
    metrics.tickCount === 1 ? tickMs : metrics.avgTickMs * (1 - alpha) + tickMs * alpha;
}
