/**
 * action：追击——朝最近敌对目标移动直至进入自身攻击射程。
 * 目标数据来自黑板（perceptionSystem 写入），方向计算复用 steer 工具。
 */
import { State } from "mistreevous";

import { bbGet, BB_PERCEPTION_TARGET, type PerceivedTarget } from "framework/ai/blackboard";
import type { BtContext } from "framework/ai/btRunner";
import { attackRangeOf } from "framework/ai/nodes/conditions/inAttackRange";
import { clampDirectionToMapBounds, mapPixelBounds, normalizeOrFallback } from "framework/ai/nodes/steer";
import { Transform, Velocity, entityMapOf } from "framework/components";

const DEFAULT_SPEED = 60;

/**
 * action：朝最近敌对目标移动，直到进入自身攻击射程。
 *
 * - 已到位（目标距离 ≤ 自身射程）→ SUCCEEDED，让 sequence 推进到后续
 *   InAttackRange / Attack 节点（mistreevous 的 RUNNING 子节点会卡住序列）
 * - 移动中 → RUNNING（保持追击）
 * - 无目标 → FAILED（由 fallback 转 Wander）
 */
export function createChaseAction(args?: Record<string, unknown>): () => State {
  const speed = args?.speed as number | undefined;
  return function Chase(this: { ctx: BtContext | null }): State {
    const ctx = this.ctx;
    if (!ctx) return State.FAILED;

    const { world, self, bb } = ctx;
    const target = bbGet<PerceivedTarget>(bb, BB_PERCEPTION_TARGET);
    if (!target) return State.FAILED;

    // 已进入攻击射程：追击完成，交回序列执行攻击（站定，停止漂移）
    if (target.dist <= attackRangeOf(self)) {
      Velocity.vx[self] = 0;
      Velocity.vy[self] = 0;
      return State.SUCCEEDED;
    }

    const dx = Transform.x[target.eid] - Transform.x[self];
    const dy = Transform.y[target.eid] - Transform.y[self];

    const finalSpeed = speed ?? DEFAULT_SPEED;
    let dir = normalizeOrFallback(dx, dy);
    const bounds = mapPixelBounds((world.maps[entityMapOf(world, self)] ?? world.map)?.grid);
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
