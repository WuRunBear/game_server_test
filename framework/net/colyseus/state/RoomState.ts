/**
 * 单房间可同步状态视图（Colyseus Schema 定义）。
 *
 * RoomState 不是 ECS 世界本身，只是每 tick 从仿真快照派生的只读视图：
 * GameRoom 每帧把 TickSnapshot 映射到本 Schema，Colyseus 自动 diff 后
 * 增量推送给房间内客户端（服务端权威，客户端不做逻辑）。
 * players 以 sessionId 为 key，与 ECS 内部 eid 无关。
 * 地图/实体数据已按玩家拆分：地图 id 在 PlayerState.mapId（per-player maps），
 * 实体同步恒走 per-client 可见表（PlayerState.visibleEntities）。
 */
import { MapSchema, Schema, StateView, type, view, $filter } from "@colyseus/schema";

import { PlayerState } from "./PlayerState";

/**
 * 报价摘要表（RoomState.offers 的容器）——按会话相关方做 per-client 可见性裁剪。
 *
 * 语义：
 * - key = 报价会话 id（字符串形式）；value = 条款摘要 JSON 字符串
 *   （形如 `{"from":<networkId>,"to":<networkId>,"give":[["<kind>",<count>]],
 *   "take":[["<kind>",<count>]]}`，from/to 为参与方 networkId，视角以发起方
 *   为基准）；
 * - **非参与玩家看不到该条**：条目按「本连接是否为该报价的参与方」逐条过滤
 *   （`$filter` 静态钩子 + 房间侧维护的「会话 → 可见 sessionId 集合」）。
 *
 * 过滤机制与 PlayerState.visibleEntities 同源（Colyseus 的 `@view()` 过滤字段）：
 * - `@view()` 声明的字段不进共享缓存，只走 per-client 编码；
 * - `$filter` 在 per-client 编码时逐条询问「这条对该连接可见吗」。
 *
 * 与 visibleEntities 的差异：visibleEntities 是**每个玩家一份**表（过滤在
 * 表实例级），本表是**房间一份**表（过滤在条目级）——因此可见性集合由房间
 * 侧按「参与方 networkId → sessionId」换算后写入本表。
 */
export class OfferSummaries extends MapSchema<string> {
  /**
   * 报价会话 id → 可见该条的 sessionId 集合（服务端按参与方维护）。
   *
   * 键为 offerId 字符串；值为可见 sessionId 集合（空集 = 谁都看不到）。
   */
  visibleSessionsByOffer = new Map<string, Set<string>>();

  /**
   * 该报价条目是否对给定连接可见。
   *
   * @param offerId 报价会话 id（字符串）
   * @param sessionId 连接 sessionId
   */
  isVisibleTo(offerId: string, sessionId: string): boolean {
    return this.visibleSessionsByOffer.get(offerId)?.has(sessionId) ?? false;
  }

  /**
   * 覆盖某报价的可见连接集合（房间侧每帧按最新参与方重算）。
   */
  setVisibleSessions(offerId: string, sessionIds: Iterable<string>): void {
    this.visibleSessionsByOffer.set(offerId, new Set(sessionIds));
  }

  /**
   * 追加一个可见连接（不覆盖既有集合）。
   *
   * 用途：新连接加入时立即登记其可见条目——否则该连接的**初始全量状态**
   * 里看不到既有条目（条目的 ADD 操作早于其加入，已在其他广播中编码过）。
   */
  addVisibleSession(offerId: string, sessionId: string): void {
    let sessions = this.visibleSessionsByOffer.get(offerId);
    if (!sessions) {
      sessions = new Set<string>();
      this.visibleSessionsByOffer.set(offerId, sessions);
    }
    sessions.add(sessionId);
  }

  /** 移除某报价的可见性登记（报价结束/条目删除时调用）。 */
  clearVisibleSessions(offerId: string): void {
    this.visibleSessionsByOffer.delete(offerId);
  }

  /**
   * 逐条过滤钩子（Colyseus per-client 编码时调用）。
   *
   * - 无 view（共享编码通路）→ false：该表只走 per-client 通路（不落共享缓存）；
   * - 有 view → 按「该条目对该 sessionId 是否可见」判定。
   */
  static [$filter](ref: OfferSummaries, index: number, view: StateView | undefined): boolean {
    if (!view) return false;
    const sessionId = (view as unknown as { sessionId?: string }).sessionId;
    if (!sessionId) return false;
    const offerId = ref.getIndex(index);
    if (offerId === undefined) return false;
    return ref.isVisibleTo(offerId, sessionId);
  }
}

