import type { Blackboard } from "ai/blackboard";
import type { EntityId, GameWorld } from "src/world";

export type NodeStatus = "success" | "failure" | "running";

export interface BehaviorNode {
  tick(world: GameWorld, self: EntityId, bb: Blackboard): NodeStatus;
}

export function runBehaviorTree(
  world: GameWorld,
  root: BehaviorNode,
  self: EntityId,
  bb: Blackboard,
): NodeStatus {
  return root.tick(world, self, bb);
}
