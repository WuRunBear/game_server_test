/**
 * Modifiers 组件：实体属性修饰符（AoS 结构）。
 *
 * 按「statKey → 条目数组」组织；条目为乘法/加法/布尔三种修正之一，
 * 可带来源标识与失效 tick。computeStat 按「base × (1+Σmul) + Σadd」
 * 合成数值，bool 型条目同 statKey 内取或（bool 条目存在时优先返回布尔）。
 *
 * 过期条目按 world.time.tick 惰性判定失效（expiresTick 时刻起不再生效），
 * 不做主动清理——条目量小，读取路径过滤即可。组件默认随实体持久化。
 *
 * 现有移动/战斗系统暂不接入 computeStat（接线留配方切片），
 * 本阶段消费方为 apply-status 效果与测试。
 */
import type { GameWorld } from "framework/world";

/** 单条修饰符条目：乘法/加法/布尔修正 + 来源 + 失效 tick。 */
export interface ModifierEntry {
  /** 乘法修正（比例增量，参与 1+Σmul）。 */
  mul?: number;
  /** 加法修正（最终加算，参与 Σadd）。 */
  add?: number;
  /** 布尔型标记（同 statKey 条目取或；置位后该 stat 返回布尔）。 */
  bool?: boolean;
  /** 来源标识（调试/追踪，如施加的效果名或状态名）。 */
  source?: string;
  /** 失效 tick（world.time.tick ≥ 该值时条目失效；缺省永久）。 */
  expiresTick?: number;
}

/** 单实体的修饰符集合：statKey → 条目数组。 */
export type ModifierSet = Record<string, ModifierEntry[]>;

/** AoS 存储：普通 JS 数组按 eid 索引（非 bitecs 组件，不能 addComponent/query）。 */
export const Modifiers = [] as (ModifierSet | undefined)[];

/**
 * 追加一条修饰符（浅拷贝条目，防调用方后续改动污染存储）。
 * 实体无 Modifiers 数据时自动创建集合。
 */
export function addModifier(
  _world: GameWorld,
  eid: number,
  statKey: string,
  entry: ModifierEntry,
): void {
  let set = Modifiers[eid];
  if (!set) {
    set = Modifiers[eid] = {};
  }
  const list = set[statKey] ?? (set[statKey] = []);
  list.push({ ...entry });
}

/** 条目是否生效（expiresTick 缺省永久；tick ≥ expiresTick 即失效）。 */
function isActiveEntry(world: GameWorld, entry: ModifierEntry): boolean {
  return entry.expiresTick === undefined || world.time.tick < entry.expiresTick;
}

/**
 * 合成属性值：base × (1+Σmul) + Σadd（仅统计生效条目）。
 *
 * bool 型条目优先：同 statKey 存在生效的 bool 条目时返回其取或结果
 * （布尔语义 stat 不应混用数值条目；混用时 bool 优先，数值条目忽略）。
 *
 * @param base 基础值（调用方从组件/配置解析）
 * @returns 合成数值；或 bool 条目存在时的取或布尔值
 */
export function computeStat(
  world: GameWorld,
  eid: number,
  statKey: string,
  base: number,
): number | boolean {
  const entries = Modifiers[eid]?.[statKey] ?? [];
  let mulSum = 0;
  let addSum = 0;
  let hasBool = false;
  let boolOr = false;
  for (const entry of entries) {
    if (!isActiveEntry(world, entry)) continue;
    if (entry.bool !== undefined) {
      hasBool = true;
      boolOr = boolOr || entry.bool;
      continue;
    }
    mulSum += entry.mul ?? 0;
    addSum += entry.add ?? 0;
  }
  if (hasBool) return boolOr;
  return base * (1 + mulSum) + addSum;
}
