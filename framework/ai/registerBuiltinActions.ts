/**
 * 内置行为树节点注册：把框架自带的 action / condition 工厂统一注册进 ActionRegistry。
 *
 * 注册名即行为树配置中引用的名称（如 `action [Chase]`、`condition [IsNight]`）；
 * 每一项都是工厂函数（createXxx），配置里的 args 会在编译期（btFactory）传入工厂。
 * 游戏如需自定义节点，可在 src/register.ts 中另行注册。
 */
import type { ActionRegistry } from "framework/ai/actionRegistry";
import { createIdleAction } from "framework/ai/nodes/actions/idle";
import { createWanderAction } from "framework/ai/nodes/actions/wander";
import { createChaseAction } from "framework/ai/nodes/actions/chase";
import { createFleeAction } from "framework/ai/nodes/actions/flee";
import { createAttackAction } from "framework/ai/nodes/actions/attack";
import { createSleepAction } from "framework/ai/nodes/actions/sleep";
import { createIsTargetInVisionCondition } from "framework/ai/nodes/conditions/isTargetInVision";
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
  registry.register("InAttackRange", createInAttackRangeCondition);
  registry.register("IsNight", createIsNightCondition);
  registry.register("IsInLight", createIsInLightCondition);
}
