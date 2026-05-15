import { BehaviourTree, type State } from "mistreevous";

import type { BtAgent, BtInstance } from "ai/btRunner";
import { createIdleAction } from "ai/nodes/actions/idle";

export type BtDefinitionJson =
  | { type: string; [key: string]: unknown }
  | Array<{ type: string; [key: string]: unknown }>;

export interface NpcBtAgent extends BtAgent {
  Idle: () => State;
}

function parseJsonIfLooksLikeJson(text: string): unknown | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  const first = trimmed[0];
  if (first !== "{" && first !== "[") return null;

  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    return null;
  }
}

export function createNpcTree(
  definition: string | BtDefinitionJson = `root { action [Idle] }`,
): BtInstance<NpcBtAgent> {
  const agent: NpcBtAgent = {
    ctx: null,
    Idle: createIdleAction(),
  };

  const normalizedDefinition =
    typeof definition === "string"
      ? (parseJsonIfLooksLikeJson(definition) ?? definition)
      : definition;

  const tree = new BehaviourTree(normalizedDefinition as never, agent);
  return { tree, agent };
}

export function createDefaultNpcTree(): BtInstance<NpcBtAgent> {
  return createNpcTree();
}
