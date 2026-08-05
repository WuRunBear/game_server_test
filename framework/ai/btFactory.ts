import { BehaviourTree, type State } from "mistreevous";

import type { ActionRegistry } from "framework/ai/actionRegistry";
import type { BtAgent, BtInstance } from "framework/ai/btRunner";

export type BtDefinitionJson =
  | { type: string; children?: unknown[]; name?: string; args?: Record<string, unknown>; [key: string]: unknown }
  | Array<{ type: string; children?: unknown[]; name?: string; args?: Record<string, unknown>; [key: string]: unknown }>;

function getActionName(obj: Record<string, unknown>): string | undefined {
  if (typeof obj.name === "string") return obj.name;
  if (typeof obj.call === "string") return obj.call;
  return undefined;
}

function getChildNodes(obj: Record<string, unknown>): unknown[] {
  const nodes: unknown[] = [];
  if (Array.isArray(obj.children)) nodes.push(...obj.children);
  if (obj.child) nodes.push(obj.child);
  return nodes;
}

/** mistreevous guard 属性（while/until）里的条件名——guard 是 `{call}` 或 `{call}[]` 形态。 */
function getGuardConditions(obj: Record<string, unknown>): unknown[] {
  const nodes: unknown[] = [];
  for (const key of ["while", "until"]) {
    const guard = obj[key];
    if (Array.isArray(guard)) nodes.push(...guard);
    else if (guard && typeof guard === "object") nodes.push(guard);
  }
  return nodes;
}

function collectByType(node: unknown, actions: Set<string>, conditions: Set<string>): void {
  if (typeof node === "string") {
    for (const match of node.matchAll(/action\s*\[([^\]]+)\]/g)) {
      if (match[1]) actions.add(match[1]);
    }
    for (const match of node.matchAll(/condition\s*\[([^\]]+)\]/g)) {
      if (match[1]) conditions.add(match[1]);
    }
    return;
  }
  if (!node || typeof node !== "object") return;
  const obj = node as Record<string, unknown>;
  const name = getActionName(obj);
  const type = obj.type;
  if (typeof name === "string") {
    if (type === "action") actions.add(name);
    else if (type === "condition") conditions.add(name);
  }
  for (const guard of getGuardConditions(obj)) {
    // guard 定义是 `{call, args?, succeedOnAbort?}` 形态（无 type 字段）——按条件名收集
    if (guard && typeof guard === "object" && typeof (guard as Record<string, unknown>).call === "string") {
      conditions.add((guard as Record<string, unknown>).call as string);
    } else {
      collectByType(guard, actions, conditions);
    }
  }
  for (const child of getChildNodes(obj)) {
    collectByType(child, actions, conditions);
  }
}

function collectActionNames(node: unknown, names: Set<string>): void {
  const actions = new Set<string>();
  const conditions = new Set<string>();
  collectByType(node, actions, conditions);

  for (const name of actions) {
    if (conditions.has(name)) {
      throw new Error(
        `Name "${name}" is used as both an action and a condition in the behavior tree`,
      );
    }
    names.add(name);
  }
  for (const name of conditions) names.add(name);
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
  const name = getActionName(obj);
  if (name === actionName && typeof obj.args === "object" && obj.args !== null) {
    return obj.args as Record<string, unknown>;
  }
  for (const child of getChildNodes(obj)) {
    const result = extractActionArgs(child, actionName);
    if (Object.keys(result).length > 0) return result;
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

  const cleanDefinition = removeArgsFromDefinition(normalizedDefinition);

  const tree = new BehaviourTree(cleanDefinition as never, agent as BtAgent);
  return { tree, agent: agent as BtAgent };
}

function removeArgsFromDefinition(node: unknown): unknown {
  if (!node || typeof node !== "object") return node;
  if (Array.isArray(node)) return node.map(removeArgsFromDefinition);
  const obj = { ...(node as Record<string, unknown>) };
  delete obj.args;
  for (const key of Object.keys(obj)) {
    if (key === "children" && Array.isArray(obj[key])) {
      obj[key] = obj[key].map(removeArgsFromDefinition);
    } else if (key === "child" && typeof obj[key] === "object") {
      obj[key] = removeArgsFromDefinition(obj[key]);
    }
  }
  return obj;
}

export function createDefaultNpcTree(): BtInstance<BtAgent> {
  return createNpcTree();
}
