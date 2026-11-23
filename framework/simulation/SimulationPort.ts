/**
 * 仿真端口接口——传输层与仿真层之间的解耦契约（详见下方接口注释）。
 * 具体实现见 GameSimulation.ts；传输层只依赖本接口，不依赖任何 ECS 符号。
 */
import type {
  PlayerInput, PlayerJoinResult, PlayerJoinOptions, PlayerProfileView, TickResult, DebugSnapshotOptions, PlayerCommand,
  CommandResult,
} from "./types";
import type { SerializedMapGeometry } from "map/geometry/snapshot";
import type { MapCollisionView, MapRenderView } from "map/clientView";
import type { TerrainModificationSet } from "map/runtime/terrainWriteback";
import type { MapConfig } from "framework/config/schema/MapRegistrySchema";
import type {
  AchievementsResponse,
  AffordanceQuery,
  AffordancesResponse,
  CraftPreview,
  CraftQuery,
  PlacePreview,
  PlaceQuery,
  QuestsResponse,
  QueryResult,
  ShopQuery,
  ShopResponse,
  SkillsResponse,
} from "framework/query";

/**
 * 仿真端口——传输层与仿真层之间的双向协议（接口）。
 *
 * ## 为什么需要这个接口？
 *
 * 重构前，GameRoom 直接 import bitecs、直接读 SoA 数组、直接调 spawnEntity——
 * 传输层和仿真层深度耦合，换 ECS 或换传输都得改 GameRoom。
 *
 * SimulationPort 把仿真操作抽象成一组合约接口：
 * - 传输层（GameRoom / HeadlessHost）只通过这个接口驱动仿真
 * - 传输层不知道 ECS 的存在，不 import 任何 bitecs 符号
 * - 仿真层（GameSimulation）实现这个接口，内部随便用什么技术
 *
 * ## 方法分为两类
 *
 * **驱动类**（每帧调用）：
 * - tick()          → 推进仿真
 * - submitInput()   → 提交玩家输入（tick 时消费）
 * - getDebugSnapshot() → 获取调试数据
 *
 * **生命周期类**（事件触发）：
 * - addPlayer()     → 玩家连入
 * - removePlayer()  → 玩家断开
 */
export interface SimulationPort {
  /**
   * 推进一个逻辑帧。
   *
   * 内部执行顺序：应用玩家输入 → 运行 ECS 系统 → 构建快照 → 记录性能指标。
   * 返回 TickResult，包含快照和耗时数据。
   *
   * @param dtMs 本帧的时间步长（毫秒）。通常等于 1000 / tickRate
   * @returns 本帧结果（快照 + 性能指标）
   */
  tick(dtMs: number): TickResult;

  /**
   * 玩家加入时调用。
   *
   * 内部创建玩家实体（spawn "player" archetype）、分配 NetworkId，
   * 并建立 sessionId → eid 的映射，后续 submitInput 通过 sessionId 找到正确实体。
   *
   * 复用：断线保留实体（按 options.networkId 严格匹配且未到期，清除保留
   * 标记）→ 否则新生成。不做 orphan FIFO 兜底（避免把旧实体绑给错误客户端）。
   *
   * @param sessionId Colyseus 连接标识
   * @param options 可选加入参数（重连复用保留实体的匹配键）
   * @returns 玩家实体的 networkId，传输层写入 PlayerState.entityId
   */
  addPlayer(sessionId: string, options?: PlayerJoinOptions): PlayerJoinResult;

  /**
   * 玩家离开时调用。
   *
   * 内部删除玩家实体、清理所有与该 sessionId 关联的缓存
   * （输入缓存、seq 去重缓存、eid 映射）。
   *
   * @param sessionId Colyseus 连接标识
   */
  removePlayer(sessionId: string): void;

  /**
   * 取玩家展示资料（只读；CC-10）。
   *
   * GameRoom 每 tick 写入该玩家自己的 `PlayerState.displayName/characterId/
   * appearance`。实体不存在时返回 undefined；资料缺失（旧档）时返回空串填充
   * 的 DTO，绝不让传输层判空崩溃。
   *
   * @param networkId 玩家实体的稳定网络标识（协议层 id，不是 eid）
   */
  getPlayerProfile?(networkId: number): PlayerProfileView | undefined;

  /**
   * 提交一条客户端输入。
   *
   * 输入不会立即生效，而是缓存起来，在下一次 tick() 时统一应用。
   * 内部做了 seq 去重：只有 seq > 已记录的最新 seq 的消息才会被接受。
   *
   * @param sessionId Colyseus 连接标识
   * @param input 输入数据
   */
  submitInput(sessionId: string, input: PlayerInput): void;

  /**
   * 提交一条玩家命令（离散动作，非逐帧）。
   *
   * 立即执行服务端权威变更（如背包原子），不入帧缓存、不做 seq 去重。
   * 返回统一命令回执（成功也回执）；未知命令类型返回
   * `{ ok: false, code: "invalid" }`。
   *
   * @param sessionId Colyseus 连接标识
   * @param command 命令数据
   */
  submitCommand(sessionId: string, command: PlayerCommand): CommandResult;

