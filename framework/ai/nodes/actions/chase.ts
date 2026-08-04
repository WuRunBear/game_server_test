import { State } from "mistreevous";

import { bbGet, BB_PERCEPTION_TARGET, type PerceivedTarget } from "framework/ai/blackboard";
import type { BtContext } from "framework/ai/btRunner";
import { clampDirectionToMapBounds, mapPixelBounds, normalizeOrFallback } from "framework/ai/nodes/steer";
import { Transform, Velocity } from "framework/components";

const DEFAULT_SPEED = 60;

/** 朝最近敌对目标移动；无目标 → FAILED（由 fallback 转 Wander）。 */
export function createChaseAction(args?: Record<string, unknown>): () => State {
  const speed = args?.speed as number | undefined;
  return function Chase(this: { ctx: BtContext | null }): State {
    const ctx = this.ctx;
    if (!ctx) return State.FAILED;

    const { world, self, bb } = ctx;
    const target = bbGet<PerceivedTarget>(bb, BB_PERCEPTION_TARGET);
    if (!target) return State.FAILED;

    const dx = Transform.x[target.eid] - Transform.x[self];
    const dy = Transform.y[target.eid] - Transform.y[self];

    const finalSpeed = speed ?? DEFAULT_SPEED;
    let dir = normalizeOrFallback(dx, dy);
    const bounds = mapPixelBounds(world.map?.grid);
    if (bounds) {
      dir = clampDirectionToMapBounds(
        Transform.x[self],
        Transform.y[self],
        dir.x,
        dir.y,
        bounds,
      );
    }

    Velocity.vx[self] = dir.x * finalSpeed;
    Velocity.vy[self] = dir.y * finalSpeed;

    return State.RUNNING;
  };
}
