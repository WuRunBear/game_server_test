import type { GameWorld } from "world";
import { syncTimeOfDay } from "framework/simulation/worldClock/dayNight";

/**
 * dayNightCycleSystem：把世界昼夜状态重算为当前 tick 的派生值。
 *
 * hour/phase 是 `world.time.tick` 的纯函数（见 worldClock/dayNight）：每天
 * `cycleLengthSec × tickRate` tick 循环，夜晚区间由 nightStartHour/nightEndHour
 * 决定。本系统只做"从 tick 重算并写入 `world.time.timeOfDay`"——不按 dtMs
 * 累积，因此在线逐 tick、离线补差、读档恢复得到同一结果（无双时钟漂移）。
 *
 * 无 daynight 规则配置时保持初始状态（no-op），世界从 createGameWorld
 * 的初始小时（8，白天）开始。
 *
 * 相位是通用机制词（编号而非语义），消费方（spawn condition / BT 条件）
 * 按编号比较。游戏无关。
 */
export function dayNightCycleSystem(world: GameWorld): GameWorld {
  return syncTimeOfDay(world);
}
