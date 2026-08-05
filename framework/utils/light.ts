import { query } from "bitecs";
import { LightSource, Transform } from "components";
import type { GameWorld } from "world";

/**
 * 光源判定通用工具：某坐标是否处于任一有效光源（LightSource）的半径内。
 *
 * 燃料 ≤ 0 的光源视为熄灭（不发光）。供 BT 条件（IsInLight）与
 * perceptionSystem（火光回避：光内目标不可感知）共用，不含游戏语义。
 */
export function isPointInLight(world: GameWorld, x: number, y: number): boolean {
  for (const eid of query(world, [Transform, LightSource])) {
    if ((LightSource.fuelRemainingMs[eid] ?? 0) <= 0) continue;
    const radius = LightSource.radius[eid] ?? 0;
    if (radius <= 0) continue;
    if (Math.hypot(Transform.x[eid] - x, Transform.y[eid] - y) <= radius) {
      return true;
    }
  }
  return false;
}