  /**
   * 立即落盘并等待写入完成（无停机存档）。
   *
   * 供传输层 `onDispose` 与进程信号停机路径调用；未接仓储/存档 id 时
   * 返回 false（no-op）。可重复调用（幂等）。
   *
   * @param reason 存档触发原因（日志定位用）
   * @returns 是否成功落盘
   */
  flushSave(reason?: string): Promise<boolean>;

  /**
   * 获取当前帧的碰撞调试快照。
   *
   * 返回类型是 unknown，因为传输层不需要理解快照结构——
   * 它只是把数据原样转发给客户端。
   *
   * @param options 控制是否包含地图碰撞体等
   * @returns 可序列化的调试数据
   */
  getDebugSnapshot(options?: DebugSnapshotOptions): unknown;

  /**
   * 取某张图的**实时几何快照**（含运行期写回后的内容）。
   *
   * 与「按配置重建几何」不同：这里返回的是世界当前持有的几何——野火焦土等
   * 运行期写回已反映在 tiles/walkable/level 上，version 指纹随之变化。
   * 图不存在（未构建）时返回 undefined（调用方回退到配置重建视图）。
   *
   * @param mapId 地图 registry key
   * @returns 几何快照；该图不在世界中时为 undefined
   */
  getMapGeometry?(mapId: string): SerializedMapGeometry | undefined;

  /**
   * 取某图当前的内容指纹（`MapGeometry.version`；CC-05）。
   *
   * 只读访问器：GameRoom 每 tick 写入 `PlayerState.mapVersion`，客户端据此
   * 判断是否需要拉取 `/maps/runtime?sinceVersion=`。图不存在/未构建时返回
   * 空串（不抛错）。
   *
   * @param mapId 地图 registry key
   */
  getMapVersion?(mapId: string): string;

  /**
   * 取某图当前 tick 的有效地面视图（`/maps/render` 数据源；只读、无副作用）。
   *
   * @param mapId 地图 registry key
   * @returns 视图；图不存在时为 undefined
   */
  getMapRenderView?(mapId: string): MapRenderView | undefined;

  /**
   * 取某图某层的正式碰撞视图（`/maps/collision` 数据源；只读、无副作用）。
   *
   * @param mapId 地图 registry key
   * @param level 查询层号
   * @returns 视图；图不存在时为 undefined
   */
  getMapCollisionView?(mapId: string, level: number): MapCollisionView | undefined;

  /**
   * 计算「从某已知版本到当前」的地图增量（`/maps/runtime` 增量数据源）。
   *
   * 只识别出厂基线版本或本进程写回历史版本；不可识别时返回 undefined，
   * 调用方回退全量响应（不做 404）。
   *
   * @param mapId 地图 registry key
   * @param sinceVersion 客户端持有的已知版本
   */
  getMapRuntimeDelta?(mapId: string, sinceVersion: string): TerrainModificationSet | undefined;

  /**
   * 地图生成配置清单（key + 生成管道）——供传输层描述地图元信息（如来源标识）。
   *
   * @returns 全部配置图（顺序 = 配置声明序）
   */
  getMapConfigs?(): MapConfig[];

  /* ------------------------------------------------------------------ */
  /* CC-06 只读查询面（可选实现；不推进 tick、不写状态）                    */
  /* ------------------------------------------------------------------ */

  /** 交互候选 + 动作可用性（`GET /query/affordances`）。 */
  getQueryAffordances?(query: AffordanceQuery): QueryResult<AffordancesResponse>;

  /** 放置干跑/占用预览（`POST /query/place`）。 */
  getQueryPlace?(query: PlaceQuery): QueryResult<PlacePreview>;

  /** 合成干跑（`POST /query/craft`）。 */
  getQueryCraft?(query: CraftQuery): QueryResult<CraftPreview>;

  /** 商店货架/库存/实价（`GET /query/shop`）。 */
  getQueryShop?(query: ShopQuery): QueryResult<ShopResponse>;

  /** 玩家任务定义 + 进度（`GET /query/quests`）。 */
  getQueryQuests?(playerNetworkId: number): QueryResult<QuestsResponse>;

  /** 成就定义 + 解锁状态（`GET /query/achievements`）。 */
  getQueryAchievements?(playerNetworkId: number): QueryResult<AchievementsResponse>;

  /** 技能曲线 + 玩家进度（`GET /query/skills`）。 */
  getQuerySkills?(playerNetworkId: number): QueryResult<SkillsResponse>;

  /**
   * 调试用：写回某图单格地面语义（terrainWriteback 的唯一合法入口）。
   *
   * 供「/maps 端点读 live 几何」的验证场景使用（写回后 version/tiles 变化）。
   *
   * @param mapId 地图 registry key
   * @param tileIndex tile 线性索引（行主序）
   * @param semanticId 地面语义 id（0-255）
   * @returns 是否真的改动了内容（同值写回为 false）
   */
  debugSetGround?(mapId: string, tileIndex: number, semanticId: number): boolean;
}
