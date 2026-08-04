import { State } from "mistreevous";

import { bbGet, BB_PERCEPTION_TARGET, type PerceivedTarget } from "framework/ai/blackboard";
import type { BtContext } from "framework/ai/btRunner";
import { clampDirectionToMapBounds, mapPixelBounds, normalizeOrFallback } from "framework/ai/nodes/steer";
import { Transform, Velocity } from "framework/components";

const DEFAULT_SPEED = 80;

/** 背向最近敌对目标移动；无目标 → SUCCEEDED（无需逃窜）。 */
export function createFleeAction(args?: Record<string, unknown>): () => State {
  const speed = args?.speed as number | undefined;
  return function Flee(this: { ctx: BtContext | null }): State {
    const ctx = this.ctx;
    if (!ctx) return State.FAILED;

    const { world, self, bb } = ctx;
    const target = bbGet<PerceivedTarget>(bb, BB_PERCEPTION_TARGET);
    if (!target) return State.SUCCEEDED;

    const dx = Transform.x[self] - Transform.x[target.eid];
    const dy = Transform.y[self] - Transform.y[target.eid];

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
