/**
 * condition：当前世界时间是否处于夜晚相位。
 * 供"入夜切换行为"类分支使用，具体分支逻辑由行为树组织决定。
 */
import { PHASE_NIGHT } from "framework/world";
import type { BtContext } from "framework/ai/btRunner";

/**
 * condition：当前是否为夜晚相位。
 *
 * 数据源：world.time.timeOfDay.phase（dayNightCycleSystem 推进），
 * 按通用相位编号（PHASE_NIGHT）比较，不含游戏语义。
 */
export function createIsNightCondition(_args?: Record<string, unknown>): () => boolean {
  return function IsNight(this: { ctx: BtContext | null }): boolean {
    const ctx = this.ctx;
    if (!ctx) return false;
    return ctx.world.time.timeOfDay.phase === PHASE_NIGHT;
  };
}
