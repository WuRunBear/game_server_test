/**
 * Colyseus 单房间实现——传输层胶水（仿真/传输解耦的"传输"半边）。
 *
 * 每 tick 流程：接收客户端输入（input / command）→ 经 SimulationPort
 * 提交给仿真层（由 ECS 系统消费，如写入 Velocity）→ sim.tick(dtMs)
 * 推进仿真 → 把 TickSnapshot 派生为 RoomState 视图，Colyseus 自动
 * 增量同步给客户端。本文件不 import 任何 bitecs/ECS 符号（详见
 * SimulationPort 接口与下方 GameRoom 类注释）。
 */
import { Room, type Client } from "@colyseus/core";
import { StateView } from "@colyseus/schema";

import { createGameSimulation, type SimulationPort } from "simulation";
import type { PlayerInput, PlayerCommand, TickResult, EntitySnapshot, TickSnapshot, OfferSummary } from "simulation/types";
import { loadGameDefinition } from "framework/bootstrap/loadGameDefinition";
import { createFileRepository } from "framework/persistence/fileRepository";
import type { ServerRule } from "framework/config/schema/RuleSchema";
import { EntityState } from "network/colyseus/state/EntityState";
import { RoomState } from "network/colyseus/state/RoomState";
import { PlayerState } from "network/colyseus/state/PlayerState";

/**
 * 碰撞调试快照推送间隔（毫秒）。
 *
 * 碰撞数据每帧都变，但不需要每帧推。500ms 一次既够调试用，
 * 又不会挤占正常同步带宽。
 */
const DEBUG_COLLIDERS_PUSH_INTERVAL_MS = 500;

/**
 * 输入消息类型守卫：判断收到的消息是否为合法的 PlayerInput 格式。
 *
 * 传输层只做"字段存在 + 类型正确"的结构验证，不做游戏逻辑校验
 * （seq 去重、移动速度限制等由仿真层处理）。数值必须为有限数：
 * NaN/Infinity/非整数 seq 在此即丢弃（仿真层仍有同款权威校验）。
 * moveX/moveY 缺省视为 0（由仿真层归一化）。
 *
 * 导出供测试直连（守卫是协议边界的第一道闸：误拒 = 客户端命令整条丢弃）。
 */
export function isPlayerInput(message: unknown): message is PlayerInput {
  if (!message || typeof message !== "object") return false;
  const obj = message as Record<string, unknown>;
  return (
    typeof obj.seq === "number" &&
    Number.isInteger(obj.seq) &&
    obj.seq >= 0 &&
    (obj.moveX === undefined ||
      (typeof obj.moveX === "number" && Number.isFinite(obj.moveX))) &&
    (obj.moveY === undefined ||
      (typeof obj.moveY === "number" && Number.isFinite(obj.moveY))) &&
    (obj.interact === undefined || typeof obj.interact === "boolean") &&
    (obj.attack === undefined || typeof obj.attack === "boolean") &&
    (obj.talk === undefined || typeof obj.talk === "boolean")
  );
}

/**
 * 交易数量条目浅校验（结构合法性由仿真层最终裁决）。
 *
 * `container` **可省略**（缺省按背包 inventory 处理，见 economy/offer 的归一）；
 * `kind` 与 `count` 仍必填（kind 非空字符串、count 正整数）。
 */
export function isTradeAmountShape(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const amount = value as Record<string, unknown>;
  return (
    (amount.container === undefined ||
      amount.container === "inventory" ||
      amount.container === "ledger") &&
    typeof amount.kind === "string" &&
    amount.kind.length > 0 &&
    typeof amount.count === "number" &&
    Number.isInteger(amount.count) &&
    amount.count > 0
  );
}

/**
 * 交易单方条款浅校验（party 为**参与方 networkId**（正整数）+ give/take 条目）。
 *
 * `party` 是协议层的 networkId（客户端可见的稳定 id），不是服务端内部 eid。
 */
export function isTradePartyShape(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const party = value as Record<string, unknown>;
  if (
    typeof party.party !== "number" ||
    !Number.isInteger(party.party) ||
    party.party <= 0
  ) {
    return false;
  }
  if (
    party.give !== undefined &&
    (!Array.isArray(party.give) || !party.give.every(isTradeAmountShape))
  ) {
    return false;
  }
  if (
    party.take !== undefined &&
    (!Array.isArray(party.take) || !party.take.every(isTradeAmountShape))
  ) {
    return false;
  }
  return true;
}

