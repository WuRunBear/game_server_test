/**
 * DialogueSource 组件：可对话 NPC 的对话树引用（AoS 结构，挂 NPC 实体）。
 *
 * 声明该实体提供哪棵对话树（treeId 引用 game/dialogues/*.json 的树 id）；
 * 玩家 talk 意图命中时，dialogueSystem 按 treeId 查树并打开对话。
 * 由 spawn 的 AoS 初始化钩子按 archetype 配置写入。
 */
export interface DialogueSourceState {
  /** 对话树 id（game/dialogues/*.json 的树定义引用）。 */
  treeId: string;
}

/** AoS 存储：普通 JS 数组按 eid 索引（非 bitecs 组件，不能 addComponent/query）。 */
export const DialogueSource = [] as (DialogueSourceState | undefined)[];

interface DialogueSourceConfig {
  treeId?: string;
}

/** AoS 初始化钩子。 */
export function initDialogueSource(
  _world: unknown,
  eid: number,
  config: unknown,
): void {
  const cfg = (config ?? {}) as DialogueSourceConfig;
  DialogueSource[eid] = {
    treeId: String(cfg.treeId ?? ""),
  };
}
