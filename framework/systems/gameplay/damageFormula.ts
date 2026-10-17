/**
 * 标准伤害公式（纯函数，游戏无关）。
 *
 * 从 combatSystem.attackTarget 抽取共用：combat 路径与 damage 效果
 * （framework/simulation/effects）走同一公式，保证两条伤害路径数值一致。
 *
 * 另提供暴击 / 伤害类型克制的纯函数步骤（combatSystem 调用）：
 * 无配置时这些函数是恒等变换（零回归），配置后按确定性的先后顺序叠加：
 * `标准伤害 → ×暴击倍率 → ×(1 - 抗性)`，最后取整并保证至少 1 点。
 */

/**
 * 计算标准伤害：max(1, 防御前基础量 - 目标防御)。
 *
 * @param base 防御前基础量（攻击力或效果声明的基准伤害）
 * @param defense 目标防御（含装备加成后的合计值）
 * @returns 实际扣减量（至少 1，保证攻击始终有效果）
 */
export function computeStandardDamage(base: number, defense: number): number {
  return Math.max(1, base - defense);
}

/** 抗性上限：无论配置多大，最多减免 90%（避免免疫导致战斗僵死）。 */
export const MAX_DAMAGE_RESIST = 0.9;

/** 暴击倍率缺省值（声明 critChance 但未声明 critMultiplier 时）。 */
export const DEFAULT_CRIT_MULTIPLIER = 1.5;

/** 暴击随机流频道名（与其它确定性随机流隔离）。 */
export const CRIT_RNG_CHANNEL = "crit";

/** 暴击判定：roll ∈ [0,1)，chance 钳制到 [0,1]；chance ≤ 0 恒不暴击。 */
export function isCriticalRoll(roll: number, critChance: number | undefined): boolean {
  if (critChance === undefined || !Number.isFinite(critChance) || critChance <= 0) return false;
  const chance = Math.min(1, critChance);
  return roll < chance;
}

/** 暴击倍率归一：未配置/非法时 1（不放大）；配置值钳制到 ≥ 1。 */
export function normalizeCritMultiplier(multiplier: number | undefined): number {
  if (multiplier === undefined || !Number.isFinite(multiplier)) return 1;
  return Math.max(1, multiplier);
}

/** 抗性归一：未配置/非法按 0；钳制到 [0, MAX_DAMAGE_RESIST]。 */
export function clampDamageResist(resist: number | undefined): number {
  if (resist === undefined || !Number.isFinite(resist)) return 0;
  return Math.min(MAX_DAMAGE_RESIST, Math.max(0, resist));
}

/**
 * 套用暴击 / 抗性修正（纯函数）。
 *
 * 只在真的发生修正时取整（crit 或 resist > 0）；无配置路径原样返回输入，
 * 与历史伤害逐值一致（零回归）。
 *
 * @param damage 标准公式（或自定义公式）算出的伤害
 * @param crit 是否暴击
 * @param critMultiplier 暴击倍率（未配置按 1）
 * @param resist 目标对该伤害类型的抗性（未配置按 0；内部钳制 [0, 0.9]）
 */
export function applyCritAndResist(
  damage: number,
  crit: boolean,
  critMultiplier: number | undefined,
  resist: number | undefined,
): number {
  const multiplier = crit ? normalizeCritMultiplier(critMultiplier) : 1;
  const clampedResist = clampDamageResist(resist);
  const modified = crit || clampedResist > 0;
  if (!modified) return damage;
  return Math.max(1, Math.round(damage * multiplier * (1 - clampedResist)));
}
