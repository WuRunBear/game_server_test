import { hasComponent, query } from "bitecs";
import { Perception, Transform, Team, Health, NPC } from "components";
import { bbSet, BB_PERCEPTION_TARGET, type PerceivedTarget } from "ai/blackboard";
import { getOrCreateBlackboard } from "framework/systems/gameplay/aiSystem";
import { isPointInLight } from "framework/utils/light";
import type { GameWorld } from "world";

/**
 * perceptionSystem：感知扫描。
 *
 * 对每个 [Perception, NPC] 实体：在 visionRadius 内找最近的可感知敌对实体，
 * 结果写黑板 `perception.target`（{eid, dist}，无则 **null**——注意是写入
 * null 而非不写 key），供 BT 条件/动作（IsTargetInVision / Chase / Flee / Attack）消费。
 *
 * 可感知判定（通用约定）：
 * - 非本队（Team.id 不同）且非中立（Team.id = 0 视为中立，不构成感知目标）
 * - 必须是活物：有 Health 组件且当前 Health > 0（尸体/重生窗口内的玩家不追猎）
 * - 不在任一有效光源（LightSource）半径内：光源是"安全区"通用机制，
 *   光内的实体不可被敌对感知（火光回避的感知侧实现）
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
        const otherTeam = Team.id[other];
        if (otherTeam === 0 || otherTeam === myTeam) continue;
        if (!hasComponent(world, other, Health) || (Health.current[other] ?? 0) <= 0) continue;
        // 火光回避：光内目标不可感知
        if (isPointInLight(world, Transform.x[other], Transform.y[other])) continue;
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
