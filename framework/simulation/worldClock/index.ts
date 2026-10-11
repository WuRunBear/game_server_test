/**
 * WorldClock 相位/环境派生（framework/simulation/worldClock）——游戏无关。
 *
 * 核心契约：**相位与天气都是 `world.time.tick` 的纯函数，不做增量累积状态**。
 * - 相位：`phaseAt(tick, rule)`。相位程序按绝对槽对齐（一周期总长 = 各相位
 *   时长之和；相位边界落在 `k × 累计时长` 上，与演化引擎 `s = k × every` 的
 *   槽对齐语义一致）。当前相位索引/进度/日索引都是派生值，求值只依赖 tick。
 * - 天气：`weatherAt(tick, rule)`。天气槽 `weatherSlot = floor(tick /
 *   weatherSlotTicks)`；天气由 A1 确定性随机服务从「本相位（该槽起始 tick
 *   所属相位）的天气候选 + 权重」里抽样——同 (seed, slot) 恒同结果。
 *
 * 因此任意 tick 可直接求值：离线补差天然正确，不需要逐 tick 重放相位/天气。
 *
 * 字段全部物理/通用语义（phaseId / weatherId / progress / modifiers），
 * 不含游戏或天气专属语义——相位与天气 id 都是 game/ 配置提供的字符串，
 * 框架只当不透明标识透传。
 */
import type { GameWorld, Tick } from "framework/world";
import type {
  EnvironmentPhase,
  EnvironmentRule,
} from "framework/config/schema/RuleSchema";
import { rngFrom } from "framework/simulation/rng";

/** 相位求值结果（tick 的纯函数）。 */
export interface PhaseView {
  /** 相位在规则 phases 数组中的索引（0 起）。 */
  phaseIndex: number;
  /** 相位 id（配置字符串）。 */
  phaseId: string;
  /** 相位内进度 [0, 1)。 */
  progress: number;
  /** 已完成的完整相位循环数（floor(tick / 一周期总 tick)）。 */
  dayIndex: number;
}

/** 环境派生视图（相位 + 天气 + 修饰数值）。 */
export interface EnvironmentView extends PhaseView {
  /** 当前天气 id（配置字符串；该相位无候选时为空串）。 */
  weatherId: string;
  /** 当前天气槽索引（floor(tick / weatherSlotTicks)）。 */
  weatherSlot: number;
  /** 当前相位修饰数值（常量或按进度线性求值后的标量）。 */
  modifiers: Record<string, number>;
}

/**
 * 派生地形视图的查询输入契约（后续切片实现 effectiveGround / 积雪等派生，
 * 本切片只定义接口，不做任何地形派生）。输入：底板语义 + 所在区域/层 + tick。
 */
export interface TileContext {
  /** 底板语义（tile 地面类型编号）。 */
  groundSemantic: number;
  /** 所在区域名（MapGeometry.regions 键）。 */
  region: string;
  /** 所在层号（v2 level；v1 恒 0）。 */
  level: number;
}

/**
 * 派生地形视图求值器契约（后续切片的扩展点，本切片不实现）：
 * `effectiveGround = f(底板语义, 相位/进度/天气, 层, 区域, tick)`。本切片只
 * 把输入形状与时钟查询固定下来，具体派生逻辑（积雪线、湿地面等）属后续切片。
 */
export type GroundDerivationFn = (
  tick: Tick,
  rule: EnvironmentRule,
  tile: TileContext,
) => unknown;

/** 无 environment 规则时的中性环境视图（相位/天气皆空，修饰为空）。 */
export const NEUTRAL_ENVIRONMENT: EnvironmentView = {
  phaseIndex: 0,
  phaseId: "",
  progress: 0,
  dayIndex: 0,
  weatherId: "",
  weatherSlot: 0,
  modifiers: {},
};

/** 取本世界的 environment 规则（未配置返回 undefined）。 */
export function getEnvironmentRule(world: GameWorld): EnvironmentRule | undefined {
  return world.gameDef?.resolvedRules?.["environment"] as EnvironmentRule | undefined;
}