/**
 * 命令消息类型守卫：只做结构校验，游戏逻辑校验在仿真层。
 *
 * 协议放宽点（与客户端实现对齐，误拒 = 命令整条丢弃）：
 * - `offer` 条款元素：`container` **可省略**（缺省 inventory）；`give`/`take`
 *   元素仍须含 `kind`（非空字符串）与 `count`（正整数）；
 * - `offerId`：**数字或数字字符串**皆可（RoomState.offers 的键是 offerId
 *   字符串，客户端按该原值回传）。
 *
 * 导出供测试直连（守卫是协议边界的第一道闸）。
 */
export function isPlayerCommand(message: unknown): message is PlayerCommand {
  if (!message || typeof message !== "object") return false;
  const obj = message as Record<string, unknown>;
  return (
    typeof obj.type === "string" &&
    (obj.type === "consume" ||
      obj.type === "drop" ||
      obj.type === "transfer" ||
      obj.type === "craft" ||
      obj.type === "craft-cancel" ||
      obj.type === "refuel" ||
      obj.type === "equip" ||
      obj.type === "place" ||
      obj.type === "deconstruct" ||
      obj.type === "throw" ||
      obj.type === "dialogue" ||
      obj.type === "offer" ||
      obj.type === "offer-accept" ||
      obj.type === "offer-cancel") &&
    (obj.slot === undefined || typeof obj.slot === "number") &&
    (obj.toSlot === undefined || typeof obj.toSlot === "number") &&
    (obj.recipe === undefined || typeof obj.recipe === "string") &&
    (obj.x === undefined || typeof obj.x === "number") &&
    (obj.y === undefined || typeof obj.y === "number") &&
    (obj.target === undefined || typeof obj.target === "number") &&
    (obj.option === undefined || typeof obj.option === "number") &&
    // offer 条款浅校验到元素级（畸形对象直接丢弃，不抛崩）；
    // 双人/在线玩家/归属等权威校验由仿真层完成。
    (obj.offer === undefined ||
      (Array.isArray(obj.offer) && obj.offer.every(isTradePartyShape))) &&
    (obj.offerId === undefined ||
      (typeof obj.offerId === "number" && Number.isInteger(obj.offerId)) ||
      // 客户端直接回传报价表 map 键的字符串形态 → 允许数字字符串
      (typeof obj.offerId === "string" && /^\d+$/.test(obj.offerId.trim()))) &&
    (obj.ttlTicks === undefined ||
      (typeof obj.ttlTicks === "number" &&
        Number.isInteger(obj.ttlTicks) &&
        obj.ttlTicks >= 0))
  );
}

/**
 * 单房间游戏房间——负责连接管理、输入接收、tick 驱动，并将仿真快照写回 RoomState。
 *
 * ## 设计定位
 *
 * GameRoom 是**纯传输层胶水**——它只做三件事：
 * 1. **接收客户端消息** → 转交给 SimulationPort
 * 2. **驱动仿真 tick**   → 调用 SimulationPort.tick()
 * 3. **同步客户端状态** → 把 TickSnapshot 映射到 Colyseus Schema
 *
 * GameRoom **不做**的事情（全部委托给 SimulationPort）：
 * - 不直接 import bitecs（query / removeEntity / addEntity 等）
 * - 不直接 import ECS 组件（NetworkId / Velocity / Transform 等）
 * - 不直接调用 spawnEntity 等仿真内部函数
 * - 不直接读取或写入 GameWorld / SoA 数组
 *
 * ## 数据流
 *
 * ```
 * 客户端 → WebSocket → Colyseus
 *   └─ onMessage("input") → sim.submitInput(sessionId, input)  [传输→仿真]
 *
 * Colyseus setSimulationInterval
 *   └─ onTick()
 *        ├─ sim.tick(dtMs)           [仿真推进，产 TickResult]
 *        ├─ applySnapshot(result)    [Ticksnapshot → RoomState]
 *        └─ pushDebug()              [碰撞可视化推送]
 *
 * Colyseus diff  → WebSocket → 客户端   [Colyseus 自动增量同步]
 * ```
 */
