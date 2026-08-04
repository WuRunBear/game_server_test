import { Attack } from "framework/components";
import { DEFAULT_ATTACK_RANGE } from "framework/systems/gameplay/combatSystem";
import { bbGet, BB_PERCEPTION_TARGET, type PerceivedTarget } from "framework/ai/blackboard";
import type { BtContext } from "framework/ai/btRunner";

/** 取自身攻击射程（组件优先，回退默认值）。 */
export function attackRangeOf(self: number): number {
  const compRange = Attack.range[self];
  return typeof compRange === "number" && compRange > 0 ? compRange : DEFAULT_ATTACK_RANGE;
}

/**
 * condition：最近敌对目标是否在自身攻击射程内。
 */
export function createInAttackRangeCondition(_args?: Record<string, unknown>): () => boolean {
  return function InAttackRange(this: { ctx: BtContext | null }): boolean {
    const ctx = this.ctx;
    if (!ctx) return false;
    const target = bbGet<PerceivedTarget>(ctx.bb, BB_PERCEPTION_TARGET);
    if (!target) return false;
    return target.dist <= attackRangeOf(ctx.self);
  };
}
