/**
 * action：逃离——背向最近敌对目标移动（远离威胁）。
 * 目标数据来自黑板感知结果；无目标时直接成功返回（无需逃窜），
 * 移动速度默认 80，可用 args.speed 覆盖。
 *
 * 寻路接线（玩法切片 D1）：与 Chase 共用同一套「直线可达 → 直走 / 被挡 →
 * A* waypoint」逻辑；逃逸目标取背向方向上最远的可走格，不可达时回退旧直线。
 */
import { State } from "mistreevous";

import { bbGet, BB_PERCEPTION_TARGET, type PerceivedTarget } from "framework/ai/blackboard";
import type { BtContext } from "framework/ai/btRunner";
import { clampDirectionToMapBounds, mapPixelBounds, normalizeOrFallback } from "framework/ai/nodes/steer";
import {
  parseActionPathfindingArg,
  resolvePathfindingConfig,
} from "framework/ai/pathfinding/config";
import { BB_NAV_FLEE, navigateTowardsPath, pickFleeGoalTile } from "framework/ai/pathfinding/navigate";
import { Transform, Velocity, entityMapOf } from "framework/components";
import { entityLevelOf } from "framework/components/entityLevel";

const DEFAULT_SPEED = 80;

/** 背向最近敌对目标移动；无目标 → SUCCEEDED（无需逃窜）。 */
export function createFleeAction(args?: Record<string, unknown>): () => State {
  const speed = args?.speed as number | undefined;
  const pathOverrides = parseActionPathfindingArg(args?.pathfinding, "Flee");
  return function Flee(this: { ctx: BtContext | null }): State {
    const ctx = this.ctx;
    if (!ctx) return State.FAILED;

    const { world, self, bb } = ctx;
    const target = bbGet<PerceivedTarget>(bb, BB_PERCEPTION_TARGET);
    if (!target) return State.SUCCEEDED;

    const dx = Transform.x[self] - Transform.x[target.eid];
    const dy = Transform.y[self] - Transform.y[target.eid];

    const mapId = entityMapOf(world, self);
    const geometry = world.maps[mapId];
    const fallbackDir = normalizeOrFallback(dx, dy);
    let dir: { x: number; y: number } | null = null;

    if (geometry) {
      const config = resolvePathfindingConfig(world, pathOverrides);
      if (config.enabled) {
        const level = entityLevelOf(self);
        const goal = pickFleeGoalTile(
          world,
          mapId,
          geometry,
          {
            x: Math.floor(Transform.x[self] / geometry.grid.tileWidth),
            y: Math.floor(Transform.y[self] / geometry.grid.tileHeight),
            level,
          },
          fallbackDir,
          config.fleeGoalDistance,
        );
        if (goal) {
          dir = navigateTowardsPath(ctx, {
            key: BB_NAV_FLEE,
            goal,
            config,
          });
        }
      }
    }

    // 兜底：直线可达 / 无地图 / 无逃逸目标 / 寻路失败 → 旧直线行为
    const finalSpeed = speed ?? DEFAULT_SPEED;
    let moveDir = dir ?? fallbackDir;
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
