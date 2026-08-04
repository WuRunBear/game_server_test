import { bbGet, BB_PERCEPTION_TARGET, type PerceivedTarget } from "framework/ai/blackboard";
import type { BtContext } from "framework/ai/btRunner";

/**
 * condition：最近敌对目标是否在感知范围内。
 *
 * 数据源：perceptionSystem 每 tick 写入的 `perception.target`。
 */
export function createIsTargetInVisionCondition(_args?: Record<string, unknown>): () => boolean {
  return function IsTargetInVision(this: { ctx: BtContext | null }): boolean {
    const ctx = this.ctx;
    if (!ctx) return false;
    return bbGet<PerceivedTarget>(ctx.bb, BB_PERCEPTION_TARGET) !== undefined;
  };
}
