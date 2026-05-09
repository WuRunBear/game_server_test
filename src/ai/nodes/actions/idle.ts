import type { BehaviorNode, NodeStatus } from "../../btRunner";
import type { Blackboard } from "../../blackboard";
import type { EntityId, GameWorld } from "../../../world";

export function idleAction(): BehaviorNode {
  return {
    tick(_world: GameWorld, _self: EntityId, _bb: Blackboard): NodeStatus {
      return "success";
    },
  };
}
