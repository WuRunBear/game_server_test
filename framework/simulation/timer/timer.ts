/**
 * 定时器组件（AoS 结构）：绝对到期一次性定时器与周期定时器。
 *
 * 采用 AoS 而非 SoA：条目需携带效果引用（EffectSpec，含名字符串与参数对象），
 * SoA 数值数组表达不了；迭代由 timerSystem 扫描 AoS 数组完成（条目量 =
 * 定时实体数，扫描代价可接受）。
 *
 * 两个组件均为运行时瞬态（worldSerializer 跳过清单）：定时状态跨存档无意义，
 * 恢复后由效果/触发配置重建。
 */
import type { EffectSpec } from "framework/simulation/effects/effectRegistry";

/** ExpiresAt 条目：一次性定时器（绝对到期 tick）。 */
export interface ExpiresAtEntry {
  /** 到期 tick（world.time.tick ≥ 该值时触发）。 */
  expiresTick: number;
  /** 到期时评估的效果引用（缺省仅发 on-timer 事件）。 */
  effect?: EffectSpec;
}

/** AoS 存储：普通 JS 数组按 eid 索引（非 bitecs 组件，不能 addComponent/query）。 */
export const ExpiresAt = [] as (ExpiresAtEntry | undefined)[];

/** Interval 条目：周期定时器（周期 + 下次触发 tick + 剩余次数）。 */
export interface IntervalEntry {
  /** 触发周期（tick 数，须 > 0）。 */
  periodTicks: number;
  /** 下次触发 tick（绝对 tick 号）。 */
  nextTick: number;
  /** 剩余触发次数；负值表示无限重复。 */
  remaining: number;
  /** 每次触发时评估的效果引用。 */
  effect?: EffectSpec;
}

/** AoS 存储：普通 JS 数组按 eid 索引（非 bitecs 组件，不能 addComponent/query）。 */
export const Interval = [] as (IntervalEntry | undefined)[];

/**
 * 设置一次性定时器（覆盖同实体旧条目）。
 * @param expiresTick 到期 tick（≤ 当前 tick 时下个 timerSystem tick 立即触发）
 */
export function setExpiresAt(eid: number, expiresTick: number, effect?: EffectSpec): void {
  ExpiresAt[eid] = effect ? { expiresTick, effect } : { expiresTick };
}

/**
 * 设置周期定时器（覆盖同实体旧条目）。
 * @param periodTicks 周期（> 0）
 * @param nextTick 下次触发 tick
 * @param remaining 剩余次数（负值 = 无限）
 */
export function setIntervalTimer(
  eid: number,
  periodTicks: number,
  nextTick: number,
  remaining: number,
  effect?: EffectSpec,
): void {
  Interval[eid] = effect ? { periodTicks, nextTick, remaining, effect } : { periodTicks, nextTick, remaining };
}

/** 清除实体的全部定时器（一次性 + 周期）。 */
export function clearTimers(eid: number): void {
  ExpiresAt[eid] = undefined;
  Interval[eid] = undefined;
}
