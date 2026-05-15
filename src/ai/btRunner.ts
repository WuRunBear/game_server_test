import type { Blackboard } from "ai/blackboard";
import type { EntityId, GameWorld } from "src/world";

import { BehaviourTree, State } from "mistreevous";

export type BtState = State;

export interface BtContext {
  world: GameWorld;
  self: EntityId;
  bb: Blackboard;
}

export interface BtAgent {
  [key: string]: unknown;
  ctx: BtContext | null;
}

export interface BtInstance<TAgent extends BtAgent = BtAgent> {
  tree: BehaviourTree;
  agent: TAgent;
}

export function stepBehaviourTree<TAgent extends BtAgent>(
  instance: BtInstance<TAgent>,
  ctx: BtContext,
): BtState {
  instance.agent.ctx = ctx;
  instance.tree.step();
  return instance.tree.getState();
}
