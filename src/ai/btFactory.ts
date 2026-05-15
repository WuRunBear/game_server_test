import { BehaviourTree, type State } from "mistreevous";

import type { BtAgent, BtInstance } from "ai/btRunner";
import { createIdleAction } from "ai/nodes/actions/idle";

export type BtDefinitionJson =
  | { type: string; [key: string]: unknown }
  | Array<{ type: string; [key: string]: unknown }>;

export interface NpcBtAgent extends BtAgent {
  Idle: () => State;
}

/**
 * 尝试把字符串解析为 JSON。
 *
 * 仅当文本看起来像 JSON（以 `{` 或 `[` 开头）时才会进行解析；解析失败返回 null。
 *
 * @param text 待解析的文本
 * @returns 解析后的值；不满足条件或解析失败时返回 null
 */
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

/**
 * 根据行为树定义创建 NPC 的行为树实例。
 *
 * @param definition 行为树定义（mistreevous 支持的文本/JSON 结构）；未传则使用默认 Idle 行为
 * @returns 行为树实例（包含 tree 与 agent）
 */
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

/**
 * 创建默认的 NPC 行为树（等价于 createNpcTree()）。
 *
 * @returns 默认行为树实例
 */
export function createDefaultNpcTree(): BtInstance<NpcBtAgent> {
  return createNpcTree();
}
