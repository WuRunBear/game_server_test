import { query } from "bitecs";

import { Acceleration, Velocity } from "components";
import type { GameWorld } from "world";

/**
 * 物理系统：把加速度积分到速度上（v += a * dt）。
 *
 * 运行位置：每 tick 最先执行（位于移动系统之前）——
 * 先由本系统按加速度更新速度，再由 movementSystem 按速度更新位置。
 * 只处理同时挂有 Velocity（速度）与 Acceleration（加速度）的实体；
 * 无加速度的实体（如手动写 Velocity 的输入驱动实体）不受此系统影响。
 *
 * @param world ECS World
 * @returns 处理后的 World
 */
export function physicsSystem(world: GameWorld): GameWorld {
  // dt 统一换算为秒：加速度组件以"像素/秒²"为单位
  const dtSec = world.time.dtMs / 1000;

  for (const eid of query(world, [Velocity, Acceleration])) {
    Velocity.vx[eid] += Acceleration.ax[eid] * dtSec;
    Velocity.vy[eid] += Acceleration.ay[eid] * dtSec;
  }

  return world;
}
