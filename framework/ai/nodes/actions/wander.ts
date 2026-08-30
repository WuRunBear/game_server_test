/**
 * action：游荡——无目标时在随机方向上漫无目的地移动。
 * 每 tick 以固定间隔（20~60 tick）随机换向，运行期状态存于黑板，
 * 跨 tick 保持当前方向；速度默认取 2 倍格宽，可用 args.speed 覆盖。
 */
import { State } from "mistreevous";

import { bbGet, bbSet } from "framework/ai/blackboard";
import type { BtContext } from "framework/ai/btRunner";
import {
  normalizeOrFallback,
  mapPixelBounds,
  clampDirectionToMapBounds,
} from "framework/ai/nodes/steer";
import { Transform, Velocity, entityMapOf } from "framework/components";

/** 游荡节点的运行期状态（存入黑板，跨 tick 保持方向与换向时机）。 */
type WanderRuntime = {
  nextChangeTick: number; // 下一次随机换向的世界 tick
  dirX: number;           // 当前移动方向 x
  dirY: number;           // 当前移动方向 y
};

/** 黑板 key：游荡运行期状态（随机方向、换向 tick）。 */
const BB_KEY = "ai.wander.runtime";

/** 生成 [min, maxInclusive] 闭区间的随机整数。 */
function randInt(min: number, maxInclusive: number): number {
  return Math.floor(Math.random() * (maxInclusive - min + 1)) + min;
}

/**
 * 游荡节点工厂：
 * - 首次执行时在黑板初始化运行期状态，之后复用；
 * - 到达换向 tick 则随机选一个 360° 方向并排下一次换向时机；
 * - 靠近地图边缘时把方向钳制回界内（复用 steer 工具），避免走出地图。
 */
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

    const bounds = mapPixelBounds(world.maps[entityMapOf(world, self)]?.grid);
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
