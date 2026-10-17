/**
 * 交易价格调制（游戏无关纯函数 + 世界账本读写）。
 *
 * 定价链（顺序固定）：
 *   基础价 → 季节/天气乘子 → 供需乘子 → 好感乘子 → 势力声望乘子
 *   → 合成因子钳制 [minFactor, maxFactor] → 单价 max(minPrice, round(...))
 *
 * 供需账本：`world.progress` 中的
 *   - `<prefix>:<kind>`         有符号成交量（买入 +，卖出 -）
 *   - `<prefix>:<kind>:lastTick` 最近一次成交 tick
 * 读取时按 tick 差线性衰减（decayPerTick × 相隔 tick），交易停止后价格自然
 * 回落；衰减不写回世界，只在下一次成交/读价时按当前 tick 现算，避免每 tick
 * 写账本，也保证离线补差不重放。
 *
 * 相位/天气 id、势力 id、价格因子全部来自 game/rules/*.json 配置。
 */
import type { GameWorld } from "framework/world";
import type {
  DialogueSupplyDemandRule,
  DialogueTradeRule,
} from "framework/config/schema/RuleSchema";

/** 默认供需账本键前缀（配置可覆盖）。 */
export const DEFAULT_TRADE_VOLUME_PREFIX = "trade";

/** 供需账本键：需求量（有符号成交量）。 */
export function tradeVolumeKey(prefix: string, kind: string): string {
  return `${prefix}:${kind}`;
}

/** 供需账本键：最近一次成交 tick。 */
export function tradeVolumeTickKey(prefix: string, kind: string): string {
  return `${prefix}:${kind}:lastTick`;
}

/** 解析供需配置的键前缀（缺省 "trade"）。 */
export function tradeVolumePrefix(config: DialogueSupplyDemandRule | undefined): string {
  return config?.volumeKeyPrefix ?? DEFAULT_TRADE_VOLUME_PREFIX;
}

/**
 * 读取当前衰减后的有符号成交量（纯读，不写回）。
 *
 * 买入累积正量抬价，卖出累积负量压价；`decayPerTick` 每 tick 向 0 收敛。
 */
export function decayedTradeVolume(
  world: GameWorld,
  kind: string,
  config: DialogueSupplyDemandRule | undefined,
): number {
  if (!config) return 0;
  const prefix = tradeVolumePrefix(config);
  const raw = world.progress[tradeVolumeKey(prefix, kind)] ?? 0;
  if (!Number.isFinite(raw) || raw === 0) return 0;

  const decayPerTick = config.decayPerTick ?? 0;
  if (decayPerTick <= 0) return raw;

  const lastTick = world.progress[tradeVolumeTickKey(prefix, kind)];
  if (lastTick === undefined || !Number.isFinite(lastTick)) return raw;

  const elapsed = Math.max(0, world.time.tick - lastTick);
  const decay = decayPerTick * elapsed;
  return raw > 0 ? Math.max(0, raw - decay) : Math.min(0, raw + decay);
}

/**
 * 成交后写入供需账本：先把旧量按当前 tick 衰减，再叠加本次有符号量。
 *
 * @param signedUnits 买入为正、卖出为负（单位=商品件数）
 */
export function recordTradeVolume(
  world: GameWorld,
  kind: string,
  signedUnits: number,
  config: DialogueSupplyDemandRule | undefined,
): void {
  if (!config || !kind || !signedUnits) return;
  const prefix = tradeVolumePrefix(config);
  const next = decayedTradeVolume(world, kind, config) + signedUnits;
  world.progress[tradeVolumeKey(prefix, kind)] = next;
  world.progress[tradeVolumeTickKey(prefix, kind)] = world.time.tick;
}

/** 交易定价的完整输入（纯函数参数）。 */
export interface TradePriceInput {
  /** 基础单价（显式 price ?? item.value）。 */
  basePrice: number;
  /** 玩家对当前对话 NPC kind 的好感。 */
  relation: number;
  /** 玩家对商贩所属势力的声望。 */
  factionRep: number;
  /** 当前相位 id（environmentAt(world).phaseId）。 */
  phaseId: string;
  /** 当前天气 id（environmentAt(world).weatherId）。 */
  weatherId: string;
  /** 当前衰减后的有符号成交量（买入正/卖出负）。 */
  volume: number;
  /** 交易规则（缺省 = 只按原价）。 */
  trade?: DialogueTradeRule;
}

/**
 * 完整定价纯函数（见文件头公式）。
 *
 * - 未配置的相位/天气乘子按 1；未配置 supplyDemand 时供需因子按 1；
 * - 好感/势力因子对称（正声望/正好感打折，负值涨价）；
 * - 合成因子钳到 [minFactor, maxFactor] 后四舍五入，并保证不低于 minPrice（且 ≥1）。
 */
export function tradeUnitPrice(input: TradePriceInput): number {
  const {
    basePrice,
    relation,
    factionRep,
    phaseId,
    weatherId,
    volume,
    trade,
  } = input;

  const phaseFactor = trade?.phaseFactors?.[phaseId] ?? 1;
  const weatherFactor = trade?.weatherFactors?.[weatherId] ?? 1;
  const supplyFactor = trade?.supplyDemand ? 1 + trade.supplyDemand.perUnit * volume : 1;
  const relationFactor = 1 - (trade?.discountPerRelation ?? 0) * relation;
  const factionFactor = 1 - (trade?.factionDiscountPerRep ?? 0) * factionRep;

  let factor = phaseFactor * weatherFactor * supplyFactor * relationFactor * factionFactor;
  const minFactor = trade?.minFactor ?? 0;
  const maxFactor = trade?.maxFactor ?? Number.POSITIVE_INFINITY;
  factor = Math.min(Math.max(factor, minFactor), maxFactor);

  const minPrice = Math.max(1, trade?.minPrice ?? 1);
  return Math.max(minPrice, Math.round(basePrice * factor));
}
