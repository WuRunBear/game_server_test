import type { ActionRegistry } from "framework/ai/actionRegistry";
import { createIdleAction } from "framework/ai/nodes/actions/idle";
import { createWanderAction } from "framework/ai/nodes/actions/wander";
import { createChaseAction } from "framework/ai/nodes/actions/chase";
import { createFleeAction } from "framework/ai/nodes/actions/flee";
import { createAttackAction } from "framework/ai/nodes/actions/attack";
import { createIsTargetInVisionCondition } from "framework/ai/nodes/conditions/isTargetInVision";
import { createInAttackRangeCondition } from "framework/ai/nodes/conditions/inAttackRange";

export function registerBuiltinActions(registry: ActionRegistry): void {
  registry.register("Idle", createIdleAction);
  registry.register("Wander", createWanderAction);
  registry.register("Chase", createChaseAction);
  registry.register("Flee", createFleeAction);
  registry.register("Attack", createAttackAction);
  registry.register("IsTargetInVision", createIsTargetInVisionCondition);
  registry.register("InAttackRange", createInAttackRangeCondition);
}