export class GameRoom extends Room<{ state: RoomState }> {
  /**
   * 仿真端口——所有 ECS 操作都通过这个接口调用。
   *
   * 用 `!` 断言是因为它在 `onCreate()` 中初始化，TypeScript 不知道
   * Colyseus 的生命周期保证了 `onCreate` 先于其他方法执行。
   */
  private sim!: SimulationPort;

  /**
   * 已订阅碰撞调试推送的客户端 sessionId 集合。
   *
   * 客户端发送 "debug_colliders_subscribe" 后加入此集合，
   * 之后每 500ms 收到一次碰撞调试快照，直到发送 "debug_colliders_unsubscribe"。
   */
  private debugSubscribers = new Set<string>();

  /**
   * 每客户端已发过地图碰撞体的归属图（sessionId → 已发图 id）。
   *
   * 首次订阅/拉取时推送包含该客户端所在图地图碰撞体的完整快照
   * （includeMapBodies=true），之后只推送实体碰撞体（includeMapBodies=false），
   * 避免每帧发送不变的地图数据。客户端所在图变化（onMapChanged 检测）时
   * 重置该标记，强制其重拉新图碰撞体。
   */
  private debugMapSentSubscribers = new Map<string, string>();

  /**
   * 调试推送冷却计时器（毫秒）。
   *
   * 每帧累加 deltaTimeMs，达到 500ms 阈值时归零并推送一次快照。
   */
  private debugPushCooldownMs = 0;

  /**
   * 上一 tick 结束（已从共享报价表删除）的报价条目 id。
   *
   * 用途：让「曾看到该条目」的客户端仍能收到**删除操作**——报价表的删除
   * 是在本 tick 的广播里编码的，故其可见性登记需再保留一轮（下一 tick 清理）。
   */
  private retiredOfferIds: string[] = [];

  /**
   * 最近一帧的报价摘要列表（供新连接加入时登记可见性）。
   */
  private lastOffers: OfferSummary[] = [];

  /**
   * 房间创建——这是 GameRoom 生命周期的起点。
   *
   * 执行顺序：
   * 1. 加载游戏配置（game.json + 子配置文件）
   * 2. 读档（若 rules/server.json 配置了 saveId）：从默认文件仓储加载世界快照
   * 3. 创建仿真实例（GameSimulation → GameInstance → ECS World），传入恢复快照
   * 4. 初始化 Colyseus RoomState
   * 5. 注册消息处理器（input / debug 订阅等）
   * 6. 启动 Colyseus tick 循环（setSimulationInterval）
   *
   * async：Colyseus 会等待 onCreate 完成后再接受客户端加入，
   * 保证首个玩家连接前世界已恢复到存档状态。
   */
  async onCreate(options?: Record<string, unknown>): Promise<void> {
    // Colyseus 默认在 onLeave 最后一个客户端时自动 dispose 房间，
    // 这里禁用它——因为单房间模式下房间应常驻
    this.autoDispose = false;

    // 加载游戏配置（从 game/ 目录加载 JSON + zod 校验 + 引用完整性检查）
    const gameJsonPath = options?.gameJsonPath as string | undefined;
    const gameDef = loadGameDefinition({ gameJsonPath });

    // 计算固定步长（如 tickRate=20 → fixedDtMs=50）
    const fixedDtMs = Math.max(1, Math.floor(1000 / gameDef.tickRate));

    // 读档预载已移入 createGameSimulation 装配处（repository + saveId 注入，
    // 快照经 BootDeps 单一通道进 bootMaps/restoreWorld——读档通道唯一化）
    const serverRules = gameDef.resolvedRules["server"] as ServerRule | undefined;
    const repository = serverRules?.saveId
      ? createFileRepository(process.env.SAVE_DIR ?? "data/saves")
      : undefined;

    // 创建仿真实例——从这里开始，所有 ECS 操作都走 sim 接口
    this.sim = await createGameSimulation(gameDef, {
      repository,
      saveId: serverRules?.saveId,
    });

    // RoomState 是 Colyseus Schema——客户端通过 WebSocket 增量同步
    this.state = new RoomState();

    // 启动 Colyseus tick——每 fixedDtMs 毫秒调用一次 onTick
    // 注意：deltaTime 是实际流逝时间（可能因系统负载偏大），用 || 兜底
    this.setSimulationInterval((deltaTime) => this.onTick(deltaTime, fixedDtMs), fixedDtMs);

    // --- 注册消息处理器 ---
    this.registerMessageHandlers();
  }

