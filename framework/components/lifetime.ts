/**
 * Lifetime 组件：实体持久寿命（SoA，绝对到期 tick，**入档**）。
 *
 * 与运行时一次性定时器（ExpiresAt）的区别：
 * - ExpiresAt 是瞬态效果引用（重启即失效、不入档）；
 * - Lifetime 是**正式世界状态**——绝对到期 tick 随实体入档，重启后仍按原
 *   tick 到期销毁，不依赖运行时 timer 重建。
 *
 * 挂载方：死亡容器（deathSystem 按 rules 的 ttlTicks 写入；0 = 不挂载 =
 * 永不过期）。清扫方：timerSystem 每 tick 检查 `tick ≥ expiresTick` → 走
 * destroyEntity 统一出口删除实体（AoS 内容物一并清理）。
 *
 * 框架通用机制：任何需要"跨重启绝对寿命"的实体都可挂载；字段只有 tick，
 * 不含任何游戏语义。
 */
import { defineComponent, Types } from "bitecs/legacy";

export const Lifetime = defineComponent({
  /** 绝对到期 tick（world.time.tick ≥ 该值时销毁）。 */
  expiresTick: Types.f64,
});
