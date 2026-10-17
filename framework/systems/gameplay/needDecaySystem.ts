import { query } from "bitecs";
import { Health, Needs } from "components";
import { isOfflineRetained } from "components/offline";
import type { GameWorld } from "world";
import type { NeedsRule } from "framework/config/schema/RuleSchema";
import { environmentAt } from "framework/simulation/worldClock";

/** 环境调制后的衰减乘子下限（防极端：修饰值离谱时需求几乎不衰减）。 */
export const NEED_ENVIRONMENT_SCALE_MIN = 0.1;
/** 环境调制后的衰减乘子上限（防极端：修饰值离谱时需求瞬间清空）。 */
export const NEED_ENVIRONMENT_SCALE_MAX = 10;

/**
 * 单个 Need 的环境衰减乘子（纯函数）。
 *
 * `multiplier = clamp(1 + Σ(coefficient × 当前环境修饰值), 0.1, 10)`。
 * - 未配置该 Need 的 environmentFactors → 1（无调制）
 * - 配置了但当前环境无对应修饰键 → 该键贡献 0（中性）
 * - 非有限修饰值忽略（防御脏数据）
 *
 * 环境修饰键/系数全部来自配置（rules/needs.json 的 environmentFactors 与
 * rules/environment.json 的相位 modifiers），框架只做标量加权，无游戏语义。
 */
export function environmentDecayMultiplier(
  needName: string,
  modifiers: Record<string, number> | undefined,
  factors: NeedsRule["environmentFactors"],
): number {
  const spec = factors?.[needName];
  if (!spec) return 1;

  let sum = 0;
  for (const [key, coefficient] of Object.entries(spec)) {
    const value = modifiers?.[key];
    if (typeof value === "number" && Number.isFinite(value) && Number.isFinite(coefficient)) {
      sum += coefficient * value;
    }
  }

  return Math.min(
    NEED_ENVIRONMENT_SCALE_MAX,
    Math.max(NEED_ENVIRONMENT_SCALE_MIN, 1 + sum),
  );
}

/**
 * needDecaySystem：按 dt 衰减实体的所有需求；归零则每秒扣 Health。
 *
 * 衰减速率 = `decayPerSec × rules.needs.decayScale × 环境乘子`。
 * 环境乘子由 `environmentAt(world)` 的当前相位修饰值调制（tick 纯函数，
 * 离线/初始演化无需重放：衰减始终在 tick 系统内按当前 tick 求值）。
 *
 * 死亡处理统一归 deathSystem（Slice 2 起不再自行 removeEntity）——
 * 本系统只负责扣血，Health ≤ 0 的实体由 deathSystem 做掉落/重生/移除。
 * 游戏无关——只按 Need.{name,decayPerSec,depletionDmg} 通用字段处理。
 */
export function needDecaySystem(world: GameWorld): GameWorld {
  const rules = world.gameDef.resolvedRules["needs"] as NeedsRule | undefined;
  const decayScale = rules?.decayScale ?? 1;
  const dtSec = world.time.dtMs / 1000;
  if (dtSec <= 0) return world;

  // 每 tick 求值一次（相位/天气是 tick 的纯函数）；不读 world.time.environment
  // 缓存，避免对系统拓扑序（environmentSystem 是否先跑）产生隐式依赖。
  const envModifiers = environmentAt(world).modifiers;

  for (const eid of query(world, [Health])) {
    // 断线保留期实体需求冻结（不衰减不掉血——离线玩家不应被饿死）
    if (isOfflineRetained(world, eid)) continue;
    // 需求只作用于活物（需 Health），避免给无血量实体套 AoS
    const needs = Needs[eid];
    if (!needs || needs.length === 0) continue;

    let depleted = false;
    for (const need of needs) {
      const environmentScale = environmentDecayMultiplier(
        need.name,
        envModifiers,
        rules?.environmentFactors,
      );
      need.current = Math.max(
        0,
        need.current - need.decayPerSec * decayScale * environmentScale * dtSec,
      );
      if (need.current <= 0 && need.depletionDmg > 0) {
        depleted = true;
      }
    }

    if (depleted) {
      let totalDepletionDmg = 0;
      for (const need of needs) {
        if (need.current <= 0) {
          totalDepletionDmg += need.depletionDmg;
        }
      }
      Health.current[eid] = (Health.current[eid] ?? 0) - totalDepletionDmg * dtSec;
    }
  }

  return world;
}
