/**
 * 昼夜时钟派生（framework/simulation/worldClock/dayNight）——游戏无关。
 *
 * 核心契约：**hour/phase 是 `world.time.tick` 的纯函数，不做 dtMs 累积**。
 * - 一天 tick 数 = `cycleLengthSec × tickRate`（tickRate 来自 gameDef）；
 * - `hour(tick) = (START_HOUR + (tick mod dayTicks) / dayTicks × 24) mod 24`；
 * - `phase = 夜晚区间(nightStartHour, nightEndHour) 对 hour 的归属`。
 *
 * 因此同 tick 恒得同 hour/phase，与经过多少 dt、走多少推进路径无关：在线逐 tick、
 * 单步跳跃（advanceTickTo）、离线补差、重启恢复全部落到同一公式。与
 * `environmentAt`（相位/天气同样是 tick 纯函数）共用同一个时钟源，不会再出现
 * "tick 跳了、timeOfDay 没跳"的双时钟错位。
 *
 * tick 0 锚定在 START_HOUR（8 时，与 createGameWorld 初始值一致）。无 daynight
 * 规则时本模块不派生（保持既有"时间冻结"语义），调用方回退到缓存值。
 */
import {
  PHASE_DAY,
  PHASE_NIGHT,
  type GameWorld,
  type Tick,
  type TimeOfDay,
} from "world";
import type { DayNightRule } from "framework/config/schema/RuleSchema";

/** tick 0 对应的游戏内小时（与 createGameWorld 的初始 timeOfDay 一致）。 */
export const DEFAULT_DAYNIGHT_START_HOUR = 8;

/** 缺省夜晚区间：19 时入夜 … 次日 5 时天亮（与 daynight 规则缺省一致）。 */
const DEFAULT_NIGHT_START_HOUR = 19;
const DEFAULT_NIGHT_END_HOUR = 5;

/** 缺省 tick 频率（裸 world 无 gameDef 时的回退，与 gameDef 缺省 20tps 一致）。 */
const FALLBACK_TICK_RATE = 20;

/** 取本世界的 daynight 规则（未配置返回 undefined）。 */
export function getDayNightRule(world: GameWorld): DayNightRule | undefined {
  return world.gameDef?.resolvedRules?.["daynight"] as DayNightRule | undefined;
}

/** 取本世界的 tick 频率（配置值优先；裸 world 按 fixedDtMs 换算回退）。 */
export function tickRateOf(world: GameWorld): number {
  const configured = world.gameDef?.tickRate;
  if (typeof configured === "number" && Number.isFinite(configured) && configured > 0) {
    return configured;
  }
  const fixedDtMs = world.time.fixedDtMs;
  return fixedDtMs > 0 ? 1000 / fixedDtMs : FALLBACK_TICK_RATE;
}

/** 一个完整昼夜周期的 tick 数（未配置/非法返回 0 = 不派生）。 */
export function dayTicks(rule: DayNightRule | undefined, tickRate: number): number {
  const cycleLengthSec = rule?.cycleLengthSec;
  if (
    typeof cycleLengthSec !== "number" ||
    !Number.isFinite(cycleLengthSec) ||
    cycleLengthSec <= 0
  ) {
    return 0;
  }
  const rate = Number.isFinite(tickRate) && tickRate > 0 ? tickRate : FALLBACK_TICK_RATE;
  const ticks = Math.round(cycleLengthSec * rate);
  return ticks > 0 ? ticks : 0;
}

/**
 * 按 hour 求相位编号（通用机制词，语义由 game/ 配置约定）。
 *
 * 夜晚区间支持跨午夜（nightStartHour > nightEndHour，如 19 → 5）：
 * 跨午夜时 `hour ≥ start || hour < end` 为夜；不跨时 `start ≤ hour < end` 为夜。
 */
