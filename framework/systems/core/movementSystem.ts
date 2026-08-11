import { query } from "bitecs";

import { Transform, Velocity } from "components";
import type { GameWorld } from "world";

/**
 * 移动系统：把速度积分到位置上（位置 += 速度 × dt）。
 *
 * 运行位置：每 tick 在 physicsSystem 之后、collisionSystem 之前——
 * 物理系统先按加速度更新速度，本系统按速度推进位置，
 * 随后碰撞系统纠正由此产生的重叠/越界。
 * 只处理同时挂有 Transform（位置）与 Velocity（速度）的实体。
 */
export function movementSystem(world: GameWorld): GameWorld {
  // dt 统一换算为秒：速度组件以"像素/秒"为单位
  const dtSec = world.time.dtMs / 1000;

  for (const eid of query(world, [Transform, Velocity])) {
    Transform.x[eid] += Velocity.vx[eid] * dtSec;
    Transform.y[eid] += Velocity.vy[eid] * dtSec;
  }

  return world;
}
