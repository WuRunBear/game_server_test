/**
 * 状态机定时迁移的**环境倍率缩放**（framework/simulation/stateMachine/scaledDue）
 * ——游戏无关。
 *
 * 迁移可声明 `scale: "<modifierKey>"`（如 `"growthScale"`）：实际等待不再按
 * `afterTicks` 固定 tick，而是按环境修饰值的**区间积分**累计「生长时间」：
 *
 *     work(a, b) = ∫_a^b max(scale(t), MIN_SCALE) dt
 *     到期 tick  = 最小 t，使 work(enteredTick, t) ≥ afterTicks
 *
 * `scale(t)` 由 environment 规则按相位与相位进度求值（常量或 `{ from, to }`
 * 线性，与 `resolveModifiers` 同源）。选择积分而非「按目标 tick 采样」的理由：
 * - 跨相位时生长速率连续变化，积分是唯一与「逐 tick 累加」语义一致的确定性定义；
 * - 到期 tick 只依赖 `(enteredTick, afterTicks, rule)`，因此在线逐 tick 推进与
 *   离线一次快进调用**同一个函数**，结果按构造等价（测试断言两条路径一致）。
 *
 * `MIN_SCALE = 0.05` 是下限（防止修饰值为 0/负数时永远不迁移）；修饰键缺省时
 * 按 1 计（中性），所以未声明 `scale` 的迁移行为与历史完全一致。
 */
import type { EnvironmentModifier, EnvironmentPhase, EnvironmentRule } from "framework/config/schema/RuleSchema";
import type { GameWorld } from "framework/world";
import { cycleTicks, getEnvironmentRule, phaseAt } from "framework/simulation/worldClock";

/** 环境倍率下限（生长再慢也以 5% 速度前进，保证迁移最终发生）。 */
export const MIN_EFFECTIVE_SCALE = 0.05;

/** 浮点比较容差（work 单位 = tick × 倍率）。 */
const EPS = 1e-9;

/** 取某相位的修饰值端点（scale 按进度在 [v0, v1] 线性插值）。 */
function phaseScaleEndpoints(
  phase: EnvironmentPhase,
  key: string,
): { v0: number; v1: number } {
  const spec: EnvironmentModifier | undefined = phase.modifiers?.[key];
  if (spec === undefined) return { v0: 1, v1: 1 };
  if (typeof spec === "number") return { v0: spec, v1: spec };
  return { v0: spec.from, v1: spec.to };
}

/**
 * 在当前 tick 求环境倍率（下限钳制后）。无 environment 规则 / 未配置该键 → 1。
 * 导出供诊断与测试使用。
 */
export function effectiveScaleAt(world: GameWorld, tick: number, key: string): number {
  const rule = getEnvironmentRule(world);
  if (!rule) return 1;
  const phase = phaseAt(tick, rule);
  const { v0, v1 } = phaseScaleEndpoints(rule.phases[phase.phaseIndex], key);
  const raw = v0 + (v1 - v0) * phase.progress;
  return Math.max(raw, MIN_EFFECTIVE_SCALE);
}

/**
 * 线性（可钳制）倍率在 [0, u] 上的积分。
 *
 * `v0`/`v1` 是区间两端值（`len` 内线性）；低于 `minScale` 的部分按常数
 * `minScale` 计——与「逐 tick 采 max(scale, MIN) 再累加」的极限一致。
 */
function integrateSegment(
  v0: number,
  v1: number,
  len: number,
  u: number,
  minScale: number,
): number {
  if (len <= 0 || u <= 0) return 0;
  const uu = Math.min(u, len);
  const k = (v1 - v0) / len;

  if (v0 >= minScale && v1 >= minScale) {
    return v0 * uu + 0.5 * k * uu * uu;
  }
  if (v0 <= minScale && v1 <= minScale) {
    return minScale * uu;
  }

  // 两端跨过下限：先线性到交点，再按常数下限。
  const crossing = (minScale - v0) / k; // 0 < crossing < len
  if (uu <= crossing) return v0 * uu + 0.5 * k * uu * uu;
  const workToCross = v0 * crossing + 0.5 * k * crossing * crossing;
  return workToCross + minScale * (uu - crossing);
}

