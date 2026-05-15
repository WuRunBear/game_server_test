/**
 * Size 组件：实体的二维尺寸（宽/高，SoA 结构）。
 *
 * 约定：
 * - w/h 表示实体在世界坐标中的宽高（与 Transform.x/y 同一单位）
 */
export const Size = {
  w: [] as number[],
  h: [] as number[],
};
