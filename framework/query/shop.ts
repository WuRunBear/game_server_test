/**
 * 商店查询（`GET /query/shop`）。
 *
 * 商品清单来自 NPC 对话树里的 `buy` 效果（商贩卖什么由对话配置声明）；
 * 单价走 `dialogueSystem.shopUnitPrice`——与真实购买**同一个**定价函数
 * （关系/势力/相位/天气/供需），不读对话 label 里的写死价格。
 * 库存/资金读商贩 `Ledger`（无 Ledger = 无限货架，count=-1）。
 */
import { Ledger, DialogueSource } from "components";
import type { DialogueEffectJson } from "framework/config/schema/DialogueSchema";
import { shopUnitPrice } from "framework/systems/gameplay/dialogueSystem";
import type { GameWorld } from "world";
import {
  findEidByNetworkId,
  findPlayerEid,
  queryFail,
  queryOk,
  type QueryResult,
} from "./types";

/** 商店条目：count = 当前库存（-1 表示无限）；price = 单价。 */
export interface ShopItem {
  kind: string;
  count: number;
  /** 实价单价；未定价（无显式价且 item 无 value）时为 null。 */
  price: number | null;
  currency: string;
  /** 无 Ledger 的无限货架。 */
  unlimited: boolean;
  /** 对话效果声明的单次购买数量（客户端可据此展示“×N”）。 */
  packCount: number;
  /** 单次购买总价（price × packCount；未定价时为 null）。 */
  packPrice: number | null;
}

/** `/query/shop` 响应体。 */
export interface ShopResponse {
  currency: string;
  items: ShopItem[];
}

/** `/query/shop` 查询参数。 */
export interface ShopQuery {
  npcNetworkId: number;
  playerNetworkId: number;
}

/** 从对话树收集 buy 效果（按树声明顺序，按 kind+currency 去重）。 */
function buyEffectsOf(world: GameWorld, npcEid: number): DialogueEffectJson[] {
  const source = DialogueSource[npcEid];
  if (!source?.treeId) return [];
  const tree = world.gameDef.dialoguesByKind?.get(source.treeId);
  if (!tree) return [];

  const out: DialogueEffectJson[] = [];
  const seen = new Set<string>();
  for (const node of Object.values(tree.nodes)) {
    for (const option of node.options) {
      const effect = option.effect;
      if (effect?.type !== "buy") continue;
      const key = `${effect.currency}\u0000${effect.kind}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(effect);
    }
  }
  return out;
}

/**
 * 查询商店货架/库存/实价。
 *
 * @returns 玩家或 NPC 不存在 → 错误信封；NPC 无商店对话 → `items: []`
 */
export function queryShop(world: GameWorld, input: ShopQuery): QueryResult<ShopResponse> {
  const playerEid = findPlayerEid(world, input.playerNetworkId);
  if (playerEid === undefined) return queryFail("player_not_found");

  const npcEid = findEidByNetworkId(world, input.npcNetworkId);
  if (npcEid === undefined) return queryFail("npc_not_found");

  const effects = buyEffectsOf(world, npcEid);
  if (effects.length === 0) return queryOk({ currency: "", items: [] });

  const ledger = Ledger[npcEid];
  const items: ShopItem[] = [];
  for (const effect of effects) {
    if (effect.type !== "buy") continue;
    const unitPrice = shopUnitPrice(world, playerEid, npcEid, effect.kind, effect.price);
    const stock = ledger ? (ledger[effect.kind] ?? 0) : -1;
    items.push({
      kind: effect.kind,
      count: stock,
      price: unitPrice ?? null,
      currency: effect.currency,
      unlimited: ledger === undefined,
      packCount: effect.count,
      packPrice: unitPrice === undefined ? null : unitPrice * effect.count,
    });
  }

  // 顶层 currency 取第一条买单项（多币种商店由每条 item.currency 自描述）。
  return queryOk({ currency: effects[0]?.type === "buy" ? effects[0].currency : "", items });
}
