/**
 * action：睡眠——清零移动速度后立即返回 SUCCEEDED。
 * 持续睡眠由行为树结构维持（详见下方工厂 JSDoc 对 SUCCEEDED / RUNNING 取舍的说明）。
 */
import { State } from "mistreevous";

import { Velocity } from "framework/components";
import type { BtContext } from "framework/ai/btRunner";

/**
 * action：入睡——清零移动速度并完成一帧（SUCCEEDED）。
 *
 * 返回 SUCCEEDED 而非 RUNNING：RUNNING 会让 mistreevous selector/sequence
 * 对该分支形成状态记忆（其他 FAILED 分支在 RUNNING 期间不再被重评估），
 * 导致入睡后无法根据条件变化改判（见敌不醒/天亮不醒）。SUCCEEDED 让树根
 * 每 tick 重置、全树重新评估——持续睡眠由行为树结构维持，条件变化即时生效。
 */
export function createSleepAction(_args?: Record<string, unknown>): () => State {
  return function Sleep(this: { ctx: BtContext | null }): State {
    const ctx = this.ctx;
    if (!ctx) return State.FAILED;

    Velocity.vx[ctx.self] = 0;
    Velocity.vy[ctx.self] = 0;

    return State.SUCCEEDED;
  };
}
