/**
 * 移动方向工具：chase / flee / wander 共用。
 */
import type { MapGrid } from "framework/map/types";

export function normalizeOrFallback(x: number, y: number): { x: number; y: number } {
  const len = Math.hypot(x, y);
  if (len <= 1e-6) return { x: 1, y: 0 };
  return { x: x / len, y: y / len };
}

export interface MapBounds {
  tileW: number;
  tileH: number;
  pixelW: number;
  pixelH: number;
}

/** 地图像素边界；无 grid 时返回 null（节点各自回退到默认速度逻辑）。 */
export function mapPixelBounds(grid?: MapGrid): MapBounds | null {
  if (!grid) return null;
  return {
    tileW: grid.tileWidth,
    tileH: grid.tileHeight,
    pixelW: grid.width * grid.tileWidth,
    pixelH: grid.height * grid.tileHeight,
  };
}

/** 方向向量钳制到地图边界内（碰到边缘时把出界分量反弹为向内的绝对值）。 */
export function clampDirectionToMapBounds(
  x: number,
  y: number,
  dirX: number,
  dirY: number,
  bounds: MapBounds,
): { x: number; y: number } {
  const marginX = bounds.tileW;
  const marginY = bounds.tileH;

  let dx = dirX;
  let dy = dirY;

  if (x < marginX) dx = Math.abs(dx);
  if (x > bounds.pixelW - marginX) dx = -Math.abs(dx);
  if (y < marginY) dy = Math.abs(dy);
  if (y > bounds.pixelH - marginY) dy = -Math.abs(dy);

  return normalizeOrFallback(dx, dy);
}