  /**
   * 注册消息处理器（input / command / 调试订阅）。
   *
   * 独立成方法（而非内联在 onCreate）：消息守卫是协议边界的**第一道闸**——
   * 守卫误拒 = 客户端命令整条丢弃且无回执（最难排查的一类故障）。独立成
   * 方法便于测试直连「守卫 → 仿真层」的完整链路。
   */
  private registerMessageHandlers(): void {
    // 客户端输入：校验格式后交给仿真层处理
    this.onMessage("input", (client: Client, message: unknown) => {
      if (!isPlayerInput(message)) return;
      this.sim.submitInput(client.sessionId, message);
    });

    // 背包原子命令：食用 / 丢弃 / 移动槽
    this.onMessage("command", (client: Client, message: unknown) => {
      if (!isPlayerCommand(message)) return;
      this.sim.submitCommand(client.sessionId, message);
    });

    // 订阅碰撞调试推送
    this.onMessage("debug_colliders_subscribe", (client: Client) => {
      this.debugSubscribers.add(client.sessionId);
      // 首次订阅时立即发送包含地图碰撞体的完整快照
      this.sendCollisionDebugSnapshot(client, true);
    });

    // 取消碰撞调试订阅
    this.onMessage("debug_colliders_unsubscribe", (client: Client) => {
      this.debugSubscribers.delete(client.sessionId);
      this.debugMapSentSubscribers.delete(client.sessionId);
    });

    // 主动拉取一次碰撞调试快照（不订阅，单次拉取）
    this.onMessage("debug_colliders_pull", (client: Client) => {
      this.sendCollisionDebugSnapshot(client);
    });
  }

  /**
   * 玩家加入——创建模拟实体，写入玩家状态表。
   *
   * Colyseus 在客户端连接并匹配到房间时调用此方法。
   * PlayerState 写入后 Colyseus 自动增量同步给该客户端（其他客户端不影响）。
   *
   * 兴趣管理接线（colyseus StateView 模型）：
   * - `@view()` 过滤字段（PlayerState.visibleEntities）的编码树必须 `view.add()`
   *   进客户端 view，否则该树对客户端不可见（编码整体跳过）。
   * - **最小视图**：只挂自己的 PlayerState 树（递归含自己的可见表）。
   *   其他玩家的 PlayerState 树经共享通路到达（sessionId/entityId 非过滤字段），
   *   其 visibleEntities（过滤字段）本就应被隐藏——整树 add 会把他人实体树
   *   也带入本客户端编码，触发解码端 "refId not found" 告警，故不挂。
   * - 实体视图（可见表内容）由 applyInterest 每帧维护：进入视野 view.add、
   *   离开视野 view.remove（@view() 集合的每个元素必须显式 add，否则内容不编码）。
   *
   * 重连复用：客户端可在 join options 携带断线前的 networkId（可选字段，
   * 老客户端不传则行为不变），仿真层命中断线保留实体则复用（进度不丢）。
   */
  onJoin(client: Client, options?: Record<string, unknown>): void {
    // 让仿真层创建/复用玩家实体，拿到稳定网络 ID
    // （options.networkId 为客户端自报的断线前标识，仅结构校验，匹配在仿真层）
    const hintedNetworkId =
      typeof options?.networkId === "number" ? options.networkId : undefined;
    const { networkId } = this.sim.addPlayer(client.sessionId, { networkId: hintedNetworkId });

    // 写入 Colyseus PlayerState——客户端通过它知道"自己控制哪个实体"
    const playerState = new PlayerState();
    playerState.sessionId = client.sessionId;
    playerState.entityId = networkId;
    playerState.visibleEntities.ownerSessionId = client.sessionId;
    this.state.players.set(client.sessionId, playerState);

    // per-client 编码视图：$filter 依据 view.sessionId 与 visibleEntities.ownerSessionId 匹配
    if (!client.view) {
      client.view = new StateView();
    }
    (client.view as unknown as { sessionId?: string }).sessionId = client.sessionId;
    client.view.add(playerState);
    // 报价摘要表（RoomState.offers）是房间级共享表 + 逐条 per-client 过滤：
    // 该表必须挂进本连接的 view（否则其过滤字段不进本客户端编码），
    // 逐条可见性由 OfferSummaries.$filter 按 sessionId 判定。
    client.view.add(this.state.offers);
    // 新连接的可见性登记：既有报价条目的 ADD 操作早于其加入（已在其他广播
    // 中编码过），故须在此立即登记，否则该连接的**初始全量状态**里看不到
    // 自己参与的报价（后续帧也不会补发——条目内容未变）。
    this.registerOfferVisibility(client.sessionId, networkId);
  }

