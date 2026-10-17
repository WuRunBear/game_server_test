import { hasComponent, query } from "bitecs";
import { Health, Attack, Defense, Team, Kind, entityMapOf } from "components";
import { Cooldown, Transform } from "components";
import { entityLevelOf } from "framework/components/entityLevel";
import { isGameplayReachable } from "framework/utils/gameplayDistance";
import type { GameWorld } from "world";
import { getRuleModule } from "framework/api";
import { getEquipModifiers, getWeaponCombatProfile, getArmorDamageResist } from "framework/systems/gameplay/equipmentSystem";
import { wearEquippedItem } from "framework/systems/gameplay/durability";
import {
  computeStandardDamage,
  isCriticalRoll,
  applyCritAndResist,
  CRIT_RNG_CHANNEL,
} from "framework/systems/gameplay/damageFormula";
import { getSkillAdd, getSkillMultiplier } from "framework/systems/gameplay/progression";
import { rngFrom } from "framework/simulation/rng";
import { computeNumericStat, STAT_ATTACK, STAT_DEFENSE } from "framework/simulation/modifiers/modifiers";
import { emitEvent } from "framework/events/gameEvents";
import { queueEvent } from "framework/simulation/events/eventBus";

/** 攻击冷却缺省值（毫秒；rules/combat.json 可覆盖）。 */
export const DEFAULT_COOLDOWN_MS = 1000;
/** 攻击射程缺省值（像素；Attack 组件 range 与规则可覆盖）。 */
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
 * 攻击判定的实体地图 id：mapId 解析不到已构建图（归属异常 = 配置/存档 bug）
 * 时**不改写归属**——记 error 并原样返回，与任何真实图比较即自然跳过该实体
 * （全量常驻后不允许静默踢回默认图的旧纠偏行为）。
 */
function effectiveMapOf(world: GameWorld, eid: number): string {
  const m = entityMapOf(world, eid);
  if (m !== "" && !world.maps[m]) {
    world.logger.error("entity mapId does not resolve to a known map; entity skipped", {
      eid,
      mapId: m,
    });
  }
  return m;
}

/**
 * 攻击原子：attacker 对 target 发动一次攻击。
 *
 * 校验顺序：双方组件齐全 → 目标存活（Health > 0）→ 同图 → 冷却 → 友伤 → 射程；
 * 命中后按规则公式计算伤害并扣减 Health。**不负责死亡处理**（统一归
 * deathSystem），只负责伤害本身。
 *
 * @returns 本次攻击是否命中（失败原因：无组件/目标已死/跨图/冷却中/友军/超射程）。
 */
