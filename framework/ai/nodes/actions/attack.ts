import { State } from "mistreevous";

import { bbGet, BB_PERCEPTION_TARGET, type PerceivedTarget } from "framework/ai/blackboard";
import type { BtContext } from "framework/ai/btRunner";
import { attackTarget } from "framework/systems/gameplay/combatSystem";

/**
 * action：对最近敌对目标发动一次攻击（经 attackTarget 统一校验冷却/射程/友伤）。
 * 成功 → SUCCEEDED；无目标 / 未命中 → FAILED（序列重置，回 fallback Wander）。
 */
export function createAttackAction(_args?: Record<string, unknown>): () => State {
  return function Attack(this: { ctx: BtContext | null }): State {
    const ctx = this.ctx;
    if (!ctx) return State.FAILED;

    const { world, self, bb } = ctx;
    const target = bbGet<PerceivedTarget>(bb, BB_PERCEPTION_TARGET);
    if (!target) return State.FAILED;

    return attackTarget(world, self, target.eid) ? State.SUCCEEDED : State.FAILED;
  };
}
