/**
 * condition：自身是否处于光源照亮范围内。
 * 通过 isPointInLight 判断（燃料耗尽的熄灭光源不发光）；
 * 具体"在光内做什么"由行为树组织决定，框架不识别游戏语义。
 */
import { Transform } from "framework/components";
import type { BtContext } from "framework/ai/btRunner";
import { isPointInLight } from "framework/utils/light";

/**
 * condition：自身是否处于任一有效光源（LightSource）的半径内。
 *
 * 燃料 ≤ 0 的光源视为熄灭（不发光）。供"回避火光"类行为使用——
 * 具体回避语义由行为树组织（如夜间在光内则入睡不攻击），框架不识别。
 */
export function createIsInLightCondition(_args?: Record<string, unknown>): () => boolean {
  return function IsInLight(this: { ctx: BtContext | null }): boolean {
    const ctx = this.ctx;
    if (!ctx) return false;
    return isPointInLight(ctx.world, Transform.x[ctx.self], Transform.y[ctx.self]);
  };
}
