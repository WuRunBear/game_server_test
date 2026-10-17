/**
 * 势力声望原子（无 tick 体）——游戏无关。
 *
 * 数据形态：复用 Relation（玩家 AoS 持久组件）的 `{ npcKind, value }` 条目，
 * 势力条目的 `npcKind` 为 `faction:<势力 id>`。因此声望天然随玩家实体入档、
 * 入快照（Relation 已注册 netSync 适配器），无需新组件/新同步字段。
 *
 * 来源（配置化）：
 * - 任务提交：questSystem 在写 NPC 好感后按 NPC kind 反查势力，把同一
 *   `relationDelta` 计入势力声望（`creditFactionForNpcKind`）；
 * - 交易：dialogueSystem 每成交一件商品按势力定义的 `repPerTradeUnit` 计声望
 *   （`creditTradeFactionRep`）；
 * - 击杀敌对势力成员等更高层来源可复用同一 `addFactionRep` 原子。
 *
 * 势力 id / 成员 NPC kind / 数值全部来自 game/rules/factions.json。
 */
import { Relation } from "components";
import type { EntityId, GameWorld } from "world";
import type { FactionDefinition, FactionRule } from "framework/config/schema/RuleSchema";
import { setRelation } from "framework/systems/gameplay/relation";

/** 势力声望在 Relation 条目中的键前缀（避免与 NPC kind 好感键冲突）。 */
export const FACTION_RELATION_PREFIX = "faction:";

/** 势力 id → Relation 键。 */
export function factionRelationKey(factionId: string): string {
  return `${FACTION_RELATION_PREFIX}${factionId}`;
}

/** 取 factions 规则（未配置返回 undefined）。 */
export function getFactionRule(world: GameWorld): FactionRule | undefined {
  return world.gameDef?.resolvedRules?.["factions"] as FactionRule | undefined;
}

/** 按 id 取势力定义（未配置/未知名返回 undefined）。 */
export function getFactionDefinition(world: GameWorld, factionId: string): FactionDefinition | undefined {
  return getFactionRule(world)?.factions.find((faction) => faction.id === factionId);
}

/** 按 NPC kind 反查所属势力（多个势力声明同一成员时取配置中第一个）。 */
export function factionOfNpcKind(world: GameWorld, npcKind: string): FactionDefinition | undefined {
  if (!npcKind) return undefined;
  return getFactionRule(world)?.factions.find((faction) => faction.members?.includes(npcKind));
}

/**
 * 读取玩家对某势力的声望。
 *
 * 未写入过条目时返回势力配置的 `initialRep`（缺省 0）——初始值不需要在
 * 玩家生成时预写，随首次变化自然落到 Relation 条目。
 */
export function getFactionRep(world: GameWorld, playerEid: EntityId, factionId: string): number {
  const key = factionRelationKey(factionId);
  const relations = Relation[playerEid];
  const existing = relations?.find((entry) => entry.npcKind === key);
  if (existing) return existing.value;
  return getFactionDefinition(world, factionId)?.initialRep ?? 0;
}

/** 玩家势力声望增减（不存在条目时以 initialRep 为基准）。 */
export function addFactionRep(
  world: GameWorld,
  playerEid: EntityId,
  factionId: string,
  delta: number,
): void {
  if (!factionId || !delta) return;
  const current = getFactionRep(world, playerEid, factionId);
  setRelation(world, playerEid, factionRelationKey(factionId), current + delta);
}

/**
 * 任务/对话好感来源映射到势力：按 NPC kind 找势力，把同一 delta 计入声望。
 * 未归属任何势力的 NPC 不产生势力声望。
 */
export function creditFactionForNpcKind(
  world: GameWorld,
  playerEid: EntityId,
  npcKind: string | undefined,
  delta: number,
): void {
  if (!npcKind || !delta) return;
  const faction = factionOfNpcKind(world, npcKind);
  if (!faction) return;
  addFactionRep(world, playerEid, faction.id, delta);
}

/**
 * 交易来源：按成交件数与势力配置的 `repPerTradeUnit` 计入声望。
 * 买卖双向都按正件数计（声望是"与该势力打交道"的累计，不区分方向）。
 */
export function creditTradeFactionRep(
  world: GameWorld,
  playerEid: EntityId,
  npcKind: string | undefined,
  tradedUnits: number,
): void {
  if (!npcKind || !(tradedUnits > 0)) return;
  const faction = factionOfNpcKind(world, npcKind);
  const perUnit = faction?.repPerTradeUnit ?? 0;
  if (!faction || !perUnit) return;
  addFactionRep(world, playerEid, faction.id, perUnit * tradedUnits);
}
