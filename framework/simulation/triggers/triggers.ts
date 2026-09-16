/**
 * Triggers 组件：声明式触发器挂载（AoS 结构）。
 *
 * 每个条目 = 触发器名（对应 triggerRegistry 求值器与类型化事件名）+
 * 触发时执行的效果引用列表（EffectSpec[]）。triggerSystem 在其固定阶段
 * 消费事件总线，按事件名匹配求值器并执行该实体命中的效果列表。
 *
 * 组件默认随实体持久化（声明式配置数据，恢复后语义不变）。
 */
import type { EffectSpec } from "framework/simulation/effects/effectRegistry";

/** 单条触发器声明：触发器名 + 效果引用列表。 */
export interface TriggerEntry {
  /** 触发器名（triggerRegistry 注册名 = 类型化事件名，如 "on-timer"）。 */
  trigger: string;
  /** 触发时执行的效果引用列表（经 effectRegistry 求值）。 */
  effects: EffectSpec[];
}

/** AoS 存储：普通 JS 数组按 eid 索引（非 bitecs 组件，不能 addComponent/query）。 */
export const Triggers = [] as (TriggerEntry[] | undefined)[];

/**
 * 为实体挂载一条触发器声明（无 Triggers 数据时自动创建列表）。
 */
export function addTrigger(eid: number, entry: TriggerEntry): void {
  let list = Triggers[eid];
  if (!list) {
    list = Triggers[eid] = [];
  }
  list.push({ trigger: entry.trigger, effects: entry.effects.map((spec) => ({ ...spec })) });
}