/** 一周期总 tick（各相位时长之和）。 */
export function cycleTicks(rule: EnvironmentRule): number {
  let total = 0;
  for (const phase of rule.phases) total += phase.durationTicks;
  return total;
}

/**
 * 相位求值（纯函数）：按绝对槽对齐把 tick 映射到相位索引 / 进度 / 日索引。
 *
 * 一周期 = 各相位时长之和；`t = tick mod cycle`，相位 i 占据
 * `[cum_i, cum_i + dur_i)`；边界 tick 归下一相位（`t === cum_{i+1}` → 相位 i+1），
 * 与「边界为 k × durationTicks」的槽对齐语义一致，跨周期不漂移。
 */
export function phaseAt(tick: Tick, rule: EnvironmentRule): PhaseView {
  const phases = rule.phases;
  const cycle = cycleTicks(rule);
  const t = cycle > 0 ? ((tick % cycle) + cycle) % cycle : 0;

  let acc = 0;
  let index = phases.length - 1;
  for (let i = 0; i < phases.length; i++) {
    const dur = phases[i].durationTicks;
    if (t < acc + dur) {
      index = i;
      break;
    }
    acc += dur;
  }

  const phase = phases[index];
  const progress = phase.durationTicks > 0 ? (t - acc) / phase.durationTicks : 0;
  const dayIndex = cycle > 0 ? Math.floor(tick / cycle) : 0;
  return { phaseIndex: index, phaseId: phase.id, progress, dayIndex };
}

/** 当前天气槽索引（floor(tick / weatherSlotTicks)）。 */
export function weatherSlotAt(tick: Tick, rule: EnvironmentRule): number {
  const slotTicks = rule.weatherSlotTicks;
  return slotTicks > 0 ? Math.floor(tick / slotTicks) : 0;
}

/**
 * 天气求值（纯函数）：`weather = f(seed, weatherSlot)`。
 *
 * 天气槽起始 tick 所属相位决定候选表；用 A1 确定性随机服务按权重抽样——
 * 同 (seed, slot) 恒同结果，异 slot 序列互不相关。该相位无候选时返回空串。
 */
export function weatherAt(
  tick: Tick,
  rule: EnvironmentRule,
): { weatherId: string; weatherSlot: number } {
  const slot = weatherSlotAt(tick, rule);
  const slotStart = slot * rule.weatherSlotTicks;
  const ownerPhase = phaseAt(slotStart, rule);
  const candidates = rule.phases[ownerPhase.phaseIndex]?.weather ?? [];
  if (candidates.length === 0) return { weatherId: "", weatherSlot: slot };

  let totalWeight = 0;
  for (const option of candidates) totalWeight += option.weight;
  const roll = rngFrom(rule.seed ?? 0, "weather", slot).next() * totalWeight;

  let acc = 0;
  for (const option of candidates) {
    acc += option.weight;
    if (roll < acc) return { weatherId: option.id, weatherSlot: slot };
  }
  return { weatherId: candidates[candidates.length - 1].id, weatherSlot: slot };
}

/** 相位修饰数值求值：数值常量原样返回；`{ from, to }` 按进度线性插值。 */
export function resolveModifiers(
  phase: EnvironmentPhase,
  progress: number,
): Record<string, number> {
  const resolved: Record<string, number> = {};
  const modifiers = phase.modifiers;
  if (!modifiers) return resolved;
  for (const [key, spec] of Object.entries(modifiers)) {
    resolved[key] =
      typeof spec === "number" ? spec : spec.from + (spec.to - spec.from) * progress;
  }
  return resolved;
}

/**
 * 从世界当前 tick 派生完整环境视图（纯函数——不读缓存、可离线重算）。
 * 未配置 environment 规则时返回中性视图。
 */
export function environmentAt(world: GameWorld): EnvironmentView {
  const rule = getEnvironmentRule(world);
  if (!rule) return NEUTRAL_ENVIRONMENT;
  const phase = phaseAt(world.time.tick, rule);
  const weather = weatherAt(world.time.tick, rule);
  return {
    ...phase,
    weatherId: weather.weatherId,
    weatherSlot: weather.weatherSlot,
    modifiers: resolveModifiers(rule.phases[phase.phaseIndex], phase.progress),
  };
}
