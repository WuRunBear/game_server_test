/**
 * World 负责承载 ECS 数据与运行期上下文（时间、指标、网络等）。
 */
import { createWorld } from "bitecs";

import { createMetrics, type Metrics } from "src/metrics";
import { createLogger, type Logger } from "utils/logger";
import type { MapRuntime } from "map";

/**
 * 实体 ID（ECS 中的实体索引）。
 */
export type EntityId = number;

/**
 * 逻辑帧（tick）编号。
 */
export type Tick = number;

/**
 * 运行期时间数据。
 */
export interface GameTime {
  /**
   * 当前逻辑帧编号。
   */
  tick: Tick;

  /**
   * 本帧实际步长（毫秒）。
   */
  dtMs: number;

  /**
   * 固定步长（毫秒）。
   */
  fixedDtMs: number;
}

/**
 * 游戏运行期 World：在 bitecs 的 World 基础上，扩展时间、指标、日志与地图等上下文。
 */
export type GameWorld = ReturnType<typeof createWorld> & {
  /**
   * 时间相关的运行期数据。
   */
  time: GameTime;

  /**
   * 指标采集与统计数据。
   */
  metrics: Metrics;

  /**
   * 日志实例。
   */
  logger: Logger;

  /**
   * 地图运行期数据（未加载时为空）。
   */
  map?: MapRuntime;
};

/**
 * 系统函数：对 World 执行一次更新并返回更新后的 World。
 */
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
    logger: createLogger("world"),
  }) as GameWorld;

  return world;
}
