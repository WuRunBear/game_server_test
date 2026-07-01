import type { ActionRegistry } from "framework/ai/actionRegistry";
import { createIdleAction } from "framework/ai/nodes/actions/idle";
import { createWanderAction } from "framework/ai/nodes/actions/wander";

export function registerBuiltinActions(registry: ActionRegistry): void {
  registry.register("Idle", createIdleAction);
  registry.register("Wander", createWanderAction);
}
