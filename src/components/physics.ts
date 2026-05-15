export const Velocity = {
  vx: [] as number[],
  vy: [] as number[],
};

export const Acceleration = {
  ax: [] as number[],
  ay: [] as number[],
};

/**
 * Collider 形状类型。
 *
 * 约定：
 * - 数值存储在 Collider.shape 中，便于组件保持 SoA 结构
 */
export const ColliderShape = {
  Circle: 0,
  Box: 1,
} as const;

export const Collider = {
  shape: [] as number[],
  radius: [] as number[],
  halfW: [] as number[],
  halfH: [] as number[],
};
