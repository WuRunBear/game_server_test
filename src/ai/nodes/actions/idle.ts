import { State } from "mistreevous";

/**
 * 创建一个 Idle 行为节点（始终立即成功）。
 *
 * @returns 返回一个可被行为树调用的 action 函数
 */
export function createIdleAction(): () => State {
  return () => State.SUCCEEDED;
}
