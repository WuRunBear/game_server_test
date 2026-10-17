/**
 * action：追击——朝最近敌对目标移动直至进入自身攻击射程。
 * 目标数据来自黑板（perceptionSystem 写入），方向计算复用 steer 工具。
 *
 * 寻路接线（玩法切片 D1）：直线可达时保持原有直线移动；被墙阻挡时走确定性
 * A* 路径的下一个 waypoint，按 repathTicks 节流重算，不可达则回退直线。
 * 移动本身仍写 Velocity，由 movement/physics 积分。
 */
import { State } from "mistreevous";

import { bbGet, BB_PERCEPTION_TARGET, type PerceivedTarget } from "framework/ai/blackboard";
import type { BtContext } from "framework/ai/btRunner";
import { attackRangeOf } from "framework/ai/nodes/conditions/inAttackRange";
import { clampDirectionToMapBounds, mapPixelBounds, normalizeOrFallback } from "framework/ai/nodes/steer";
import {
  parseActionPathfindingArg,
  resolvePathfindingConfig,
} from "framework/ai/pathfinding/config";
import { BB_NAV_CHASE, navigateTowardsPath } from "framework/ai/pathfinding/navigate";
import { Transform, Velocity, entityMapOf } from "framework/components";
import { entityLevelOf } from "framework/components/entityLevel";

const DEFAULT_SPEED = 60;

/**
 * action：朝最近敌对目标移动，直到进入自身攻击射程。
 *
 * - 已到位（目标距离 ≤ 自身射程）→ SUCCEEDED，让 sequence 推进到后续
 *   InAttackRange / Attack 节点（mistreevous 的 RUNNING 子节点会卡住序列）
 * - 移动中 → RUNNING（保持追击）
 * - 无目标 → FAILED（由 fallback 转 Wander）
 *
 * 寻路只改变「朝哪个方向走」：直线畅通/寻路失败时与旧实现逐字节等价。
 */
export function createChaseAction(args?: Record<string, unknown>): () => State {
  const speed = args?.speed as number | undefined;
  // 节点级覆盖在工厂创建期校验（配置拼写错误尽早抛错）
  const pathOverrides = parseActionPathfindingArg(args?.pathfinding, "Chase");
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

    const mapId = entityMapOf(world, self);
    const geometry = world.maps[mapId];
    let dir: { x: number; y: number } | null = null;

    if (geometry) {
      const config = resolvePathfindingConfig(world, pathOverrides);
      if (config.enabled) {
        const targetTile = {
          x: Math.floor(Transform.x[target.eid] / geometry.grid.tileWidth),
          y: Math.floor(Transform.y[target.eid] / geometry.grid.tileHeight),
          level: entityLevelOf(target.eid),
        };
        dir = navigateTowardsPath(ctx, {
          key: BB_NAV_CHASE,
          goal: targetTile,
          config,
        });
      }
    }

    // 兜底：直线可达 / 无地图 / 寻路失败 → 旧直线行为（绝不原地卡死）
    const finalSpeed = speed ?? DEFAULT_SPEED;
    let moveDir = dir ?? normalizeOrFallback(dx, dy);
    const bounds = mapPixelBounds(geometry?.grid);
    if (bounds) {
      moveDir = clampDirectionToMapBounds(
        Transform.x[self],
        Transform.y[self],
        moveDir.x,
        moveDir.y,
        bounds,
      );
    }

    Velocity.vx[self] = moveDir.x * finalSpeed;
    Velocity.vy[self] = moveDir.y * finalSpeed;

    return State.RUNNING;
  };
}