/** 当前相位剩余段的倍率端点与长度。 */
function segmentAt(
  rule: EnvironmentRule,
  tick: number,
  key: string,
): { len: number; v0: number; v1: number } {
  const phase = phaseAt(tick, rule);
  const config = rule.phases[phase.phaseIndex];
  const duration = config.durationTicks;
  const len = Math.max(0, duration - phase.progress * duration);
  const { v0, v1 } = phaseScaleEndpoints(config, key);
  return {
    len,
    v0: v0 + (v1 - v0) * phase.progress,
    v1,
  };
}

/** 一个完整相位循环的累计 work（倍率按相位进度线性、下限钳制）。 */
function cycleWork(rule: EnvironmentRule, key: string, minScale: number): number {
  let total = 0;
  for (const phase of rule.phases) {
    const { v0, v1 } = phaseScaleEndpoints(phase, key);
    total += integrateSegment(v0, v1, phase.durationTicks, phase.durationTicks, minScale);
  }
  return total;
}

/**
 * 缩放后的到期 tick（纯函数）：
 * `work(enteredTick, due) ≥ afterTicks` 的最小整数 tick。
 *
 * 未声明 `scaleKey`、`afterTicks = 0` 或无 environment 规则时退化为
 * `enteredTick + afterTicks`（历史语义逐位一致）。
 */
export function scaledDueTick(
  world: GameWorld,
  enteredTick: number,
  afterTicks: number,
  scaleKey: string | undefined,
  minScale: number = MIN_EFFECTIVE_SCALE,
): number {
  if (afterTicks <= 0) return enteredTick;
  if (!scaleKey) return enteredTick + afterTicks;

  const rule = getEnvironmentRule(world);
  if (!rule) return enteredTick + afterTicks;

  // 整个规则都没配这个修饰键 → 中性（按 1 计）直接返回，避免浮点路径。
  const hasKey = rule.phases.some((phase) => phase.modifiers?.[scaleKey] !== undefined);
  if (!hasKey) return enteredTick + afterTicks;

  const cycle = cycleTicks(rule);
  if (cycle <= 0) return enteredTick + afterTicks;

  let tick = enteredTick;
  let remaining = afterTicks;

  // 整周期跳过：倍率只随相位进度变化，每周期 work 相同。
  const perCycle = cycleWork(rule, scaleKey, minScale);
  if (perCycle > EPS) {
    const wholeCycles = Math.floor(remaining / perCycle);
    if (wholeCycles > 0) {
      tick += wholeCycles * cycle;
      remaining -= wholeCycles * perCycle;
    }
  }

  let guard = 0;
  while (remaining > EPS) {
    const segment = segmentAt(rule, tick, scaleKey);
    if (segment.len <= 0) break; // 配置异常（时长非正）——保持当前 tick 兜底
    const full = integrateSegment(segment.v0, segment.v1, segment.len, segment.len, minScale);

    if (full <= remaining + EPS) {
      remaining -= full;
      tick += segment.len;
    } else {
      // 在段内二分求解（积分单调递增）。
      let lo = 0;
      let hi = segment.len;
      for (let i = 0; i < 64; i++) {
        const mid = (lo + hi) / 2;
        const work = integrateSegment(segment.v0, segment.v1, segment.len, mid, minScale);
        if (work < remaining) lo = mid;
        else hi = mid;
      }
      tick += (lo + hi) / 2;
      remaining = 0;
    }

    if (++guard > 1_000_000) break; // 防御性上限（正常路径远达不到）
  }

  // 到期取「首个达到所需 work 的整数 tick」；减去微小容差避免 3.0000001 → 4。
  return Math.max(enteredTick, Math.ceil(tick - 1e-6));
}
