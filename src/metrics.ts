export interface Metrics {
  tickCount: number;
  lastTickMs: number;
  avgTickMs: number;
}

export function createMetrics(): Metrics {
  return {
    tickCount: 0,
    lastTickMs: 0,
    avgTickMs: 0,
  };
}

export function recordTick(metrics: Metrics, tickMs: number): void {
  metrics.tickCount += 1;
  metrics.lastTickMs = tickMs;

  const alpha = 0.05;
  metrics.avgTickMs =
    metrics.tickCount === 1 ? tickMs : metrics.avgTickMs * (1 - alpha) + tickMs * alpha;
}