export function attackTarget(world: GameWorld, attackerEid: number, targetEid: number): boolean {
  if (attackerEid === targetEid) return false;
  if (!hasComponent(world, attackerEid, Attack) || !hasComponent(world, targetEid, Health)) {
    return false;
  }
  if ((Health.current[targetEid] ?? 0) <= 0) return false;
  // 攻击者与目标必须同图（分图隔离的攻防侧）
  if (effectiveMapOf(world, attackerEid) !== effectiveMapOf(world, targetEid)) return false;

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

  // 统一距离检查（前置修正 4，utils/gameplayDistance）：同层欧氏距离 ≤ 射程；
  // 异层目标不可达（跨层交战 v1 只允许经连接器移动后的同层结算）
  if (
    !isGameplayReachable(
      { x: Transform.x[attackerEid], y: Transform.y[attackerEid], level: entityLevelOf(attackerEid) },
      { x: Transform.x[targetEid], y: Transform.y[targetEid], level: entityLevelOf(targetEid) },
      attackerRange,
    )
  ) {
    return false;
  }

  // 攻击力/防御力在基础值（组件 + 装备加成 + 技能加法加成）上叠属性修饰符
  // （apply-status 等），再乘技能乘法加成——叠加顺序固定且可观察：
  // 组件基础 → 装备/技能加法 → 状态修饰符 → 技能乘法 → 暴击/克制。
  const baseAttack =
    (Attack.value[attackerEid] ?? 10) +
    getEquipModifiers(world, attackerEid).attackBonus +
    getSkillAdd(world, attackerEid, STAT_ATTACK);
  const attackerDamage =
    computeNumericStat(world, attackerEid, STAT_ATTACK, baseAttack) *
    getSkillMultiplier(world, attackerEid, STAT_ATTACK);
  const baseDefense =
    (Defense.value[targetEid] ?? 0) +
    getEquipModifiers(world, targetEid).defenseBonus +
    getSkillAdd(world, targetEid, STAT_DEFENSE);
  const targetDefense =
    computeNumericStat(world, targetEid, STAT_DEFENSE, baseDefense) *
    getSkillMultiplier(world, targetEid, STAT_DEFENSE);

  // 标准公式抽为纯函数（damageFormula），与 damage 效果共用同一数值路径
  let damage = computeStandardDamage(attackerDamage, targetDefense);

  if (damageFormula === "custom" && damageFormulaRef) {
    try {
      const customFn = getRuleModule(damageFormulaRef);
      const customDamage = customFn(world, attackerEid, targetEid, attackerDamage, targetDefense);
      if (typeof customDamage === "number") damage = customDamage;
    } catch {
      // fallback to standard formula
    }
  }

  // 暴击 / 伤害类型克制（均在公式之后结算）：
  // - 暴击：按 (tick, attacker, target, "crit") 派生确定性随机流，结果可复现；
  // - 克制：攻击方 weapon.damageType 匹配防御方 armor.resist 键，抗性钳制 [0,0.9]。
  // 未配置（critChance 0 / 无 damageType / 无 resist）时 applyCritAndResist 恒等返回。
  const weaponProfile = getWeaponCombatProfile(world, attackerEid);
  const crit =
    weaponProfile.critChance > 0 &&
    isCriticalRoll(
      rngFrom(world.time.tick, attackerEid, targetEid, CRIT_RNG_CHANNEL).next(),
      weaponProfile.critChance,
    );
  const resist = getArmorDamageResist(world, targetEid, weaponProfile.damageType);
  damage = applyCritAndResist(damage, crit, weaponProfile.critMultiplier, resist);

  Health.current[targetEid] = (Health.current[targetEid] ?? 0) - damage;

  // 耐久磨损（数值由 item kind 配置）：武器命中耗一次；护甲受击耗一次。
  // 伤害已结算，破碎不影响本次命中；破碎清槽与装备引用由磨损点即时完成。
  wearEquippedItem(world, attackerEid, "weapon");
  wearEquippedItem(world, targetEid, "armor");

  // 命中事件（产生方接线）：通用载荷放 攻击者/被命中者/实际伤害；
  // crit/damageType 仅在真实发生时附加（无配置时载荷与历史逐字段一致）。
  queueEvent(world, "on-hit", {
    eid: attackerEid,
    attacker: attackerEid,
    target: targetEid,
    damage,
    ...(crit ? { crit: true } : {}),
    ...(weaponProfile.damageType ? { damageType: weaponProfile.damageType } : {}),
  });

  // 致命一击：发射击杀事件（同帧 questSystem 等系统消费；需求耗尽等非攻击致死无事件）
  if ((Health.current[targetEid] ?? 0) <= 0) {
    emitEvent(world, "killed", {
      killer: attackerEid,
      victim: targetEid,
      kind: Kind[targetEid] ?? "",
    });
  }

  if (hasComponent(world, attackerEid, Cooldown)) {
    Cooldown.remainingMs[attackerEid] = cooldownMs;
  }

  return true;
}

/** 无配置默认实例（向后兼容直接注册形态）。 */
export function combatSystem(world: GameWorld): GameWorld {
  return createCombatSystem()(world);
}
