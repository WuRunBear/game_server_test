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
import { parseEffectSpec } from "framework/simulation/effects/effectRegistry";

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

/**
 * AoS archetype 初始化钩子：按实体原型的 Triggers 配置写入声明列表。
 *
 * 配置形态为 TriggerEntry[]（trigger 字符串 + effects 效果引用数组）；
 * 结构非法（非数组/缺 trigger 名）的条目跳过，不影响其余声明。
 * 游戏无关——trigger 名与效果参数对框架均为不透明配置。
 */
export function initTriggers(_world: unknown, eid: number, config: unknown): void {
  if (!Array.isArray(config)) return;
  const list: TriggerEntry[] = [];
  for (const raw of config) {
    const trigger = parseEffectTriggerName(raw);
    if (!trigger) continue;
    list.push({ trigger, effects: parseEffectSpecs((raw as { effects?: unknown }).effects) });
  }
  Triggers[eid] = list;
}

/** 读取触发器条目的 trigger 名（非对象/非字符串 → 空）。 */
function parseEffectTriggerName(raw: unknown): string {
  if (!raw || typeof raw !== "object") return "";
  const trigger = (raw as { trigger?: unknown }).trigger;
  return typeof trigger === "string" ? trigger : "";
}

/** 解析效果引用数组（结构非法项跳过）。 */
function parseEffectSpecs(raw: unknown): EffectSpec[] {
  if (!Array.isArray(raw)) return [];
  const specs: EffectSpec[] = [];
  for (const item of raw) {
    const spec = parseEffectSpec(item);
    if (spec) specs.push(spec);
  }
  return specs;
}
