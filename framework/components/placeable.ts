import { defineComponent, Types } from "bitecs/legacy";

import type { ArchetypeSpec } from "framework/entities/archetypeRegistry";

/**
 * Placeable 组件：玩家可放置物标记（SoA 结构）。
 *
 * 挂载该组件的实体可被玩家经 place 命令放置（见 placeableSystem）：
 * - footprintW/footprintH：放置时的占位尺寸（像素），放置校验（重叠/地图阻挡）用
 * - canCollide：放置后是否参与碰撞（1=是，0=否）
 * - ownerNetworkId：放置者 networkId（0=无主，如地图静态布置的放置物）；
 *   deconstruct（拆除）仅放置者可拆
 */
export const Placeable = defineComponent({
  /** 占位宽度（像素）。 */
  footprintW: Types.f32,
  /** 占位高度（像素）。 */
  footprintH: Types.f32,
  /** 放置后是否参与碰撞（1=是，0=否）。 */
  canCollide: Types.ui8,
  /** 放置者网络标识（0=无主/世界物）。 */
  ownerNetworkId: Types.ui32,
});

/** 占位尺寸兜底值（像素）：原型未声明 Placeable 时使用。 */
export const FALLBACK_FOOTPRINT = 16;

/**
 * 目标 archetype 的占位尺寸（像素）：Placeable 组件配置优先，未声明回退
 * 兜底值。
 *
 * 放置链（placeableSystem 的重叠/阻挡校验）与演化链（map/runtime/evolveDeps
 * 的 footprint 占用登记/canPlace）共用本函数——全框架只有这一套占位尺寸语义。
 * 读的是原型**规格声明值**（初始配置），非运行时 SoA 数组。
 *
 * 刻意**不含 Size 回退**：Size 是碰撞包围盒语义（移动实体/传送门的物理尺寸），
 * 不是占位格语义——按 Size 展开占用会把贴墙传送门（32×32 落在窄室内）与
 * 窄通道里的 2×1 实体判成非法落位（真实缺陷：回程传送门再也放不下）。
 * 占位声明归 Placeable；可放置原型必须显式声明 Placeable.footprintW/H
 * （未声明按 16×16 单格处理）。
 */
export function footprintOf(archetype: ArchetypeSpec): { w: number; h: number } {
  const placeable = archetype.components["Placeable"] as
    | { footprintW?: number; footprintH?: number }
    | undefined;
  return {
    w: placeable?.footprintW ?? FALLBACK_FOOTPRINT,
    h: placeable?.footprintH ?? FALLBACK_FOOTPRINT,
  };
}
