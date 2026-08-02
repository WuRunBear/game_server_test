/**
 * 射线法（ray casting）判断点是否在多边形内部。
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