import { State } from "mistreevous";
import { hasComponent } from "bitecs";

import { bbGet, BB_PERCEPTION_TARGET, type PerceivedTarget } from "framework/ai/blackboard";
import type { BtContext } from "framework/ai/btRunner";
import { Cooldown } from "framework/components";
import { attackTarget } from "framework/systems/gameplay/combatSystem";

/**
 * action：对最近敌对目标发动一次攻击（经 attackTarget 统一校验冷却/射程/友伤）。
 *
 * - 冷却中 → RUNNING（保持接战，不退回 Wander；待冷却结束后重试）
 * - 命中 → SUCCEEDED（序列重置，重新评估感知/追击）
 * - 无目标 / 超射程 / 目标已死 → FAILED（序列失败，回 fallback Wander）
 */
export function createAttackAction(_args?: Record<string, unknown>): () => State {
  return function Attack(this: { ctx: BtContext | null }): State {
    const ctx = this.ctx;
    if (!ctx) return State.FAILED;

    const { world, self, bb } = ctx;
    const target = bbGet<PerceivedTarget>(bb, BB_PERCEPTION_TARGET);
    if (!target) return State.FAILED;

    if (hasComponent(world, self, Cooldown) && (Cooldown.remainingMs[self] ?? 0) > 0) {
      return State.RUNNING;
    }

    return attackTarget(world, self, target.eid) ? State.SUCCEEDED : State.FAILED;
  };
}
