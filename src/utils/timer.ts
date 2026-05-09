export function clampMs(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, value);
}
