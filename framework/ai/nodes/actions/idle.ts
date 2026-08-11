/**
 * action：待机——不做任何事，立即返回 SUCCEEDED。
 * 常作为行为树序列的兜底 / 占位节点，保证分支有确定返回、树可继续求值。
 */
import { State } from "mistreevous";

/** 待机节点工厂：返回恒为 SUCCEEDED 的 agent 方法（不读取 ctx 与黑板）。 */
export function createIdleAction(_args?: Record<string, unknown>): () => State {
  return () => State.SUCCEEDED;
}
