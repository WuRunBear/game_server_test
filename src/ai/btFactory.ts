import type { BehaviorNode } from "./btRunner";
import { idleAction } from "./nodes/actions/idle";

export function createDefaultNpcTree(): BehaviorNode {
  return idleAction();
}
