/**
 * dialogueSystem：对话原子模块（无 tick 体，命令驱动）。
 *
 * - `startDialogue`：玩家 talk 意图命中 NPC（DialogueSource）时打开对话——
 *   按 treeId 查树，写入起始节点（Dialogue 组件，客户端经 netSync 渲染 UI）
 * - `advanceDialogue`：玩家 `dialogue` 命令选选项——先执行选项效果（失败不推进，
 *   停留在当前节点可重试），再跳转目标节点或结束对话
 * - 效果类型（配置引用通用机制）：quest_accept（接受任务）/ quest_submit
 *   （提交任务，好感对象=对话 NPC kind）/ relation_delta（好感增减）/
 *   buy（向商店购买）/ sell（向商店出售——复用 economy settle 单方条款
 *   的原子现货交换；定价缺省走 item 的 value 字段，好感折扣见
 *   rules/dialogue.json 的 trade 段）
 *
 * 游戏无关——对话树/效果经 game/dialogues/*.json 配置引用。
 */
import { hasComponent, query } from "bitecs";

import { Dialogue, DialogueSource, Kind, NetworkId, Transform, Player, Health, entityMapOf, Ledger } from "components";
import { entityLevelOf } from "framework/components/entityLevel";
import { isGameplayReachable } from "framework/utils/gameplayDistance";
import type { EntityId, GameWorld } from "world";
import { acceptQuest, submitQuest } from "framework/systems/gameplay/questSystem";
import { addRelation, getRelation } from "framework/systems/gameplay/relation";
import { queryContainer, type ContainerRef } from "framework/economy/container";
import { settle, type SettleTerms, type TransferAmount } from "framework/economy/settle";
import type { DialogueTreeJson, DialogueNodeJson, DialogueEffectJson } from "framework/config/schema/DialogueSchema";
import type { DialogueRule } from "framework/config/schema/RuleSchema";
import { environmentAt } from "framework/simulation/worldClock";
import {
  decayedTradeVolume,
  recordTradeVolume,
  tradeUnitPrice,
} from "framework/systems/gameplay/pricing";
import {
  creditTradeFactionRep,
  factionOfNpcKind,
  getFactionRep,
} from "framework/systems/gameplay/factions";

/** 对话结束标记：to 为缺省或该值时结束对话。 */
export const END_DIALOGUE = "__end__";

/** 默认对话交互范围（talk 意图路由用）。 */
const DEFAULT_TALK_RANGE = 48;

/**
 * 好感调制后的成交单价（纯函数）。
 *
 * `unit = max(minPrice, 1, round(basePrice × (1 - discountPerRelation × relation)))`。
 * relation = 0 时原价；正好感打折、负好感涨价（同系数对称）。
 * 结果始终为整数且 ≥1（最低价兜底）。
 */
export function discountedUnitPrice(
  basePrice: number,
  relation: number,
  discountPerRelation = 0,
  minPrice = 1,
): number {
  const scaled = basePrice * (1 - discountPerRelation * relation);
  return Math.max(Math.max(1, minPrice), Math.round(scaled));
}

function dialogueTreeOf(world: GameWorld, treeId: string): DialogueTreeJson | undefined {
  return world.gameDef.dialoguesByKind?.get(treeId);
}

/** 对话距离的单一配置来源：rules/dialogue.json 的 talkRange（缺省 48）。 */
export function dialogueTalkRange(world: GameWorld, range?: number): number {
  const rules = world.gameDef.resolvedRules["dialogue"] as DialogueRule | undefined;
  return rules?.talkRange ?? range ?? DEFAULT_TALK_RANGE;
}

/**
 * 对话对象可达性复核（start/advance 共用）：同图 + NPC 存活 + 同层射程内。
 * 每次推进都重新求值——NPC 走远/死亡/换图后旧会话不可继续（防远距离交易/交任务）。
 */
