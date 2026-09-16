/**
 * 标准伤害公式（纯函数，游戏无关）。
 *
 * 从 combatSystem.attackTarget 抽取共用：combat 路径与 damage 效果
 * （framework/simulation/effects）走同一公式，保证两条伤害路径数值一致。
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
