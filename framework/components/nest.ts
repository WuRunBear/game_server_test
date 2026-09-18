/**
 * Nest 组件：巢穴生产状态（AoS 结构）。
 *
 * 由 spawn 的 AoS 初始化钩子写入，按 archetype 的 Nest 配置建状态。
 * 巢穴系统（gameplay/nestSystem）按 intervalTicks 周期在巢周围把 spawnKind
 * 实体补到 capacity，并把存活数镜像进 current。字段名与语义游戏无关
 * （spawnKind 是 archetype kind 字符串引用；具体产出物种由 game/ 配置约定）。
 *
 * 巢（实体）被摧毁即停产——destroyEntity 清 AoS 残留，无独立存活状态。
 */
export interface NestState {
  /** 巢生产的实体原型 kind（archetypes 注册表引用）。 */
  spawnKind: string;
  /** 巢周围目标存量上限（同 kind 存活数补到此值为止；0 = 不生产）。 */
  capacity: number;
  /** 生产门控周期（tick 数；world.time.tick % intervalTicks === 0 时检查）。 */
  intervalTicks: number;
  /** 当前存活产出数镜像（巢穴系统每次门控重算，不从配置读取）。 */
  current: number;
}

/** AoS 存储：普通 JS 数组按 eid 索引（非 bitecs 组件，不能 addComponent/query）。 */
export const Nest = [] as (NestState | undefined)[];

interface NestConfig {
  spawnKind?: unknown;
  capacity?: unknown;
  intervalTicks?: unknown;
}

/**
 * AoS 初始化钩子：归一化 archetype 配置并 fail-fast。
 *
 * - spawnKind：必填字符串，缺失/空串抛错（配置错误尽早暴露）
 * - capacity：向下取整并钳到 ≥ 0
 * - intervalTicks：向下取整并钳到 ≥ 1
 * - current：恒从 0 起（真实存活数由巢穴系统门控时重算镜像）
 */
export function initNest(
  _world: unknown,
  eid: number,
  config: unknown,
): void {
  const cfg = (config ?? {}) as NestConfig;
  const spawnKind = typeof cfg.spawnKind === "string" ? cfg.spawnKind : "";
  if (spawnKind === "") {
    throw new Error(`Nest component requires a non-empty "spawnKind" string (entity ${eid})`);
  }
  const capacity =
    typeof cfg.capacity === "number" && Number.isFinite(cfg.capacity)
      ? Math.max(0, Math.floor(cfg.capacity))
      : 0;
  const intervalTicks =
    typeof cfg.intervalTicks === "number" && Number.isFinite(cfg.intervalTicks)
      ? Math.max(1, Math.floor(cfg.intervalTicks))
      : 1;
  Nest[eid] = { spawnKind, capacity, intervalTicks, current: 0 };
}
