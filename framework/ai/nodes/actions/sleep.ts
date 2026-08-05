import { State } from "mistreevous";

import { Velocity } from "framework/components";
import type { BtContext } from "framework/ai/btRunner";

/**
 * action：入睡——清零移动速度并保持（RUNNING）。
 *
 * 睡眠持续到行为树因其他条件切换分支（如天亮）为止。
 */
export function createSleepAction(_args?: Record<string, unknown>): () => State {
  return function Sleep(this: { ctx: BtContext | null }): State {
    const ctx = this.ctx;
    if (!ctx) return State.FAILED;

    Velocity.vx[ctx.self] = 0;
    Velocity.vy[ctx.self] = 0;

    return State.RUNNING;
  };
}
