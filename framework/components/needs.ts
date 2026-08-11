/**
 * Needs 组件：实体的生理需求列表（AoS 结构）。
 *
 * 每个 Need 用字符串 `name` 标识（具体名由 game/ 配置约定），
 * 框架不识别具体语义——needDecaySystem 按名统一衰减、按名统一扣血；
 * item 的 consume 效果也按 name 匹配恢复。游戏无关。
 */
export interface Need {
  /** 需求名（字符串，游戏侧约定）。 */
  name: string;
  /** 当前值。 */
  current: number;
  /** 上限。 */
  max: number;
  /** 每秒衰减量。 */
  decayPerSec: number;
  /** 归零时每秒扣 Health 的伤害。 */
  starveDmg: number;
}

/** AoS 存储：普通 JS 数组按 eid 索引（非 bitecs 组件，不能 addComponent/query）。 */
export const Needs = [] as (Need[] | undefined)[];

interface NeedConfig {
  name?: string;
  current?: number;
  max?: number;
  decayPerSec?: number;
  starveDmg?: number;
}

/** AoS 初始化钩子：深拷贝 archetype 的 Needs 数组配置，补默认值。 */
export function initNeeds(
  _world: unknown,
  eid: number,
  config: unknown,
): void {
  const arr = Array.isArray(config) ? (config as NeedConfig[]) : [];
  Needs[eid] = arr.map((n) => ({
    name: String(n?.name ?? ""),
    current: Number(n?.current ?? n?.max ?? 0),
    max: Number(n?.max ?? 0),
    decayPerSec: Number(n?.decayPerSec ?? 0),
    starveDmg: Number(n?.starveDmg ?? 0),
  }));
}