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

/**
 * 把内建行为树节点工厂批量注册进 ActionRegistry。
 *
 * 注册名即行为树配置里的节点名（action/condition 共用同一个注册表，
 * 由 btFactory 按名称查找工厂并注入 args 生成节点）。可重复调用，重复注册覆盖同名项。
 * @param registry 动作注册表（registerBuiltinSystems 在 AI 系统启用前调用本函数）
 */
export function registerBuiltinActions(registry: ActionRegistry): void {
  // action：实体每 tick 执行的行为（Idle 原地待机 / Wander 随机游荡 / Chase 追击 /
  // Flee 逃离 / Attack 攻击 / Sleep 睡眠），工厂均接收可选的 args 配置
  registry.register("Idle", createIdleAction);
  registry.register("Wander", createWanderAction);
  registry.register("Chase", createChaseAction);
  registry.register("Flee", createFleeAction);
  registry.register("Attack", createAttackAction);
  registry.register("Sleep", createSleepAction);

  // condition：行为树分支条件（视野内有目标 / 进入攻击距离 / 是夜晚 / 处于光照中），
  // 返回 SUCCESS/FAILURE 驱动选择节点走向
  registry.register("IsTargetInVision", createIsTargetInVisionCondition);
  registry.register("InAttackRange", createInAttackRangeCondition);
  registry.register("IsNight", createIsNightCondition);
  registry.register("IsInLight", createIsInLightCondition);
}
