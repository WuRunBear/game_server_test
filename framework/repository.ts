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
import type { SerializedMapGeometry } from "map/geometry/snapshot";
import type { SerializedMapDelta } from "map/geometry/delta";

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
   * 地图快照条目表（key = 地图 registry key；maps 与实体同盘）。
   *
   * 地形写回复切片起为**双形态并集**（SerializedMapEntry）：
   * - 全量（SerializedMapGeometry，无 format 字段）：现行格式——出厂底板未知
   *   （全量回填）、零修改、修改数超阈值的图走此形态；
   * - 增量（SerializedMapDelta，format:"delta"）：稀疏终态修改项 + 出厂底板
   *   指纹——底板内容由读档路径按 seed 重算后叠加，不重复落盘。
   *
   * 读档按 format 判别（bootMaps）；serializeWorld 对每张已构建图恒产出条目
   * （键集 = 已构建图键集，boot 的「快照缺 key = 配置新增图」分支语义不变）。
   * 两种形态互不与更旧存档兼容（项目立场：旧档直接废弃，不迁移）。
   */
  maps?: Record<string, SerializedMapEntry>;
  /**
   * 每图随机种子表（key = 地图 registry key；新档随机种子入口，§5.4 修复
   * 项 4）。无档启动时配置缺省 seed 的图随机生成并随首存快照固化；读档
   * 路径据此恢复演化选点流（快照回填不重建几何，但每 tick/离线补差的
   * evolve 流必须与存档世界一致）。缺省视为旧格式存档（回退配置 seed）。
   */
  mapSeeds?: Record<string, number>;
  /** 存活实体清单。 */
  entities: SerializedEntity[];
}

export interface Repository {
  /** 保存世界快照（幂等：同 id 覆盖，数据须为纯 JSON）。 */
  saveWorld(record: WorldRecord): Promise<void>;
  /** 按 id 读取世界快照；找不到返回 null。 */
  loadWorld(id: string): Promise<WorldRecord | null>;
}

/** 地图快照条目：全量（现行 SerializedMapGeometry）或增量（format:"delta"）。 */
export type SerializedMapEntry = SerializedMapGeometry | SerializedMapDelta;
