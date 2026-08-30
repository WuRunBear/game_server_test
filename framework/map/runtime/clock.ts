/**
 * 时钟适配（游戏无关）：全局游戏时刻复用 world.time.tick。
 *
 * 关键融合决策：**不新增独立时钟字段**——现有 `world.time.tick`
 * （GameTime.tick，每 tick +1，RoomState.tick 已同步它）就是全局游戏时刻。
 * 补差引擎的 fromTick/toTick、初始年龄、离线补差全部以它为准，本模块只提供
 * 三个纯函数：advanceTickTo / computeOfflineTicks / readTick。
 *
 * 已知近似：昼夜 timeOfDay 由 dayNightCycleSystem 按 dtMs 逐 tick 推进、
 * 随存档恢复（恢复接线属后续持久化切片）；离线补差期间按恢复后的相位
 * 求值条件，不做逐时段历史相位回放——真实需求出现时再改派生式时钟。
 */
import type { GameWorld, Tick } from "framework/world";
import { createLogger } from "framework/utils/logger";

/** 时钟日志器（游戏无关 scope），用于离线折算截断告警。 */
const logger = createLogger("map-clock");

/**
 * 把 world.time.tick 推进到 target（开机初始年龄 / 读档离线补差边界场景）。
 *
 * tick 是纯单调计数器，直接跳进无副作用；target 不大于当前 tick 时
 * 不回退（no-op）——单调性是补差引擎分段推演等价性的前提。
 *
 * @param world 目标世界
 * @param target 目标 tick（大于当前值才产生推进）
 */
export function advanceTickTo(world: GameWorld, target: Tick): void {
  if (target > world.time.tick) {
    world.time.tick = target;
  }
}

/** 读取当前全局游戏时刻（world.time.tick）。 */
export function readTick(world: GameWorld): Tick {
  return world.time.tick;
}

/**
 * 离线时长折算：把真实离线毫秒折算为应补差的 tick 数。
 *
 * 游戏时间 = 真实时间流速：离线 tick = (nowMs − savedAtMs) × tickRate / 1000，
 * 向下取整。nowMs 不大于 savedAtMs（时钟回拨等异常）返回 0；超过
 * maxOfflineTicks 时截断到上限并 warn（防超长停服的成本悬崖）。
 * 墙钟只在 restore 流程读一次（savedAtMs/nowMs 由调用方传入），本函数
 * 不读 Date.now，可在任意上下文确定性复算。
 *
 * @param savedAtMs 存档时刻（WorldRecord.savedAt）
 * @param nowMs 当前墙钟时刻
 * @param tickRate 逻辑 tick 频率（次/秒，来自 gameDef.tickRate）
 * @param maxOfflineTicks 离线补差 tick 上限（缺省不封顶）
 * @returns 应补差的离线 tick 数（非负整数）
 */
export function computeOfflineTicks(
  savedAtMs: number,
  nowMs: number,
  tickRate: number,
  maxOfflineTicks?: number,
): number {
  if (nowMs <= savedAtMs) return 0;
  const ticks = Math.floor(((nowMs - savedAtMs) * tickRate) / 1000);
  if (maxOfflineTicks !== undefined && ticks > maxOfflineTicks) {
    logger.warn("offline ticks exceed cap, truncated", {
      savedAtMs,
      nowMs,
      tickRate,
      rawTicks: ticks,
      maxOfflineTicks,
    });
    return maxOfflineTicks;
  }
  return ticks;
}
