import { BehaviourTree, type State } from "mistreevous";

import type { ActionRegistry } from "framework/ai/actionRegistry";
import type { BtAgent, BtInstance } from "framework/ai/btRunner";

export type BtDefinitionJson =
  | { type: string; children?: unknown[]; name?: string; args?: Record<string, unknown>; [key: string]: unknown }
  | Array<{ type: string; children?: unknown[]; name?: string; args?: Record<string, unknown>; [key: string]: unknown }>;

function collectActionNames(node: unknown, names: Set<string>): void {
  if (typeof node === "string") {
    for (const match of node.matchAll(/action\s*\[([^\]]+)\]/g)) {
      if (match[1]) names.add(match[1]);
    }
    return;
  }
  if (!node || typeof node !== "object") return;
  const obj = node as Record<string, unknown>;
  if (typeof obj.name === "string" && obj.type === "action") {
    names.add(obj.name);
  }
  if (Array.isArray(obj.children)) {
    for (const child of obj.children) {
      collectActionNames(child, names);
    }
  }
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

function extractActionArgs(node: unknown, actionName: string): Record<string, unknown> {
  if (!node || typeof node !== "object") return {};
  const obj = node as Record<string, unknown>;
  if (typeof obj.name === "string" && obj.name === actionName && typeof obj.args === "object" && obj.args !== null) {
    return obj.args as Record<string, unknown>;
  }
  if (Array.isArray(obj.children)) {
    for (const child of obj.children) {
      const result = extractActionArgs(child, actionName);
      if (Object.keys(result).length > 0) return result;
    }
  }
  return {};
}

let defaultActionRegistry: ActionRegistry | undefined;

export function setDefaultActionRegistry(registry: ActionRegistry): void {
  defaultActionRegistry = registry;
}

export function createNpcTree(
  definition: string | BtDefinitionJson = `root { action [Wander] }`,
  actionRegistry?: ActionRegistry,
): BtInstance<BtAgent> {
  const registry = actionRegistry ?? defaultActionRegistry;
  if (!registry) {
    throw new Error("No ActionRegistry provided for createNpcTree");
  }

  const normalizedDefinition =
    typeof definition === "string"
      ? (parseJsonIfLooksLikeJson(definition) ?? definition)
      : definition;

  const actionNames = new Set<string>();
  collectActionNames(normalizedDefinition, actionNames);

  const agent: Record<string, unknown> = { ctx: null };

  for (const name of actionNames) {
    if (!registry.has(name)) {
      throw new Error(`Action "${name}" referenced in behavior tree is not registered`);
    }
    const factory = registry.get(name);
    const args = extractActionArgs(normalizedDefinition, name);
    agent[name] = factory(args);
  }

  const tree = new BehaviourTree(normalizedDefinition as never, agent as BtAgent);
  return { tree, agent: agent as BtAgent };
}

export function createDefaultNpcTree(): BtInstance<BtAgent> {
  return createNpcTree();
}
