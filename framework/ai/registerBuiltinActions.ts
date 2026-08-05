import type { ActionRegistry } from "framework/ai/actionRegistry";
import { createIdleAction } from "framework/ai/nodes/actions/idle";
import { createWanderAction } from "framework/ai/nodes/actions/wander";
import { createChaseAction } from "framework/ai/nodes/actions/chase";
import { createFleeAction } from "framework/ai/nodes/actions/flee";
import { createAttackAction } from "framework/ai/nodes/actions/attack";
import { createSleepAction } from "framework/ai/nodes/actions/sleep";
import { createIsTargetInVisionCondition } from "framework/ai/nodes/conditions/isTargetInVision";
import { createIsTargetNotInVisionCondition } from "framework/ai/nodes/conditions/isTargetNotInVision";
import { createInAttackRangeCondition } from "framework/ai/nodes/conditions/inAttackRange";
import { createIsNightCondition } from "framework/ai/nodes/conditions/isNight";
import { createIsInLightCondition } from "framework/ai/nodes/conditions/isInLight";

export function registerBuiltinActions(registry: ActionRegistry): void {
  registry.register("Idle", createIdleAction);
  registry.register("Wander", createWanderAction);
  registry.register("Chase", createChaseAction);
  registry.register("Flee", createFleeAction);
  registry.register("Attack", createAttackAction);
  registry.register("Sleep", createSleepAction);
  registry.register("IsTargetInVision", createIsTargetInVisionCondition);
  registry.register("IsTargetNotInVision", createIsTargetNotInVisionCondition);
  registry.register("InAttackRange", createInAttackRangeCondition);
  registry.register("IsNight", createIsNightCondition);
  registry.register("IsInLight", createIsInLightCondition);
}