function isDialogueNpcReachable(
  world: GameWorld,
  playerEid: EntityId,
  npcEid: EntityId,
  range?: number,
): boolean {
  if (!hasComponent(world, playerEid, Transform)) return false;
  if (!hasComponent(world, npcEid, Transform)) return false;
  if (entityMapOf(world, playerEid) !== entityMapOf(world, npcEid)) return false;
  // 存活：带 Health 且当前值 ≤ 0 视为死亡；无 Health 的对话源按存活处理
  if (hasComponent(world, npcEid, Health) && (Health.current[npcEid] ?? 0) <= 0) return false;

  const talkRange = dialogueTalkRange(world, range);
  return isGameplayReachable(
    { x: Transform.x[playerEid], y: Transform.y[playerEid], level: entityLevelOf(playerEid) },
    { x: Transform.x[npcEid], y: Transform.y[npcEid], level: entityLevelOf(npcEid) },
    talkRange,
  );
}

/**
 * 解析会话中的 NPC 实体：优先用会话创建时记录的 eid（同进程内稳定），并用
 * networkId 复核防 eid 复用错绑；旧会话/手工构造无 npcEid 时回退 networkId 查找。
 */
function resolveDialogueNpc(world: GameWorld, dlg: { npcId: number; npcEid?: number }): EntityId {
  const direct = dlg.npcEid;
  if (
    typeof direct === "number" &&
    direct >= 0 &&
    hasComponent(world, direct, NetworkId) &&
    NetworkId.value[direct] === dlg.npcId
  ) {
    return direct;
  }
  return findNpcByNetworkId(world, dlg.npcId);
}

/** 打开对话：玩家与 npcEid（须带 DialogueSource）建立会话（超范围/跨图/无树/死亡拒绝）。 */
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

  // 距离校验（talk 路由同规则源：rules/dialogue.json 的 talkRange，缺省 48）：
  // 同图 + 同层欧氏距离 + NPC 存活。
  if (!isDialogueNpcReachable(world, playerEid, npcEid, range)) return false;

  const tree = dialogueTreeOf(world, src.treeId);
  if (!tree) return false;
  const node = tree.nodes[tree.start];
  if (!node) return false;

  Dialogue[playerEid] = {
    npcId: NetworkId.value[npcEid],
    npcEid,
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
    case "buy":
    case "sell":
      return tradeAtShop(
        world,
        playerEid,
        effect.type,
        effect.kind,
        effect.count,
        effect.currency,
        effect.price,
        Kind[npcEid] ?? "",
        npcEid,
      );
    default:
      return false;
  }
}

/**
 * 商店买卖原子：玩家与商店的一次性等价交换（服务端权威，原子结算）。
 *
 * 库存/资金（F-44，服务端权威）：
 * - 商贩实体挂 `Ledger`（AoS，随实体入档）时视为**有限商店**：账本里
 *   `currency` 的余额 = 资金，其余 kind 的余额 = 库存。买单从商贩账本扣
 *   货物、把货币记入账本；卖单从商贩账本扣货币、把货物记入账本。
 *   库存/资金不足时整单拒绝（settle 先验后结 + 快照回滚，零副作用）。
 * - 商贩无 `Ledger` 数据时保持旧语义：无限货架/无限钱箱（单方条款，货币
 *   与货物都在玩家背包内对冲）。
 *
 * 原子性：复用 economy settle——双方条款对涉及容器做快照 → 校验 give 足额
 * → 扣减 → 插入 take，任一步失败整体回滚。
 *
 * 定价：基础单价 = 效果显式 price，缺省取商品 item 定义的 value 字段；两者皆无
 * → 未定价，效果失败（对话停留在当前节点）。
 *
 * 价格调制：基础价按 rules/dialogue.json 的 trade 段依次叠乘
 * 季节/天气因子 → 供需因子 → 好感因子 → 势力声望因子（见 pricing.ts 的
 * `tradeUnitPrice`），合成因子钳制后得到整数单价；未配置的因子恒为 1。
 * 成交成功后把有符号成交量写入 world.progress（买入抬价、卖出压价，按 tick
 * 衰减），并按势力配置累计交易声望。任一步失败零副作用（settle 原子回滚，
 * 不写供需账本、不加声望）。
 */
