import type { BehaviorNode, NodeStatus } from "ai/btRunner";
import type { Blackboard } from "ai/blackboard";
import type { EntityId, GameWorld } from "src/world";

export function idleAction(): BehaviorNode {
  return {
    tick(_world: GameWorld, _self: EntityId, _bb: Blackboard): NodeStatus {
      return "success";
    },
  };
}
