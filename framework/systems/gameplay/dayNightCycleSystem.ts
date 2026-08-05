import { PHASE_DAY, PHASE_NIGHT, type GameWorld } from "world";

interface DayNightRule {
  cycleLengthSec?: number;
  nightStartHour?: number;
  nightEndHour?: number;
}

const DEFAULT_NIGHT_START_HOUR = 19;
const DEFAULT_NIGHT_END_HOUR = 5;

/**
 * dayNightCycleSystem：推进 world.time.timeOfDay（世界级昼夜）。
 *
 * 按 daynight 规则将小时连续推进（0-24 取模），并按夜晚区间计算相位
 * （PHASE_DAY / PHASE_NIGHT）。夜晚区间支持跨午夜（如 19 → 5）。
 * 无 daynight 规则配置时保持初始状态（no-op），世界从 createGameWorld
 * 的初始小时（8，白天）开始。
 *
 * 相位是通用机制词（编号而非语义），消费方（spawn condition / BT 条件）
 * 按编号比较。游戏无关。
 */
export function dayNightCycleSystem(world: GameWorld): GameWorld {
  const rules = world.gameDef.resolvedRules["daynight"] as DayNightRule | undefined;
  if (!rules?.cycleLengthSec || rules.cycleLengthSec <= 0) return world;

  const tod = world.time.timeOfDay;
  const nightStart = rules.nightStartHour ?? DEFAULT_NIGHT_START_HOUR;
  const nightEnd = rules.nightEndHour ?? DEFAULT_NIGHT_END_HOUR;

  const hoursPerMs = 24 / (rules.cycleLengthSec * 1000);
  tod.hour = (tod.hour + world.time.dtMs * hoursPerMs) % 24;

  tod.phase =
    nightStart > nightEnd
      ? (tod.hour >= nightStart || tod.hour < nightEnd ? PHASE_NIGHT : PHASE_DAY)
      : (tod.hour >= nightStart && tod.hour < nightEnd ? PHASE_NIGHT : PHASE_DAY);

  return world;
}