  /**
   * 登记某连接的报价可见性（按参与方 networkId 匹配）。
   *
   * @param sessionId 连接 sessionId
   * @param networkId 该连接玩家的 networkId
   */
  private registerOfferVisibility(sessionId: string, networkId: number): void {
    for (const offer of this.lastOffers) {
      if (offer.from !== networkId && offer.to !== networkId) continue;
      this.state.offers.addVisibleSession(String(offer.offerId), sessionId);
    }
  }

  /**
   * 玩家离开——按断线保留策略处理模拟实体，清理所有关联状态。
   *
   * 仿真层实体去留由 sim.removePlayer 内部决定（保留期配置驱动：标记保留
   * 或立即销毁），本层零改动；要清理的状态：
   * - 仿真层：玩家实体（sim.removePlayer 负责）
   * - RoomState：players 映射（Colyseus 自动删除 + 增量同步给其他客户端）
   * - 调试订阅：debugSubscribers / debugMapSentSubscribers
   */
  onLeave(client: Client): void {
    // 仿真层销毁玩家实体（内部同时清理输入缓存）
    this.sim.removePlayer(client.sessionId);

    // 清理调试订阅
    this.debugSubscribers.delete(client.sessionId);
    this.debugMapSentSubscribers.delete(client.sessionId);

    // 从 RoomState 移除玩家信息
    this.state.players.delete(client.sessionId);
  }

  /**
   * 房间释放——无停机存档（F-08）。
   *
   * Colyseus 在房间真正 dispose 时调用（常驻房间由 server.gracefullyShutdown
   * 触发；autoDispose 已禁用，不会因最后一名玩家离开而释放）。此处 **await**
   * 仿真层 flushSave，确保进程退出/房间销毁路径上最新 tick 的世界状态已落盘，
   * 而不是等下一次 60s 定时存档。
   *
   * 注意生命周期：onCreate 失败时 sim 可能尚未赋值——此时无事可做。
   */
  async onDispose(): Promise<void> {
    if (!this.sim) return;
    await this.sim.flushSave("room-dispose");
  }

  /**
   * 获取碰撞调试快照——供 server.ts 的 /debug/colliders HTTP 端点调用。
   *
   * 这个方法名必须保留不变，因为 server.ts 使用 Colyseus 的
   * `matchMaker.remoteRoomCall<GameRoom>("getCollisionDebugSnapshot")` 按字符串名调用。
   *
   * 实现直接委托给仿真层，传输层不关心快照结构。
   */
  getCollisionDebugSnapshot(options?: { includeMapBodies?: boolean; mapId?: string }): unknown {
    return this.sim.getDebugSnapshot(options);
  }

  /**
   * 取房间内世界的**实时地图几何**快照（供 HTTP 端点 /maps/runtime 使用）。
   *
   * 与「按配置重建几何」不同：这里返回世界当前持有的几何——运行期写回
   * （如野火焦土）已反映在 tiles/walkable/level 上，version 指纹随之变化。
   * 该图不在世界中时返回 null（端点回退到配置重建视图）。
   *
   * 方法名必须保留不变：server.ts 用 Colyseus 的
   * `matchMaker.remoteRoomCall<GameRoom>("getLiveMapGeometry")` 按字符串名调用。
   */
  getLiveMapGeometry(mapId: string): unknown {
    return this.sim.getMapGeometry?.(mapId) ?? null;
  }

  /**
   * 取房间内全部地图的实时元信息（id/尺寸/version）——供 /maps/meta 使用。
   *
   * version 取自**实时几何**（含写回后的内容指纹）；未在世界中构建的图不在
   * 返回值里（端点回退到配置重建视图）。
   */
  getLiveMapMeta(): unknown {
    const maps: Array<{
      id: string;
      name: string;
      kind: string;
      width: number;
      height: number;
      tileWidth: number;
      tileHeight: number;
      version: string;
    }> = [];
    for (const config of this.sim.getMapConfigs?.() ?? []) {
      const geometry = this.sim.getMapGeometry?.(config.key);
      if (!geometry) continue;
      maps.push({
        id: geometry.key,
        name: geometry.key,
        kind: config.pipeline[0]?.generator ?? "",
        width: geometry.grid.width,
        height: geometry.grid.height,
        tileWidth: geometry.grid.tileWidth,
        tileHeight: geometry.grid.tileHeight,
        version: geometry.version,
      });
    }
    return maps;
  }