function tradeAtShop(
  world: GameWorld,
  playerEid: EntityId,
  direction: "buy" | "sell",
  kind: string,
  count: number,
  currency: string,
  price: number | undefined,
  npcKind: string,
  npcEid: EntityId,
): boolean {
  const basePrice = price ?? world.gameDef.itemsByKind?.get(kind)?.value;
  if (basePrice === undefined || !(basePrice > 0)) return false; // 未定价：拒

  const rules = world.gameDef.resolvedRules["dialogue"] as DialogueRule | undefined;
  const trade = rules?.trade;
  const relation = npcKind ? getRelation(world, playerEid, npcKind) : 0;
  const faction = factionOfNpcKind(world, npcKind);
  const factionRep = faction ? getFactionRep(world, playerEid, faction.id) : 0;
  const environment = environmentAt(world);
  const supplyDemand = trade?.supplyDemand;
  const volume = decayedTradeVolume(world, kind, supplyDemand);
  const unitPrice = tradeUnitPrice({
    basePrice,
    relation,
    factionRep,
    phaseId: environment.phaseId,
    weatherId: environment.weatherId,
    volume,
    trade,
  });
  const total = unitPrice * count;

  // 商贩 Ledger 存在 = 有限库存/资金；无 Ledger = 旧语义（无限货架/钱箱）。
  const merchantFinite = Ledger[npcEid] !== undefined;
  const merchantRef: ContainerRef = { type: "ledger", eid: npcEid };
  if (merchantFinite) {
    // 前置显式校验（settle 也会再校验；这里给出清晰的库存/资金不足拒绝）
    if (direction === "buy" && queryContainer(world, merchantRef, kind) < count) return false;
    if (direction === "sell" && queryContainer(world, merchantRef, currency) < total) return false;
  }

  const goods: TransferAmount = { container: "inventory", kind, count };
  const money: TransferAmount = { container: "inventory", kind: currency, count: total };
  const terms: SettleTerms =
    direction === "buy"
      ? merchantFinite
        ? [
            { party: playerEid, give: [money], take: [goods] }, // 玩家付货币收货
            {
              party: npcEid,
              give: [{ container: "ledger", kind, count }], // 商贩出货
              take: [{ container: "ledger", kind: currency, count: total }], // 商贩收款
            },
          ]
        : [{ party: playerEid, give: [money], take: [goods] }] // 无限货架：单方对冲
      : merchantFinite
        ? [
            { party: playerEid, give: [goods], take: [money] }, // 玩家付货收货币
            {
              party: npcEid,
              give: [{ container: "ledger", kind: currency, count: total }], // 商贩付款
              take: [{ container: "ledger", kind, count }], // 商贩收货入账
            },
          ]
        : [{ party: playerEid, give: [goods], take: [money] }]; // 无限钱箱：单方对冲
  const success = settle(world, terms);
  if (!success) return false;

  // 成交成功才记账：买入抬价（正量），卖出压价（负量）；交易累计势力声望
  recordTradeVolume(world, kind, direction === "buy" ? count : -count, supplyDemand);
  creditTradeFactionRep(world, playerEid, npcKind, count);
  return true;
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

  // 每次推进都复核 NPC 可达性（同图/存活/同层射程）：NPC 走远、消失或死亡
  // → 结束会话并拒绝推进（对话不是一次性 token，不能拿着会话远距离交易/交任务）。
  const npcEid = resolveDialogueNpc(world, dlg);
  if (npcEid < 0 || !isDialogueNpcReachable(world, playerEid, npcEid)) {
    Dialogue[playerEid] = undefined;
    return false;
  }

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
