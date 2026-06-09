import { State } from "mistreevous";

import { bbGet, bbSet } from "ai/blackboard";
import type { BtContext } from "ai/btRunner";
import { Transform, Velocity } from "components";

type WanderRuntime = {
  nextChangeTick: number;
  dirX: number;
  dirY: number;
};

const BB_KEY = "ai.wander.runtime";

function randInt(min: number, maxInclusive: number): number {
  return Math.floor(Math.random() * (maxInclusive - min + 1)) + min;
}

function normalizeOrFallback(x: number, y: number): { x: number; y: number } {
  const len = Math.hypot(x, y);
  if (len <= 1e-6) return { x: 1, y: 0 };
  return { x: x / len, y: y / len };
}

function clampDirectionToMapBounds(
  x: number,
  y: number,
  dirX: number,
  dirY: number,
  tileW: number,
  tileH: number,
  mapPixelW: number,
  mapPixelH: number,
): { x: number; y: number } {
  const marginX = tileW;
  const marginY = tileH;

  let dx = dirX;
  let dy = dirY;

  if (x < marginX) dx = Math.abs(dx);
  if (x > mapPixelW - marginX) dx = -Math.abs(dx);
  if (y < marginY) dy = Math.abs(dy);
  if (y > mapPixelH - marginY) dy = -Math.abs(dy);

  return normalizeOrFallback(dx, dy);
}

/**
 * 创建一个“随机游走”动作节点：NPC 会周期性随机一个方向，并持续沿该方向移动。
 *
 * 约定：
 * - 每次方向保持一段随机时长（以 tick 计），到期后重新抽取方向
 * - 速度单位与移动系统一致（世界单位/秒）
 *
 * @param speed 每秒移动速度（未传则按地图 tile 尺寸估算）
 * @returns 返回一个可被行为树调用的 action 函数
 */
export function createWanderAction(speed?: number): () => State {
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

    const grid = world.map?.grid;
    const tileW = grid?.tileWidth ?? 16;
    const tileH = grid?.tileHeight ?? 16;
    const finalSpeed = speed ?? tileW * 2;

    let dir = normalizeOrFallback(rt.dirX, rt.dirY);
    if (grid) {
      const mapPixelW = grid.width * grid.tileWidth;
      const mapPixelH = grid.height * grid.tileHeight;
      dir = clampDirectionToMapBounds(
        Transform.x[self],
        Transform.y[self],
        dir.x,
        dir.y,
        tileW,
        tileH,
        mapPixelW,
        mapPixelH,
      );
    }

    Velocity.vx[self] = dir.x * finalSpeed;
    Velocity.vy[self] = dir.y * finalSpeed;

    return State.RUNNING;
  };
}
