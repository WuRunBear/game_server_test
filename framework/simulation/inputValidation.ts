/**
 * 输入校验（anti-cheat）——移动速度上限 + 命令频率上限。
 *
 * 与 seq 去重同级的入口拦截：由 GameSimulation 在 submitInput / submitCommand
 * 时调用，不进入 ECS tick 系统（输入必须先于系统校验，且日志属副作用）。
 *
 * 规则来源 `game/rules/server.json`（ServerRuleSchema）：
 * - `maxMoveSpeed`：移动合成速度上限（像素/秒）。超限输入被拒且不推进 seq
 *   （客户端无法靠重发绕过），并输出告警日志。
 * - `maxCommandsPerSec`：命令频率上限（条/秒）。按逻辑 tick 滑动窗口计数
 *   （窗口 = 1 秒对应的 tick 数，与真实时钟解耦，测试确定性好）。
 *
 * 未配置对应规则时对应校验关闭（向后兼容，不影响历史测试/客户端）。
 */
import type { ServerRule } from "framework/config/schema/RuleSchema";
import type { PlayerInput } from "./types";

export interface InputGuardOptions {
  /** tickRate（用于把「每秒」换算成逻辑 tick 窗口）。 */
  tickRate: number;
  /** 移动合成速度上限（像素/秒）；缺省不限速。 */
  maxMoveSpeed?: number;
  /** 命令频率上限（条/秒）；缺省不限频。 */
  maxCommandsPerSec?: number;
}

export interface InputGuard {
  /** 移动输入是否放行。 */
  validateMove(input: PlayerInput): boolean;
  /**
   * 命令是否放行；放行时记录本次 tick。当前 tick 取自 world.time.tick。
   * 返回 false 表示超频被拒（命令未执行）。
   */
  submitCommandAllowed(sessionId: string, currentTick: number): boolean;
  /** 释放会话的限流计数（removePlayer 时调用）。 */
  removeSession(sessionId: string): void;
}

/**
 * 构建输入校验器：闭包持有窗口大小与每个会话的命令 tick 历史。
 * commandTicks 以逻辑 tick 号为时间戳计数（与真实时钟解耦，测试确定性好）。
 */
function buildGuard(options: InputGuardOptions): InputGuard {
  const { maxMoveSpeed, maxCommandsPerSec, tickRate } = options;
  // 限频窗口 = 1 秒对应的逻辑 tick 数
  const windowSize = Math.max(1, Math.floor(tickRate));
  // sessionId → 该会话最近被放行的命令 tick 号列表
  const commandTicks = new Map<string, number[]>();

  return {
    validateMove(input) {
      if (maxMoveSpeed === undefined) return true;
      return Math.hypot(input.moveX, input.moveY) <= maxMoveSpeed;
    },

    submitCommandAllowed(sessionId, currentTick) {
      if (maxCommandsPerSec === undefined) return true;
      // 窗口 = windowSize 个 tick 位置（含当前 tick 在内共 windowSize 个）：
      // cutoff 为窗口最早允许的 tick，+1 修正 off-by-one（20tps 下恰好 1 秒）
      const cutoff = currentTick - windowSize + 1;
      const recent = (commandTicks.get(sessionId) ?? []).filter((t) => t >= cutoff);
      if (recent.length >= maxCommandsPerSec) {
        commandTicks.set(sessionId, recent);
        return false;
      }
      recent.push(currentTick);
      commandTicks.set(sessionId, recent);
      return true;
    },

    removeSession(sessionId) {
      commandTicks.delete(sessionId);
    },
  };
}

/** 从 server 规则构造输入校验器；规则缺省时全放行。 */
export function createInputGuard(
  rules: ServerRule | undefined,
  tickRate: number,
): InputGuard {
  return buildGuard({
    tickRate,
    maxMoveSpeed: rules?.maxMoveSpeed,
    maxCommandsPerSec: rules?.maxCommandsPerSec,
  });
}
