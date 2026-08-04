import { hasComponent, query } from "bitecs";
import { Health, Attack, Defense, Team } from "components";
import { Cooldown, Transform } from "components";
import type { GameWorld } from "world";
import { getRuleModule } from "framework/api";
import { getEquipModifiers } from "framework/systems/gameplay/equipmentSystem";

export const DEFAULT_COOLDOWN_MS = 1000;
export const DEFAULT_ATTACK_RANGE = 32;

interface SystemConfig {
  friendlyFire?: boolean;
  damageFormula?: string;
  damageFormulaRef?: string;
  attackCooldownMs?: number;
  attackRange?: number;
}

/**
 * combatSystem：攻击冷却递减 + 攻击原子。
 *
 * - 系统体只负责逐 tick 递减所有实体的攻击冷却。
 * - 伤害施加统一走导出的 attackTarget 原子：BT Attack 动作与玩家 attack 意图
 *   都调它，不再有系统级的"范围内自动攻击"（避免与显式目标攻击双重伤害）。
 *   参数全部从 `rules/combat.json` 读取（friendlyFire / 公式 / 冷却 / 射程），
 *   系统级 config 仅保留向后兼容的占位（不再生效）。
 */
export function createCombatSystem(_config?: Record<string, unknown>) {
  return function combatSystem(world: GameWorld): GameWorld {
    for (const eid of query(world, [Cooldown])) {
      const remaining = Cooldown.remainingMs[eid];
      if (remaining !== undefined && remaining > 0) {
        Cooldown.remainingMs[eid] = Math.max(0, remaining - world.time.dtMs);
      }
    }
    return world;
  };
}

/**
 * 攻击原子：attacker 对 target 发动一次攻击。
 *
 * 校验顺序：双方组件齐全 → 目标存活（Health > 0）→ 冷却 → 友伤 → 射程；
 * 命中后按规则公式计算伤害并扣减 Health。**不负责死亡处理**（统一归
 * deathSystem），只负责伤害本身。
 *
 * @returns 本次攻击是否命中（失败原因：无组件/目标已死/冷却中/友军/超射程）。
 */
export function attackTarget(world: GameWorld, attackerEid: number, targetEid: number): boolean {
  if (attackerEid === targetEid) return false;
  if (!hasComponent(world, attackerEid, Attack) || !hasComponent(world, targetEid, Health)) {
    return false;
  }
  if ((Health.current[targetEid] ?? 0) <= 0) return false;

  const rules = world.gameDef.resolvedRules["combat"] as SystemConfig | undefined;
  const friendlyFire = rules?.friendlyFire ?? true;
  const damageFormula = rules?.damageFormula ?? "standard";
  const damageFormulaRef = rules?.damageFormulaRef;
  const cooldownMs = rules?.attackCooldownMs ?? DEFAULT_COOLDOWN_MS;

  if (hasComponent(world, attackerEid, Cooldown)) {
    if ((Cooldown.remainingMs[attackerEid] ?? 0) > 0) return false;
  }

  if (!friendlyFire && Team.id[attackerEid] === Team.id[targetEid]) return false;

  const componentRange = Attack.range[attackerEid];
  const attackerRange =
    typeof componentRange === "number" && componentRange > 0
      ? componentRange
      : (rules?.attackRange ?? DEFAULT_ATTACK_RANGE);

  const dist = Math.hypot(
    Transform.x[attackerEid] - Transform.x[targetEid],
    Transform.y[attackerEid] - Transform.y[targetEid],
  );
  if (dist > attackerRange) return false;

  const attackerDamage = (Attack.value[attackerEid] ?? 10) + getEquipModifiers(world, attackerEid).attackBonus;
  const targetDefense =
    (Defense.value[targetEid] ?? 0) + getEquipModifiers(world, targetEid).defenseBonus;

  let damage = Math.max(1, attackerDamage - targetDefense);

  if (damageFormula === "custom" && damageFormulaRef) {
    try {
      const customFn = getRuleModule(damageFormulaRef);
      const customDamage = customFn(world, attackerEid, targetEid, attackerDamage, targetDefense);
      if (typeof customDamage === "number") damage = customDamage;
    } catch {
      // fallback to standard formula
    }
  }

  Health.current[targetEid] = (Health.current[targetEid] ?? 0) - damage;

  if (hasComponent(world, attackerEid, Cooldown)) {
    Cooldown.remainingMs[attackerEid] = cooldownMs;
  }

  return true;
}

/** 无配置默认实例（向后兼容直接注册形态）。 */
export function combatSystem(world: GameWorld): GameWorld {
  return createCombatSystem()(world);
}
