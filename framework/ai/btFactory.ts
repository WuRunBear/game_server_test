/**
 * 行为树工厂：把配置化的行为树定义编译成 mistreevous 可执行的 BehaviourTree。
 *
 * 编译流程（createNpcTree）：
 * 1. 定义来源可为 mistreevous DSL 字符串、JSON 文本或 JSON 对象；
 * 2. 递归扫描整棵树（含 while/until guard 条件与字符串 DSL），收集所有 action/condition 名称；
 * 3. 按名从 ActionRegistry 取工厂、解析节点上的 args，生成 agent 方法集
 *    （agent[name] = factory(args)）——编译期即校验"引用的节点是否已注册"；
 * 4. 剥离定义中所有 args 字段（mistreevous 不解析该字段，参数只由工厂消费）；
 * 5. new BehaviourTree(定义, agent) 生成可逐 tick step 的树实例。
 *
 * 由此，行为树"用什么节点、配什么参数"全部由配置决定，框架侧零硬编码。
 */
import { BehaviourTree, type State } from "mistreevous";

import type { ActionRegistry } from "framework/ai/actionRegistry";
import type { BtAgent, BtInstance } from "framework/ai/btRunner";

/** 行为树配置定义：单个节点对象或节点数组；args 为节点级参数（仅工厂消费）。 */
export type BtDefinitionJson =
  | { type: string; children?: unknown[]; name?: string; args?: Record<string, unknown>; [key: string]: unknown }
  | Array<{ type: string; children?: unknown[]; name?: string; args?: Record<string, unknown>; [key: string]: unknown }>;

/** 从节点对象取动作名：优先 name 字段，回退 call 字段（guard/条件调用的形态）。 */
function getActionName(obj: Record<string, unknown>): string | undefined {
  if (typeof obj.name === "string") return obj.name;
  if (typeof obj.call === "string") return obj.call;
  return undefined;
}

/** 取节点的子节点：children 数组合并 child 单项，两种形态都兼容。 */
function getChildNodes(obj: Record<string, unknown>): unknown[] {
  const nodes: unknown[] = [];
  if (Array.isArray(obj.children)) nodes.push(...obj.children);
  if (obj.child) nodes.push(obj.child);
  return nodes;
}

/** mistreevous guard 属性（while/until）里的条件名——guard 是单个 `{call}` 对象形态。 */
function getGuardConditions(obj: Record<string, unknown>): unknown[] {
  const nodes: unknown[] = [];
  for (const key of ["while", "until"]) {
    const guard = obj[key];
    if (guard && typeof guard === "object") nodes.push(guard);
  }
  return nodes;
}

/** 递归收集节点引用到的 action / condition 名称（字符串 DSL 用正则，对象按 type/name 字段）。 */
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

/** 收集整棵树引用到的所有节点名；同一名字既当 action 又当 condition 视为配置错误。 */
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

/** 字符串定义若以 `{` 或 `[` 开头则按 JSON 解析；解析失败或非 JSON 开头时原样返回（视为 mistreevous DSL）。 */
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

/** 在定义树中查找指定动作名对应的 args 配置（递归含嵌套子节点），找不到返回空对象。 */
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

/** 设置默认节点注册表（供未显式传 registry 的 createNpcTree / createDefaultNpcTree 使用）。 */
export function setDefaultActionRegistry(registry: ActionRegistry): void {
  defaultActionRegistry = registry;
}

/**
 * 编译一棵行为树：定义 + 注册表 → 可执行实例。
 *
 * 要点：
 * - 先扫描定义收集节点名，逐一从注册表取工厂并注入配置 args，生成 agent 方法；
 *   未注册的节点名在此阶段直接抛错（配置错误尽早暴露）；
 * - agent 初始仅含 { ctx: null }，ctx 由 btRunner 每 tick 注入运行上下文；
 * - 剥离 args 后的定义才交给 mistreevous 编译（其不识别 args 字段）。
 */
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

  // agent 是 mistreevous 的执行对象：key 为节点名，value 为节点方法；ctx 先占位，step 时注入
  const agent: Record<string, unknown> = { ctx: null };

  for (const name of actionNames) {
    if (!registry.has(name)) {
      throw new Error(`Action "${name}" referenced in behavior tree is not registered`);
    }
    // 每个节点名 = 一个 agent 方法：factory(配置 args) 生成，参数在编译期固化
    const factory = registry.get(name);
    const args = extractActionArgs(normalizedDefinition, name);
    agent[name] = factory(args);
  }

  // mistreevous 不识别 args 字段，编译前统一剥离（工厂已消费过参数）
  const cleanDefinition = removeArgsFromDefinition(normalizedDefinition);

  const tree = new BehaviourTree(cleanDefinition as never, agent as BtAgent);
  return { tree, agent: agent as BtAgent };
}

/** 递归剥离定义中的 args 字段：mistreevous 不解析它，参数只由工厂消费。 */
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

/** 用默认注册表与默认定义（root { action [Wander] }）创建一棵行为树实例。 */
export function createDefaultNpcTree(): BtInstance<BtAgent> {
  return createNpcTree();
}
