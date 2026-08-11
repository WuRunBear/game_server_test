/**
 * 行为树运行时驱动：每 tick 把运行上下文注入 agent 并推进树执行。
 *
 * - BtContext 携带 world / self / bb，是 action/condition 节点访问游戏数据的唯一入口；
 * - BtAgent 是 mistreevous agent 的扩展形态：所有节点方法挂在 agent 上，
 *   且固定持有一个 ctx 字段，每次 step 前被注入最新上下文；
 * - stepBehaviourTree 设置 ctx 后调用 tree.step()，返回树根当前状态（SUCCEEDED/FAILED/RUNNING）。
 */
import type { Blackboard } from "framework/ai/blackboard";
import type { EntityId, GameWorld } from "framework/world";

import { BehaviourTree, State } from "mistreevous";

/** 行为树执行状态（透传 mistreevous 的 SUCCEEDED / FAILED / RUNNING 等）。 */
export type BtState = State;

/** 单次 tick 的运行上下文：节点通过它读取世界数据、自身 eid 与黑板。 */
export interface BtContext {
  world: GameWorld;
  self: EntityId;
  bb: Blackboard;
}

/**
 * mistreevous agent：以节点名为 key，值为对应的节点方法；
 * ctx 为当前运行上下文，由 stepBehaviourTree 在每次 step 前注入。
 */
export interface BtAgent {
  [key: string]: unknown;
  ctx: BtContext | null;
}

/** 一棵已编译的行为树与其绑定的 agent（createNpcTree 的产物）。 */
export interface BtInstance<TAgent extends BtAgent = BtAgent> {
  tree: BehaviourTree;
  agent: TAgent;
}

/** 推进一棵行为树执行一 tick：注入上下文 → 从根 step → 返回树根状态。 */
export function stepBehaviourTree<TAgent extends BtAgent>(
  instance: BtInstance<TAgent>,
  ctx: BtContext,
): BtState {
  instance.agent.ctx = ctx;
  instance.tree.step();
  return instance.tree.getState();
}
