/**
 * 把毫秒值限制为非负且为有限数。
 *
 * @param value 输入毫秒数
 * @returns 非负毫秒数；非有限数会被当作 0
 */
export function clampMs(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, value);
}
