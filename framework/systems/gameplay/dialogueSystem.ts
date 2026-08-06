/**
 * dialogueSystem：对话原子模块（无 tick 体，命令驱动）。
 *
 * - `startDialogue`：玩家 talk 意图命中 NPC（DialogueSource）时打开对话——
 *   按 treeId 查树，写入起始节点（Dialogue 组件，客户端经 netSync 渲染 UI）
 * - `advanceDialogue`：玩家 `dialogue` 命令选选项——先执行选项效果（失败不推进，
 *   停留在当前节点可重试），再跳转目标节点或结束对话
 * - 效果类型（配置引用通用机制）：quest_accept（接受任务）/ quest_submit
 *   （提交任务，好感对象=对话 NPC kind）/ relation_delta（好感增减）
 *
 * 游戏无关——对话树/效果经 game/dialogues/*.json 配置引用。
 */
import { hasComponent, query } from "bitecs";

import { Dialogue, DialogueSource, Kind, NetworkId, Transform, Player, Health } from "components";
import type { EntityId, GameWorld } from "world";
import { acceptQuest, submitQuest } from "framework/systems/gameplay/questSystem";
import { addRelation } from "framework/systems/gameplay/relation";
import type { DialogueTreeJson, DialogueNodeJson, DialogueEffectJson } from "framework/config/schema/DialogueSchema";

/** 对话结束标记：to 为缺省或该值时结束对话。 */
export const END_DIALOGUE = "__end__";

/** 默认对话交互范围（talk 意图路由用）。 */
const DEFAULT_TALK_RANGE = 48;

interface DialogueRules {
  talkRange?: number;
}

function dialogueTreeOf(world: GameWorld, treeId: string): DialogueTreeJson | undefined {
  return world.gameDef.dialoguesByKind?.get(treeId);
}

/** 打开对话：玩家与 npcEid（须带 DialogueSource）建立会话（超范围/无树/死亡拒绝）。 */
export function startDialogue(
  world: GameWorld,
  playerEid: EntityId,
  npcEid: EntityId,
  range?: number,
): boolean {
  if (!hasComponent(world, playerEid, Player)) return false;
  if ((Health.current[playerEid] ?? 0) <= 0) return false;
  if (!hasComponent(world, playerEid, Transform)) return false;

  const src = DialogueSource[npcEid];
  if (!src || !src.treeId) return false;

  // 距离校验（talk 路由同规则源；缺省 48）
  const rules = world.gameDef.resolvedRules["dialogue"] as DialogueRules | undefined;
  const talkRange = rules?.talkRange ?? range ?? DEFAULT_TALK_RANGE;
  const dist = Math.hypot(
    Transform.x[playerEid] - Transform.x[npcEid],
    Transform.y[playerEid] - Transform.y[npcEid],
  );
  if (dist > talkRange) return false;

  const tree = dialogueTreeOf(world, src.treeId);
  if (!tree) return false;
  const node = tree.nodes[tree.start];
  if (!node) return false;

  Dialogue[playerEid] = {
    npcId: NetworkId.value[npcEid],
    treeId: tree.id,
    nodeId: tree.start,
    options: node.options.map((o) => o.label),
  };
  return true;
}

/** 执行对话选项效果（失败零副作用，返回是否成功）。 */
export function applyDialogueEffect(
  world: GameWorld,
  playerEid: EntityId,
  npcEid: EntityId,
  effect: DialogueEffectJson,
): boolean {
  switch (effect.type) {
    case "quest_accept":
      return acceptQuest(world, playerEid, effect.questId);
    case "quest_submit":
      // 好感对象 = 提交对话的 NPC kind
      return submitQuest(world, playerEid, effect.questId, Kind[npcEid] ?? undefined);
    case "relation_delta":
      addRelation(world, playerEid, effect.npcKind, effect.delta);
      return true;
    default:
      return false;
  }
}

/**
 * 推进对话：玩家选择当前节点第 optionIndex 个选项。
 *
 * 流程：取当前节点与选项 → **先解析跳转目标**（无效 to 直接停留，效果不执行、
 * 会话不关闭——防"效果已生效却对话被关"的不一致）→ 执行选项效果（失败停留）
 * → 跳转目标节点（缺省/__end__ = 结束对话）并刷新选项文本。
 *
 * @returns 是否推进成功
 */
export function advanceDialogue(world: GameWorld, playerEid: EntityId, optionIndex: number): boolean {
  const dlg = Dialogue[playerEid];
  if (!dlg) return false;

  const tree = dialogueTreeOf(world, dlg.treeId);
  if (!tree) return false;
  const node = tree.nodes[dlg.nodeId];
  const option = node?.options[optionIndex];
  if (!node || !option) return false;

  // 先解析跳转目标：无效 to 停留（配置笔误防御，validateIntegrity 已前置校验）
  const to = option.to;
  let ends = false;
  let nextNode: DialogueNodeJson | undefined;
  if (!to || to === END_DIALOGUE) {
    ends = true;
  } else {
    nextNode = tree.nodes[to];
    if (!nextNode) return false;
  }

  // 效果失败不推进（停留在当前节点，可重试）
  if (option.effect) {
    const npcEid = findNpcByNetworkId(world, dlg.npcId);
    if (npcEid < 0) return false;
    if (!applyDialogueEffect(world, playerEid, npcEid, option.effect)) return false;
  }

  if (ends) {
    Dialogue[playerEid] = undefined;
    return true;
  }

  dlg.nodeId = to!;
  dlg.options = nextNode!.options.map((o) => o.label);
  return true;
}

/** 按 networkId 找 NPC 实体（advance 时对话对象校验用）。 */
function findNpcByNetworkId(world: GameWorld, npcId: number): EntityId {
  for (const eid of query(world, [NetworkId])) {
    if (NetworkId.value[eid] === npcId) return eid;
  }
  return -1;
}