  /**
   * 调试用：写回某图单格地面语义（验证 /maps 端点读的是 live 几何）。
   *
   * 方法名必须保留不变：测试/工具经 Colyseus 的
   * `matchMaker.remoteRoomCall<GameRoom>("debugWriteGround")` 按字符串名调用。
   */
  debugWriteGround(mapId: string, tileIndex: number, semanticId: number): unknown {
    return this.sim.debugSetGround?.(mapId, tileIndex, semanticId) ?? false;
  }

  /**
   * 每帧 tick 回调——由 Colyseus setSimulationInterval 触发。
   *
   * 三步：
   * 1. sim.tick(dtMs) — 推进仿真，得到快照
   * 2. applySnapshot — 把快照写入 RoomState（触发 Colyseus 增量同步）
   * 3. pushCollisionDebugSnapshots — 节流推送调试数据
   *
   * @param deltaTimeMs Colyseus 提供的实际流逝时间
   * @param fixedDtMs 固定步长（兜底值，deltaTimeMs 可能为 0）
   */
  private onTick(deltaTimeMs: number, fixedDtMs: number): void {
    const dtMs = deltaTimeMs > 0 ? deltaTimeMs : fixedDtMs;
    const result = this.sim.tick(dtMs);
    this.applySnapshot(result);
    this.pushCollisionDebugSnapshots(dtMs);
  }

  /**
   * 把仿真快照写入 Colyseus RoomState（单路径：per-client 兴趣同步）。
   *
   * 每帧对每个客户端按其兴趣集合写入 PlayerState.visibleEntities
   * （per-client diff，Colyseus 按连接分别增量同步）——每个客户端只见
   * 自己视野内实体。
   *
   * @param result 仿真产出的本帧结果
   */
  private applySnapshot(result: TickResult): void {
    const snapshot = result.snapshot;
    this.state.tick = snapshot.tick;
    if (snapshot.timeOfDay) {
      this.state.hour = snapshot.timeOfDay.hour;
      this.state.phase = snapshot.timeOfDay.phase;
    }
    // 环境派生（相位/天气/进度）：tick 的纯函数，仿真层每帧算出后写入。
    if (snapshot.environment) {
      this.state.weatherId = snapshot.environment.weatherId;
      this.state.phaseId = snapshot.environment.phaseId;
      this.state.phaseProgress = snapshot.environment.phaseProgress;
    }
    // per-client 地图状态：每玩家从 snapshot.playerMaps 写入各自 PlayerState
    // （playerMaps 恒存在，todo 10；PlayerState.mapId 为 T12 新增字段）。
    for (const client of this.clients) {
      const playerState = this.state.players.get(client.sessionId);
      if (!playerState) continue;
      playerState.mapId = snapshot.playerMaps.get(client.sessionId) ?? "";
    }
    // 报价摘要表：逐条按参与方过滤（非相关玩家看不到该条）。
    this.applyOffers(snapshot);
    // per-client 地图变更检测（调试快照标记重置），随后恒走 per-client 兴趣路径。
    this.onMapChanged();
    this.applyInterest(result);
  }

