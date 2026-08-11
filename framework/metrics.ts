/**
 * 运行指标收集（游戏无关）：统计每帧耗时，供性能观测/调试使用。
 */

/** 指标集合：挂在 world.metrics 上，由 GameInstance 每 tick 更新。 */
export interface Metrics {
  /** 已执行的逻辑帧总数。 */
  tickCount: number;
  /** 最近一帧耗时（毫秒）。 */
  lastTickMs: number;
  /** 帧耗时滑动平均值（指数平滑，越近的帧权重越大）。 */
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
