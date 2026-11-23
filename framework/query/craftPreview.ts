/**
 * 合成预览（`POST /query/craft`）。
 *
 * 规则全部来自 craftingSystem 的 `previewCraft`（与 craftRecipe 同一校验顺序），
 * 本模块只做 networkId → 玩家 eid 的解析与 404 映射。
 */
import type { GameWorld } from "world";
import {
  previewCraft,
  type CraftPreview,
} from "framework/systems/gameplay/craftingSystem";
import { findPlayerEid, queryFail, queryOk, type QueryResult } from "./types";

export type { CraftPreview } from "framework/systems/gameplay/craftingSystem";

/** `/query/craft` 查询参数。 */
export interface CraftQuery {
  playerNetworkId: number;
  recipeId: string;
}

/**
 * 查询某配方对某玩家的合成可行性（只读干跑）。
 *
 * @returns 玩家/配方不存在 → 错误信封；否则结构化预览
 */
export function queryCraft(world: GameWorld, input: CraftQuery): QueryResult<CraftPreview> {
  const playerEid = findPlayerEid(world, input.playerNetworkId);
  if (playerEid === undefined) return queryFail("player_not_found");

  const preview = previewCraft(world, playerEid, input.recipeId);
  if (!preview) return queryFail("recipe_not_found");
  return queryOk(preview);
}
