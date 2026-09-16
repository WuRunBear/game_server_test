import { defineComponent, Types } from "bitecs/legacy";

/**
 * Projectile 组件：直线运动投射物（SoA 结构）。
 *
 * 最小运动承载：owner（来源实体）+ 速度向量 + 寿命 + 接触半径。
 * 运动与命中判定归 projectileSystem（framework/systems/gameplay）——
 * 命中只发 on-contact 事件（类型化事件总线），不接伤害闭环。
 * 组件为运行时瞬态（worldSerializer 跳过清单：owner eid 跨存档失效）。
 */
export const Projectile = defineComponent({
  /** 来源实体 eid（投射物主人；接触判定跳过）。 */
  owner: Types.i32,
  /** 水平速度（像素/秒）。 */
  vx: Types.f32,
  /** 垂直速度（像素/秒）。 */
  vy: Types.f32,
  /** 剩余寿命（毫秒），归零销毁。 */
  lifeMs: Types.f32,
  /** 接触判定半径（像素），与目标距离 <= 半径 + 系统垫片即接触。 */
  radius: Types.f32,
});
