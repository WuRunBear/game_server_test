import { State } from "mistreevous";

import { bbGet, bbSet } from "framework/ai/blackboard";
import type { BtContext } from "framework/ai/btRunner";
import {
  normalizeOrFallback,
  mapPixelBounds,
  clampDirectionToMapBounds,
} from "framework/ai/nodes/steer";
import { Transform, Velocity } from "framework/components";

type WanderRuntime = {
  nextChangeTick: number;
  dirX: number;
  dirY: number;
};

const BB_KEY = "ai.wander.runtime";

function randInt(min: number, maxInclusive: number): number {
  return Math.floor(Math.random() * (maxInclusive - min + 1)) + min;
}

export function createWanderAction(args?: Record<string, unknown>): () => State {
  const speed = args?.speed as number | undefined;
  return function Wander(this: { ctx: BtContext | null }): State {
    const ctx = this.ctx;
    if (!ctx) return State.FAILED;

    const { world, self, bb } = ctx;
    const tick = world.time.tick;

    const existing = bbGet<WanderRuntime>(bb, BB_KEY);
    let rt = existing;
    if (!rt) {
      rt = { nextChangeTick: -1, dirX: 1, dirY: 0 };
      bbSet(bb, BB_KEY, rt);
    }

    if (tick >= rt.nextChangeTick) {
      const angle = Math.random() * Math.PI * 2;
      const picked = normalizeOrFallback(Math.cos(angle), Math.sin(angle));
      rt.dirX = picked.x;
      rt.dirY = picked.y;
      rt.nextChangeTick = tick + randInt(20, 60);
    }

    const bounds = mapPixelBounds(world.map?.grid);
    const tileW = bounds?.tileW ?? 16;
    const finalSpeed = speed ?? tileW * 2;

    let dir = normalizeOrFallback(rt.dirX, rt.dirY);
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
