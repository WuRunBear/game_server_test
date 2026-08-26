/**
 * 持久化仓储接口——世界快照的存取契约。
 *
 * Slice 5 将旧 PlayerRecord/MapInstanceRecord 窄接口替换为世界级快照：
 * 存档粒度为「完整世界」（实体 + 组件 + world 级状态），由 worldSerializer
 * 产出/消费，仓储层只负责按 id 存取纯 JSON 数据。
 *
 * 实现约定：
 * - saveWorld 幂等（同 id 覆盖）
 * - loadWorld 找不到返回 null
 * - 数据为纯 JSON（可安全 JSON.stringify）
 */

/** 单实体序列化形态：组件名 → 组件值（SoA 为字段值对象，AoS 为完整结构）。 */
export interface SerializedEntity {
  /** 网络稳定标识（NetworkId.value），恢复时原样写回。 */
  networkId: number;
  /** 原型 kind（查 archetype 用，恢复时据此 spawn + 重写组件）。 */
  kind: string;
  /** 组件状态。SoA 组件为 `{ field: value }`；AoS 组件为完整结构（如背包槽位）。 */
  components: Record<string, unknown>;
}

/** 世界快照——一局游戏的可恢复完整状态。 */
export interface WorldRecord {
  /** 存档标识。 */
  id: string;
  /** 存档时刻（Date.now()）。 */
  savedAt: number;
  /** 逻辑帧号（world.time.tick）。 */
  tick: number;
  /** 下一个可用的网络标识（world.nextNetworkId）。 */
  nextNetworkId: number;
  /** world 级昼夜状态（可缺省，缺省时恢复到初始值）。 */
  timeOfDay?: { hour: number; phase: number };
  /**
   * 旧档迁移回退，新档不再作为唯一地图来源——新档每实体的地图归属存于
   * 各实体 components["EntityMap"]，record.mapId 只为旧档（无 EntityMap 组件）
   * 提供回退值（可缺省；缺省时各实体回退世界默认图）。
   */
  mapId?: string;
  /** 存活实体清单。 */
  entities: SerializedEntity[];
}

export interface Repository {
  /** 保存世界快照（幂等：同 id 覆盖，数据须为纯 JSON）。 */
  saveWorld(record: WorldRecord): Promise<void>;
  /** 按 id 读取世界快照；找不到返回 null。 */
  loadWorld(id: string): Promise<WorldRecord | null>;
}