export function phaseOfHour(hour: number, rule: DayNightRule): number {
  const nightStart = rule.nightStartHour ?? DEFAULT_NIGHT_START_HOUR;
  const nightEnd = rule.nightEndHour ?? DEFAULT_NIGHT_END_HOUR;
  const isNight =
    nightStart > nightEnd
      ? hour >= nightStart || hour < nightEnd
      : hour >= nightStart && hour < nightEnd;
  return isNight ? PHASE_NIGHT : PHASE_DAY;
}

/**
 * tick 纯函数派生的昼夜状态；无 daynight 规则（或周期非法）返回 undefined。
 *
 * 小时按日取模（`((tick % dayTicks) + dayTicks) % dayTicks` 兼顾负 tick），
 * 再叠加 START_HOUR 锚点并取 24 模——跨天无累积误差。
 */
export function timeOfDayAt(
  tick: Tick,
  rule: DayNightRule | undefined,
  tickRate: number,
): TimeOfDay | undefined {
  const total = dayTicks(rule, tickRate);
  if (!rule || total <= 0) return undefined;
  const wrapped = ((tick % total) + total) % total;
  const hour = (DEFAULT_DAYNIGHT_START_HOUR + (wrapped / total) * 24) % 24;
  return { hour, phase: phaseOfHour(hour, rule) };
}

/**
 * 24 小时日计数（daynight 规则；与 `phaseAt().dayIndex` 的**环境相位周期索引**
 * 语义不同，不要混用）。
 *
 * 契约：
 * - 第 0 天从 tick 0 / hour=START_HOUR（8 时）开始；
 * - 每跨一次午夜（hour 24→0 回绕）日计数 +1；因此第 0 天只有
 *   `(24 - START_HOUR)/24` 个 dayTicks（8 时→24 时，16 小时），之后每天 24 小时；
 * - 纯函数：同 tick 恒同值，跨周期无累积误差；无 daynight 规则 → 0。
 *
 * 公式（整数运算，避免浮点边界误差）：
 * ```
 * dayTicks = round(cycleLengthSec × tickRate)
 * dayIndex = floor((tick × 24 + dayTicks × START_HOUR) / (dayTicks × 24))
 * ```
 * 等价于 `floor(tick / dayTicks + START_HOUR / 24)`：把 tick 0 的“日进度”
 * 平移到午夜对齐后再按整日取整。
 *
 * @param tick 世界逻辑帧号
 * @param rule daynight 规则（undefined → 0）
 * @param tickRate 每秒 tick 数（缺省 20，仅供裸 world/测试使用）
 */
export function dayNightDayIndex(
  tick: Tick,
  rule: DayNightRule | undefined,
  tickRate: number = FALLBACK_TICK_RATE,
): number {
  const total = dayTicks(rule, tickRate);
  if (total <= 0) return 0;
  const numerator = tick * 24 + total * DEFAULT_DAYNIGHT_START_HOUR;
  const denominator = total * 24;
  const dayIndex = Math.floor(numerator / denominator);
  return Number.isFinite(dayIndex) ? dayIndex : 0;
}

/**
 * 读当前昼夜状态：有 daynight 规则时**从 tick 现场派生**（与推进路径无关），
 * 否则回退 `world.time.timeOfDay` 缓存（无规则 = 时间冻结的既有语义）。
 */
export function timeOfDayOf(world: GameWorld): TimeOfDay {
  return (
    timeOfDayAt(world.time.tick, getDayNightRule(world), tickRateOf(world)) ??
    world.time.timeOfDay
  );
}

/**
 * 把 `world.time.timeOfDay` 重算并写入（有规则时）。消费方读缓存也能拿到与
 * tick 一致的值；无规则时 no-op。
 */
export function syncTimeOfDay(world: GameWorld): GameWorld {
  const derived = timeOfDayAt(world.time.tick, getDayNightRule(world), tickRateOf(world));
  if (derived) {
    world.time.timeOfDay = derived;
  }
  return world;
}
