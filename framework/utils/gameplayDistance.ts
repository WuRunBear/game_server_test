/**
 * gameplay 距离/可达性统一助手（framework/utils/gameplayDistance.ts）。
 *
 * v2 地图切片 6、前置修正 4：combat/perception/interaction/placeable/deconstruct/
 * crafting/dialogue/inventory/projectile 九处消费方原先各自散写 `Math.hypot`
 * 距离检查；加层（level 维度）后这些散装检查会对异层实体「悄悄放行」——
 * 本模块把它们收敛为**单一判定源**，全部消费方强制经此判定。
 *
 * 判定语义（v1）：
 * - **同层欧氏距离**：两端层号相同才算可达，距离为平面欧氏距离（像素）；
 * - 异层恒不可达（跨层交战/感知/交互只允许经连接器的移动语义，距离检查
 *   一律不放行——跨层 LOS/命中策略留给后续切片在预留位上扩展）；
 * - **LOS 预留位**：可选回调，缺省视为无遮挡（恒可视）。遮挡物挡视线的
 *   voxel DDA（设计文档 §5）落地后由调用方注入，本助手不改签名。
 *
 * 纯函数、零副作用、零 ECS 依赖：层号与坐标由调用方解析（多数消费方已
 * 就近持有 entityMapOf/entityLevelOf）。
 */

/** gameplay 可达性判定的一端（实体或虚拟点位）。 */
export interface GameplayEndpoint {
  /** 世界坐标 x（像素）。 */
  x: number;
  /** 世界坐标 y（像素）。 */
  y: number;
  /** 离散层号（EntityLevel 语义，无条目按 0）。 */
  level: number;
}

/**
 * 视线检查回调（预留位）：两端同层且距离达标后追加调用；返回 false 表示
 * 被遮挡、不可达。参数为两端坐标与共有层号。缺省（未传）视为无遮挡。
 */
export type GameplayLosCheck = (
  ax: number,
  ay: number,
  bx: number,
  by: number,
  level: number,
) => boolean;

/** 同层平面欧氏距离；两端层号不同时返回 undefined（异层不可达，无距离意义）。 */
export function sameLevelDistance(
  ax: number,
  ay: number,
  aLevel: number,
  bx: number,
  by: number,
  bLevel: number,
): number | undefined {
  if (aLevel !== bLevel) return undefined;
  return Math.hypot(ax - bx, ay - by);
}

/**
 * gameplay 可达判定（统一距离检查的唯一实现）：
 * 同层 + 平面欧氏距离 ≤ range + 可选 LOS 通过。
 *
 * @param a 起点端（实体位置或虚拟点位）
 * @param b 终点端（实体位置或虚拟点位）
 * @param range 可达半径（像素，≥ 0；恰等于 range 时可达——与各消费方原
 *   `dist > range → 拒` 的边界语义一致）
 * @param los 可选视线检查（预留位；缺省无遮挡）
 * @returns 是否可达
 */
export function isGameplayReachable(
  a: GameplayEndpoint,
  b: GameplayEndpoint,
  range: number,
  los?: GameplayLosCheck,
): boolean {
  const dist = sameLevelDistance(a.x, a.y, a.level, b.x, b.y, b.level);
  if (dist === undefined || dist > range) return false;
  if (los && !los(a.x, a.y, b.x, b.y, a.level)) return false;
  return true;
}
