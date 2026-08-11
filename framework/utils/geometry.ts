/**
 * 几何判定工具（游戏无关）。
 *
 * 当前提供「射线法（ray casting）判断点是否落在多边形内部」，
 * 供区域（zone）等通用几何需求使用。
 */

/**
 * 射线法（ray casting）判断点是否在多边形内部。
 *
 * 原理：从该点向任意方向作水平射线，统计与多边形边的交点个数，
 * 奇数个交点则在内部，偶数个则在外部（含顶点/边界的标准处理）。
 *
 * @param px 点的 x 坐标
 * @param py 点的 y 坐标
 * @param polygon 多边形顶点数组（按顺序，至少 3 个点；不足则视为无法包含，返回 false）
 */
export function pointInPolygon(
  px: number,
  py: number,
  polygon: ReadonlyArray<{ x: number; y: number }>,
): boolean {
  if (polygon.length < 3) return false;

  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const xi = polygon[i].x;
    const yi = polygon[i].y;
    const xj = polygon[j].x;
    const yj = polygon[j].y;

    const intersect =
      yi > py !== yj > py &&
      px < ((xj - xi) * (py - yi)) / (yj - yi) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}