import type { BehaviorNode } from "ai/btRunner";
import { idleAction } from "ai/nodes/actions/idle";

export function createDefaultNpcTree(): BehaviorNode {
  return idleAction();
}