  /**
   * 维护报价摘要表（RoomState.offers）：条目内容 + 逐条可见性。
   *
   * 流程（每 tick）：
   * 1. 清理**上一 tick**退休条目的可见性登记（其删除操作已在上一轮广播编码）；
   * 2. 按快照算出每个连接的相关报价（自己是发起方或接收方）；
   * 3. 把快照中已不存在的条目从共享表删除（可见性登记保留到下一轮，
   *    让「曾看到该条」的客户端收到删除操作）；
   * 4. 按本轮相关方重写可见性登记。
   */
  private applyOffers(snapshot: TickSnapshot): void {
    const offers = snapshot.offers ?? [];
    this.lastOffers = offers;
    const liveIds = new Set(offers.map((offer) => String(offer.offerId)));

    // 1) 退休条目的可见性登记清理（删除操作已编码完毕）
    for (const offerId of this.retiredOfferIds) {
      this.state.offers.clearVisibleSessions(offerId);
    }
    this.retiredOfferIds = [];

    // 2) 每连接的相关报价集合（发起方/接收方）
    const relevantBySession = new Map<string, Set<string>>();
    for (const client of this.clients) {
      const playerState = this.state.players.get(client.sessionId);
      if (!playerState) continue;
      const myNetworkId = playerState.entityId;
      const relevant = new Set<string>();
      for (const offer of offers) {
        if (offer.from === myNetworkId || offer.to === myNetworkId) {
          relevant.add(String(offer.offerId));
        }
      }
      relevantBySession.set(client.sessionId, relevant);
    }

    // 3) 删除已结束的条目（可见性登记保留一轮，供删除操作编码）
    for (const key of [...this.state.offers.keys()]) {
      if (liveIds.has(key)) continue;
      this.state.offers.delete(key);
      this.retiredOfferIds.push(key);
    }

    // 4) 写条目内容 + 本轮可见性登记
    for (const offer of offers) {
      const offerId = String(offer.offerId);
      this.state.offers.set(offerId, JSON.stringify({
        from: offer.from,
        to: offer.to,
        give: offer.give,
        take: offer.take,
      }));
      const sessions = new Set<string>();
      for (const [sessionId, relevant] of relevantBySession) {
        if (relevant.has(offerId)) sessions.add(sessionId);
      }
      this.state.offers.setVisibleSessions(offerId, sessions);
    }
  }

  /**
   * per-client 地图变更处理：对每个订阅了调试推送的客户端，若其所在图与
   * "已发过地图碰撞体的图"不一致，则重置标记并强制推一次该新图完整快照，
   * 避免客户端缓存旧图碰撞体（换图后旧图数据过期）。
   */
  private onMapChanged(): void {
    for (const client of this.clients) {
      if (!this.debugSubscribers.has(client.sessionId)) continue;
      const playerState = this.state.players.get(client.sessionId);
      if (!playerState) continue;
      if (this.debugMapSentSubscribers.get(client.sessionId) !== playerState.mapId) {
        this.debugMapSentSubscribers.delete(client.sessionId);
        this.sendCollisionDebugSnapshot(client, true);
      }
    }
  }

  /**
   * 兴趣路径：按各客户端可见集合写入其 PlayerState.visibleEntities。
   *
   * colyseus StateView 模型：`@view()` 集合的每个元素必须显式 `view.add()` 进
   * 客户端 view，其内容才会被编码推送（否则客户端只收到 key，收不到字段内容）。
   * 顺序注意：实体实例必须先挂入 state（visibleEntities.set 分配 refId），再
   * view.add——未挂 state 的实例会被 StateView 判定为 detached。
   *
   * - 进入视野的实体（新建或复用）：set 后 view.add
   * - 离开视野的实体：view.remove 后从表删除（remove 让重入可重新编码）
   */
  private applyInterest(result: TickResult): void {
    const snapshot = result.snapshot;
    for (const client of this.clients) {
      const playerState = this.state.players.get(client.sessionId);
      if (!playerState) continue;

      const visible = result.interest!.get(client.sessionId) ?? [];
      const alive = new Set(visible);
      const ownNetworkId = playerState.entityId;
      for (const networkId of visible) {
        const snap = snapshot.entities.get(networkId);
        if (!snap) continue;
        // F-28：其他玩家的背包槽位不下发（仅本人可见）；容器/尸体等非玩家
        // 实体的 Inventory 照旧同步（容器 UI 依赖）。Equipment/ItemMeta 不受影响。
        const hideInventory = snap.player === true && networkId !== ownNetworkId;
        const key = String(networkId);
        let entityState = playerState.visibleEntities.get(key);
        if (!entityState) {
          entityState = new EntityState();
          this.writeEntityState(entityState, networkId, snap, hideInventory);
          playerState.visibleEntities.set(key, entityState);
          // 先挂 state 再 add 进 view（新实例无 refId，StateView 会拒收 detached）
          (client.view as StateView | undefined)?.add(entityState);
        } else {
          this.writeEntityState(entityState, networkId, snap, hideInventory);
        }
      }
      playerState.visibleEntities.forEach((entityState: EntityState, key: string) => {
        if (!alive.has(Number(key))) {
          (client.view as StateView | undefined)?.remove(entityState);
          playerState.visibleEntities.delete(key);
        }
      });
    }
  }

