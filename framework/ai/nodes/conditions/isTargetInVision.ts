/**
 * condition：黑板上是否存在感知到的敌对目标（感知范围内是否有目标）。
 * 目标由感知系统（perceptionSystem）写入黑板，详见下方工厂 JSDoc。
 */
import { bbGet, BB_PERCEPTION_TARGET, type PerceivedTarget } from "framework/ai/blackboard";
import type { BtContext } from "framework/ai/btRunner";

/**
 * condition：最近敌对目标是否在感知范围内。
 *
 * 数据源：perceptionSystem 每 tick 写入的 `perception.target`（无目标时写 null，
 * 而非不写 key）——因此必须用 `!= null` 同时排除 undefined（未写）与 null（无目标）。
 */
export function createIsTargetInVisionCondition(_args?: Record<string, unknown>): () => boolean {
  return function IsTargetInVision(this: { ctx: BtContext | null }): boolean {
    const ctx = this.ctx;
    if (!ctx) return false;
    return bbGet<PerceivedTarget>(ctx.bb, BB_PERCEPTION_TARGET) != null;
  };
}
