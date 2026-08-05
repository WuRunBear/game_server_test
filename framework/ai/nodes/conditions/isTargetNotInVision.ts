import { bbGet, BB_PERCEPTION_TARGET, type PerceivedTarget } from "framework/ai/blackboard";
import type { BtContext } from "framework/ai/btRunner";

/**
 * condition：感知范围内**没有**敌对目标（IsTargetInVision 的反向）。
 *
 * 数据源：perceptionSystem 每 tick 写入的 `perception.target`（无目标时写 null）。
 * 主要用于 mistreevous 的 while/until guard（Sleep 时见敌即醒等）。
 */
export function createIsTargetNotInVisionCondition(_args?: Record<string, unknown>): () => boolean {
  return function IsTargetNotInVision(this: { ctx: BtContext | null }): boolean {
    const ctx = this.ctx;
    if (!ctx) return false;
    return bbGet<PerceivedTarget>(ctx.bb, BB_PERCEPTION_TARGET) == null;
  };
}
