/**
 * action：给自身施加一条属性修饰符（阶段效果的通用一次性入口）。
 *
 * 复用 Modifiers/computeStat 的既有语义，不另造状态机：
 * - args：stat（statKey，必填）、mul/add/bool（至少其一）、
 *   durationTicks（>0 时按当前 tick 换算失效时刻）、source（幂等键）。
 * - **幂等**：同一 `source + stat` 已有生效条目时不重复追加（子树每 tick
 *   执行本节点也只施加一次）；带 durationTicks 的条目到期后再次执行会重新
 *   施加（用于阶段期间定期续期）。
 *
 * 返回 SUCCEEDED（可继续同 tick 的后续子树节点）；参数非法返回 FAILED。
 */
import { State } from "mistreevous";

import type { BtContext } from "framework/ai/btRunner";
import {
  Modifiers,
  addModifier,
  type ModifierEntry,
} from "framework/simulation/modifiers/modifiers";

/** 解析布尔/数值参数（未声明为 undefined）。 */
function optionalNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/**
 * action：施加带来源标识的状态修饰符（幂等）。
 *
 * 同一来源的条目在生效期内只存在一条；配置 durationTicks 时，到期后由
 * 下一次执行续期。source 缺省 `bt-status`（同一次工厂实例内固定）。
 */
export function createApplyStatusAction(args?: Record<string, unknown>): () => State {
  const stat = typeof args?.stat === "string" ? args.stat : "";
  const source = typeof args?.source === "string" && args.source ? args.source : "bt-status";
  const mul = optionalNumber(args?.mul);
  const add = optionalNumber(args?.add);
  const bool = typeof args?.bool === "boolean" ? args.bool : undefined;
  const durationTicks = Math.max(0, Math.floor(optionalNumber(args?.durationTicks) ?? 0));
  const hasValue = mul !== undefined || add !== undefined || bool !== undefined;

  return function ApplyStatus(this: { ctx: BtContext | null }): State {
    const ctx = this.ctx;
    if (!ctx || !stat || !hasValue) return State.FAILED;

    const now = ctx.world.time.tick;
    const entries = Modifiers[ctx.self]?.[stat] ?? [];
    const active = entries.some(
      (entry) => entry.source === source && (entry.expiresTick === undefined || now < entry.expiresTick),
    );
    if (active) return State.SUCCEEDED;

    const entry: ModifierEntry = { source };
    if (mul !== undefined) entry.mul = mul;
    if (add !== undefined) entry.add = add;
    if (bool !== undefined) entry.bool = bool;
    if (durationTicks > 0) entry.expiresTick = now + durationTicks;
    addModifier(ctx.world, ctx.self, stat, entry);
    return State.SUCCEEDED;
  };
}
