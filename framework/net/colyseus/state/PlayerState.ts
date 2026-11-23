/**
 * 玩家网络状态视图（Colyseus Schema 定义）。
 *
 * 一个连接对应一个 PlayerState（RoomState.players 以 sessionId 为 key）。
 * 其中的 visibleEntities 是兴趣裁剪（视野管理）的产物：配置了视野半径时，
 * 服务端只把该玩家视野内的实体写入其可见表，并经 $filter 仅对所属玩家
 * 编码，实现 per-client 差异化同步；未配置时该表为空，实体数据走
 * RoomState.entities 全量广播（旧协议兼容）。
 */
import { MapSchema, Schema, StateView, type, view, $filter } from "@colyseus/schema";

import { EntityState } from "./EntityState";

/**
 * 兴趣管理下的 per-client 可见实体表（MapSchema 子类，仅增加服务端过滤逻辑）。
 *
 * Colyseus 的 RoomState 对房间内所有客户端共享广播；要让「每个客户端只见自己
 * 视野内实体」，需在编码层做 per-client 过滤——本字段声明了 `view: true`（过滤
 * 字段），配合 `$filter`（schema 实例级过滤）实现：
 * - 共享编码通路（view === undefined）：字段不进共享缓存（返回 false），
 *   该字段只走 per-client 编码。
 * - per-client 编码通路（view 已挂 sessionId）：按「所属玩家 sessionId == 客户端
 *   view 上的 sessionId」判定——每个客户端只能收到自己 PlayerState.visibleEntities。
 *
 * 注意：`view: true` 声明的字段树必须经 `StateView.add()` 加入各客户端 view，
 * 否则该树对任何客户端都不可见（见 GameRoom.onJoin 的接线）。
 *
 * 客户端侧协议无感：schema-codegen 仍按 `MapSchema<EntityState>` 生成；
 * 服务端运行时用子类实例提供过滤。
 */
export class VisibleEntities extends MapSchema<EntityState> {
  /** 服务端元数据：所属玩家 sessionId（自定义属性，不参与网络编码）。 */
  ownerSessionId = "";

  /** 仅对所属玩家可见；其余客户端该字段编码为空。 */
  static [$filter](ref: VisibleEntities, _index: number, view: StateView | undefined): boolean {
    if (view === undefined) return false;
    return (view as unknown as { sessionId?: string }).sessionId === ref.ownerSessionId;
  }
}

/**
 * 可同步到客户端的玩家状态（与连接 sessionId 绑定）。
 *
 * 说明：
 * - sessionId 由 Colyseus 分配，用于标识连接
 * - entityId 用于客户端把“玩家”映射到 entities 中的实体状态
 * - visibleEntities 是兴趣管理（视野裁剪）下的 per-client 实体表：
 *   key=NetworkId，只含该玩家视野内的实体，且经 $filter 仅对所属玩家可见。
 *   未启用视野裁剪时为空，实体数据走 RoomState.entities 全量广播。
 */
export class PlayerState extends Schema {
  /**
   * 当前玩家连接的 sessionId。
   */
  @type("string")
  sessionId: string = "";

  /**
   * 该玩家对应的实体网络标识（来自 NetworkId.value）。
   */
  @type("uint32")
  entityId: number = 0;

  /**
   * 该玩家当前所属地图 id（来自仿真快照 playerMaps；无地图时为空串）。
   * 房间级 mapId 已随 RoomState 移除——地图语义按玩家拆分（per-player maps），
   * 客户端据此切换自己的渲染场景。
   */
  @type("string")
  mapId: string = "";

  /**
   * 该玩家视野内可见的实体状态表（key=NetworkId 字符串）。
   *
   * `@view()` 声明该字段为过滤字段：只在 per-client 编码中出现
   * （$filter 判定所属玩家），不进共享缓存。
   */
  @view()
  @type({ map: EntityState })
  visibleEntities: VisibleEntities = new VisibleEntities();

  /**
   * 该玩家当前所属地图的 `MapGeometry.version` 内容指纹（CC-05）。
   *
   * 每 tick 由 GameRoom.applySnapshot 从仿真层只读访问器写入；地图运行期
   * 写回（terrainWriteback）后指纹即变化，客户端据此拉取 `/maps/runtime`
   * 增量。换图后本字段立即反映新图版本。字段追加在末尾，已有字段索引不变；
   * 无地图/旧仿真端口时为空串。
   */
  @type("string")
  mapVersion: string = "";

  /**
   * 玩家展示名（CC-10；客户端自报，服务端不校验真实性）。
   *
   * 每 tick 由 GameRoom.applySnapshot 从仿真层 `getPlayerProfile(entityId)`
   * 写入；断线保留玩家不在 clients 中，本字段随其 PlayerState 删除，重连后
   * 由新 PlayerState 取回。空串 = 未设置，客户端回退「玩家」/networkId。
   * 追加在 mapVersion 之后，已有字段索引不变。
   */
  @type("string")
  displayName: string = "";

  /**
   * 角色/外观预设 id（CC-10；不透明字符串，框架不解释）。
   *
   * 空串 = 未设置。追加在 displayName 之后，已有字段索引不变。
   */
  @type("string")
  characterId: string = "";

  /**
   * 不透明外观 JSON 字符串（CC-10；框架原样保存/下发，客户端自行解析）。
   *
   * 空串 = 未设置。追加在 characterId 之后，已有字段索引不变。
   */
  @type("string")
  appearance: string = "";

  /**
   * 该会话**已接受**的最大输入 seq（CC-14 输入 ack）。
   *
   * **语义**（与 GameSimulation.submitInput 的入口判定严格一致）：
   * - 客户端输入按 seq 去重；只有 `seq > 已记录` 且通过移动校验才被接受；
   * - 正常递增输入 → 本字段跟随最新已接受 seq（服务端已“消化到这一条”）；
   * - 超速/非法输入被拒 → **不推进**（客户端无法靠重发绕过）；
   * - 乱序/重复（seq ≤ 已记录）→ 不推进；
   * - 0 = 尚无已接受输入（新连接；重连复用实体后从新会话的 ack 重新起算）。
   *
   * GameRoom 每 tick 从仿真层只读查询写入；客户端据此做服务端对账/预测回滚
   * （`RoomState.tick` 与 `serverTimeMs` 提供对应逻辑时间）。该字段是“已接受”
   * 而非“已产生可见效果”的语义，客户端应与状态快照同一 tick 消费。
   *
   * 追加在 `appearance` 之后，已有字段索引不变。
   */
  @type("uint32")
  lastProcessedSeq: number = 0;
}
