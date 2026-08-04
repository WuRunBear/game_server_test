import { query } from "bitecs";
import { Perception, Transform, Team, NPC } from "components";
import { bbSet, BB_PERCEPTION_TARGET, type PerceivedTarget } from "ai/blackboard";
import { getOrCreateBlackboard } from "framework/systems/gameplay/aiSystem";
import type { GameWorld } from "world";

/**
 * perceptionSystem：感知扫描。
 *
 * 对每个 [Perception, NPC] 实体：在 visionRadius 内找最近的非同队实体，
 * 结果写黑板 `perception.target`（{eid, dist}，无则 null），供 BT
 * 条件/动作（IsTargetInVision / Chase / Flee / Attack）消费。
 *
 * 游戏无关——只按 Team 分组与半径通用字段，不识别具体阵营语义。
 */
export function perceptionSystem(world: GameWorld): GameWorld {
  for (const eid of query(world, [Perception, Transform, Team, NPC])) {
    const bb = getOrCreateBlackboard(world, eid);
    const radius = Perception.visionRadius[eid] ?? 0;
    const myTeam = Team.id[eid];

    let best: PerceivedTarget | null = null;
    if (radius > 0) {
      for (const other of query(world, [Transform, Team])) {
        if (other === eid) continue;
        if (Team.id[other] === myTeam) continue;
        const dist = Math.hypot(
          Transform.x[eid] - Transform.x[other],
          Transform.y[eid] - Transform.y[other],
        );
        if (dist <= radius && (!best || dist < best.dist)) {
          best = { eid: other, dist };
        }
      }
    }

    bbSet(bb, BB_PERCEPTION_TARGET, best);
  }

  return world;
}
