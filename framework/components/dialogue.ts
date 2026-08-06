/**
 * Dialogue 组件：玩家当前对话会话状态（AoS 结构，挂玩家实体，瞬态）。
 *
 * 由 dialogueSystem 写入/推进：玩家 talk 意图命中 NPC 时写入当前会话
 * （npcId=对话对象 networkId、treeId=对话树引用、nodeId=节点引用、
 * options=选项文本），客户端经 netSync 看到即可渲染对话 UI；`dialogue`
 * 命令推进节点或结束（Dialogue[eid] 置 undefined）。
 *
 * 瞬态组件：不入存档（恢复后由玩家重新交互自然重建）。
 */
export interface DialogueState {
  /** 对话对象实体的 networkId（稳定标识，客户端凭此知道和谁对话）。 */
  npcId: number;
  /** 对话树 id（game/dialogues/*.json 的树引用，节点定位不依赖 NPC 存活）。 */
  treeId: string;
  /** 当前对话节点 id（引用该树的 nodes 表）。 */
  nodeId: string;
  /** 当前节点选项文本（客户端渲染选项按钮用；索引即选项序号）。 */
  options: string[];
}

export const Dialogue = [] as (DialogueState | undefined)[];
