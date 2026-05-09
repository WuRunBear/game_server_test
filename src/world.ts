/**
 * World 负责承载 ECS 数据与运行期上下文（时间、指标、网络等）。
 */
import { createWorld } from "bitecs";

import { createMetrics, type Metrics } from "./metrics";
import type { NetworkRuntime } from "./network/server";

export type EntityId = number;
export type Tick = number;

export interface GameTime {
  tick: Tick;
  dtMs: number;
  fixedDtMs: number;
}

export type GameWorld = ReturnType<typeof createWorld> & {
  time: GameTime;
  metrics: Metrics;
  net?: NetworkRuntime;
};

export type System = (world: GameWorld) => GameWorld;

/**
 * 创建一个可用于服务器主循环的 World。
 *
 * @param fixedDtMs 固定步长（毫秒）
 * @returns 初始化后的 World
 */
export function createGameWorld(fixedDtMs: number): GameWorld {
  const world = createWorld({
    time: {
      tick: 0,
      dtMs: fixedDtMs,
      fixedDtMs,
    },
    metrics: createMetrics(),
  }) as GameWorld;

  return world;
}
