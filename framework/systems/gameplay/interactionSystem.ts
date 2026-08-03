import { query } from "bitecs";
import { Player, Transform, Resource, Intent } from "components";
import type { GameWorld } from "world";
import { harvest } from "framework/systems/gameplay/gatheringSystem";

interface SystemConfig {
  range?: number;
}

const DEFAULT_RANGE = 24;

/**
 * interactionSystem：交互意图路由器。
 *
 * 输入信号（interact）由 GameSimulation.applyInputs 写入 Intent[player]；
 * 本系统消费意图——在 range 内找最近资源节点，调 harvest；
 * 无论成败清空 Intent（consume-or-discard 语义，不让意图跨帧堆积）。
 *
 * 游戏无关——只识别通用 "interact" 意图与 Resource 标签；具体产出由
 * gatheringSystem 按 yieldsKind 决定。后续切片若加 equip/craft 等意图类型，
 * 在此扩 switch（即需即补，不提前造意图枚举）。
 */
export function createInteractionSystem(config?: Record<string, unknown>) {
  const cfg: SystemConfig = {
    range: config?.range as number | undefined,
  };

  return function interactionSystem(world: GameWorld): GameWorld {
    const range = cfg.range ?? DEFAULT_RANGE;

    for (const playerEid of query(world, [Player, Transform])) {
      const intent = Intent[playerEid];
      if (!intent) continue;
      // 先清空：意图只在本帧生效
      Intent[playerEid] = null;
      if (intent !== "interact") continue;

      const px = Transform.x[playerEid];
      const py = Transform.y[playerEid];

      let nearestEid = -1;
      let nearestDist = Infinity;
      for (const nodeEid of query(world, [Resource, Transform])) {
        const d = Math.hypot(px - Transform.x[nodeEid], py - Transform.y[nodeEid]);
        if (d <= range && d < nearestDist) {
          nearestEid = nodeEid;
          nearestDist = d;
        }
      }

      if (nearestEid >= 0) {
        harvest(world, playerEid, nearestEid);
      }
    }

    return world;
  };
}

/** 无配置默认实例（向后兼容直接注册形态）。 */
export function interactionSystem(world: GameWorld): GameWorld {
  return createInteractionSystem()(world);
}