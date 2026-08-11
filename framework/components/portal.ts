/**
 * Portal 组件：场景传送点（AoS 结构）。
 *
 * 挂载该组件的实体为传送门：玩家与其 AABB 相交时触发场景切换
 * （见 portalSystem）——world.map 切换为 targetMap（引用 maps/registry.json
 * 的地图 id），玩家传送至目标坐标 (x, y)。
 *
 * targetMap 为字符串引用，故组件为 AoS 形态：由 spawn 的 AoS 初始化钩子
 * 按 archetype 配置写入；netSync 经 AoS 同步适配器展平（目标坐标 numbers +
 * 地图 id string）。具体地图 id 语义由 game/ 配置声明。
 */
export interface PortalState {
  /** 目标地图 id（maps/registry.json 的 maps 键）。 */
  targetMap: string;
  /** 传送目标 X（世界坐标）。 */
  x: number;
  /** 传送目标 Y（世界坐标）。 */
  y: number;
}

/** AoS 存储：普通 JS 数组按 eid 索引（非 bitecs 组件，不能 addComponent/query）。 */
export const Portal = [] as (PortalState | undefined)[];

interface PortalConfig {
  targetMap?: string;
  x?: number;
  y?: number;
}

/** AoS 初始化钩子。 */
export function initPortal(
  _world: unknown,
  eid: number,
  config: unknown,
): void {
  const cfg = (config ?? {}) as PortalConfig;
  Portal[eid] = {
    targetMap: String(cfg.targetMap ?? ""),
    x: typeof cfg.x === "number" ? cfg.x : 0,
    y: typeof cfg.y === "number" ? cfg.y : 0,
  };
}
