/**
 * condition：自身生命值比例是否低于给定阈值（Boss/精英阶段切换的通用条件）。
 *
 * 参数来源（二选一，`arg` 优先）：
 * - 带参节点名形态 `HealthBelow:0.5` —— 注册表把冒号后的字符串放进 `args.arg`；
 * - 普通 args 形态 `{ "ratio": 0.5 }`。
 *
 * 语义：`Health.current / Health.max < ratio`（严格小于）。无 Health 组件、
 * max ≤ 0 或阈值非法时返回 false（配置错误不崩 tick）。
 */
import { hasComponent } from "bitecs";

import { Health } from "framework/components/combat";
import type { BtContext } from "framework/ai/btRunner";

/** 从工厂参数解析阈值（`arg` 优先，回退 `ratio`）。 */
function ratioOf(args?: Record<string, unknown>): number {
  const raw = args?.arg ?? args?.ratio;
  return typeof raw === "number" ? raw : Number(raw);
}

/**
 * condition：生命值比例低于阈值。
 *
 * 典型用法：selector 的两个子树分别以 `HealthBelow:0.5` 与默认路径区分
 * 阶段行为；阶段差异由子树内的 action 组合/参数决定。
 */
export function createHealthBelowCondition(args?: Record<string, unknown>): () => boolean {
  const ratio = ratioOf(args);
  return function HealthBelow(this: { ctx: BtContext | null }): boolean {
    const ctx = this.ctx;
    if (!ctx) return false;
    if (!Number.isFinite(ratio) || ratio <= 0) return false;
    if (!hasComponent(ctx.world, ctx.self, Health)) return false;
    const max = Health.max[ctx.self] ?? 0;
    if (!(max > 0)) return false;
    const current = Health.current[ctx.self] ?? 0;
    return current / max < ratio;
  };
}