  /**
   * 把单实体快照写入 EntityState（数值/字符串字段按 key diff 更新，
   * 并清理本帧已消失的字段，如 AoS 索引缩短后的旧 key 残留）。
   *
   * @param hideInventory 是否裁掉 `Inventory.*` 键（F-28：其他玩家实体为 true，
   *   其余实体/本人为 false）。被裁掉的键不在下一帧键集里 → 旧残留会被 diff 清除。
   */
  private writeEntityState(
    entityState: EntityState,
    networkId: number,
    snap: EntitySnapshot,
    hideInventory = false,
  ): void {
    entityState.id = networkId;
    // 层号：快照构建期由 entityLevelOf 统一写入（所有实体类型同一路径）
    entityState.level = snap.level;

    const nextNumberKeys = new Set<string>();
    for (const [fieldKey, value] of Object.entries(snap.values)) {
      if (hideInventory && fieldKey.startsWith("Inventory.")) continue;
      nextNumberKeys.add(fieldKey);
      entityState.values.set(fieldKey, value);
    }
    entityState.values.forEach((_v: number, k: string) => {
      if (!nextNumberKeys.has(k)) entityState.values.delete(k);
    });

    const nextStringKeys = new Set<string>();
    for (const [fieldKey, value] of Object.entries(snap.strings)) {
      if (hideInventory && fieldKey.startsWith("Inventory.")) continue;
      nextStringKeys.add(fieldKey);
      entityState.stringValues.set(fieldKey, value);
    }
    entityState.stringValues.forEach((_v: string, k: string) => {
      if (!nextStringKeys.has(k)) entityState.stringValues.delete(k);
    });
  }

  /**
   * 按固定间隔推送碰撞调试快照给订阅客户端。
   *
   * 节流逻辑：每帧累加 deltaTimeMs 到 cooldown 计数器，
   * 达到 500ms 阈值时归零并推送给所有订阅者一次。
   *
   * @param deltaTimeMs 本帧步长
   */
  private pushCollisionDebugSnapshots(deltaTimeMs: number): void {
    if (this.debugSubscribers.size === 0) return;

    this.debugPushCooldownMs += deltaTimeMs;
    if (this.debugPushCooldownMs < DEBUG_COLLIDERS_PUSH_INTERVAL_MS) {
      return;
    }
    this.debugPushCooldownMs = 0;

    // 节流推送不包含地图碰撞体（客户端已有首次快照的地图数据）；
    // per-client：按各订阅客户端所在图取快照并单发。
    for (const client of this.clients) {
      if (!this.debugSubscribers.has(client.sessionId)) continue;
      const playerState = this.state.players.get(client.sessionId);
      if (!playerState) continue;
      const snapshot = this.sim.getDebugSnapshot({
        includeMapBodies: false,
        mapId: playerState.mapId,
      });
      client.send("debug_colliders_snapshot", snapshot);
    }
  }

  /**
   * 向指定客户端发送碰撞调试快照。
   *
   * 首次发送时强制包含地图碰撞体（includeMapBodies=true），
   * 之后记录已发送标记，后续不再发送重复的地图数据。
   *
   * @param client 目标客户端连接
   * @param forceIncludeMapBodies 是否强制包含地图碰撞体
   */
  private sendCollisionDebugSnapshot(client: Client, forceIncludeMapBodies = false): void {
    // 快照使用该客户端所在玩家的地图（playerState.mapId，applySnapshot 每帧写入）。
    const playerState = this.state.players.get(client.sessionId);
    const clientMapId = playerState?.mapId ?? "";
    // 首次发送: forceIncludeMapBodies=true 或该客户端还没收过当前图的地图数据
    const includeMapBodies =
      forceIncludeMapBodies || this.debugMapSentSubscribers.get(client.sessionId) !== clientMapId;

    client.send(
      "debug_colliders_snapshot",
      this.sim.getDebugSnapshot({ includeMapBodies, mapId: clientMapId }),
    );

    // 标记该客户端已收过当前图的地图碰撞体
    if (includeMapBodies) {
      this.debugMapSentSubscribers.set(client.sessionId, clientMapId);
    }
  }
}