/**
 * 单房间的可同步状态（客户端通过 Colyseus 自动接收增量更新）。
 *
 * 约定：
 * - tick 为逻辑帧号（与 ECS world.time.tick 对齐）
 * - players 用 sessionId 做 key，便于客户端识别“自己是谁”
 * - 地图 id 与实体同步均为 per-player：PlayerState.mapId / visibleEntities
 */
export class RoomState extends Schema {
  /**
   * 当前逻辑帧号。
   */
  @type("uint32")
  tick: number = 0;

  /**
   * world 级昼夜小时（0-24，来自仿真快照的 timeOfDay.hour）。
   */
  @type("float64")
  hour: number = 8;

  /**
   * world 级昼夜相位（0=白天，1=夜晚，来自仿真快照的 timeOfDay.phase）。
   */
  @type("uint8")
  phase: number = 0;

  /**
   * 房间内玩家列表（key=sessionId）。
   */
  @type({ map: PlayerState })
  players: MapSchema<PlayerState> = new MapSchema<PlayerState>();

  /**
   * 当前天气 id（来自环境派生：environmentAt(world).weatherId）。
   *
   * 天气 id 是**配置字符串**（由 game/ 的环境规则定义），框架只做透传，
   * 不解释其含义；无环境规则时为空串。
   */
  @type("string")
  weatherId: string = "";

  /**
   * 当前相位 id（来自环境派生：environmentAt(world).phaseId）。
   *
   * 相位 id 同样是配置字符串（框架不解释语义）；无环境规则时为空串。
   */
  @type("string")
  phaseId: string = "";

  /**
   * 当前相位内进度 [0,1)（来自环境派生：environmentAt(world).progress）。
   */
  @type("number")
  phaseProgress: number = 0;

  /**
   * 进行中的报价摘要表（key=报价会话 id 字符串，value=摘要 JSON 字符串）。
   *
   * 逐条按参与方过滤：只有报价的发起方/接收方能看到该条，其他玩家看不到。
   */
  @view()
  @type({ map: "string" })
  offers: OfferSummaries = new OfferSummaries();

  /**
   * 逻辑服务器时间（毫秒，CC-14）= `tick × fixedDtMs`。
   *
   * **语义**：
   * - 与 `tick` 是同一逻辑时钟的两种单位（`serverTimeMs = tick * fixedDtMs`），
   *   由 GameRoom 在 applySnapshot 中写入仿真层的世界 tick；
   * - **不是墙钟时间**：不读 `Date.now()`、不含真实流逝的停顿/抖动。客户端用
   *   它把自己的插值/对账时钟对齐到服务端逻辑时间轴；需要秒数时按相邻两次
   *   `serverTimeMs` 的差推算 tick 频率，不要和本地墙钟混用；
   * - 固定步长恒定（如 20tps → 50ms/tick），客户端可安全做 `tick*step` 外推。
   *
   * 追加在 `offers` 之后，已有字段索引不变；默认 0（尚无 tick）。
   */
  @type("float64")
  serverTimeMs: number = 0;

  /**
   * 24 小时日计数（CC-12，来自 daynight 规则）。
   *
   * **语义**：tick 0 / hour=8 为第 0 天，每跨午夜（24h 回绕）+1；第 0 天只有
   * 8→24 时的 16 小时，之后每天 24 小时。**不是** `phaseId` 所属环境相位
   * 程序的周期索引（`phaseAt().dayIndex`）——两者周期可以完全不同。
   *
   * 追加在 `serverTimeMs` 之后，已有字段索引不变；无 daynight 规则时恒 0。
   */
  @type("uint32")
  dayIndex: number = 0;

  /**
   * 当前季节 id（CC-12，来自 environment.seasons 循环）。
   *
   * 季节 id 是**配置字符串**（game/ 定义），框架只透传；未配置 seasons 时
   * 为空串。与 `phaseId` 相互独立（季节周期通常远长于环境相位周期）。
   */
  @type("string")
  seasonId: string = "";

  /**
   * 当前天气表现强度 [0, 1]（CC-12，来自被选中天气条目的 intensity）。
   *
   * 由服务端配置驱动（未配置 intensity 时 0）；客户端可据此调节雨雪粒子密度/
   * 雾浓度等表现，不要自行推断或编造强度。
   */
  @type("float64")
  weatherIntensity: number = 0;
}
