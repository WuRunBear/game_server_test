import { Room, type Client } from "@colyseus/core";
import { StateView } from "@colyseus/schema";

import { createGameSimulation, type SimulationPort } from "simulation";
import type { PlayerInput, PlayerCommand, TickSnapshot, TickResult, EntitySnapshot } from "simulation/types";
import { loadGameDefinition } from "framework/bootstrap/loadGameDefinition";
import { createFileRepository } from "framework/persistence/fileRepository";
import type { Repository, WorldRecord } from "framework/repository";
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
 * 类型守卫：判断收到的消息是否为合法的 PlayerInput 格式。
 *
 * 传输层只做"字段存在 + 类型正确"的结构验证，不做游戏逻辑校验
 * （seq 去重、移动速度限制等由仿真层处理）。
 */
function isPlayerInput(message: unknown): message is PlayerInput {
  if (!message || typeof message !== "object") return false;
  const obj = message as Record<string, unknown>;
  return (
    typeof obj.seq === "number" &&
    typeof obj.moveX === "number" &&
    typeof obj.moveY === "number" &&
    (obj.interact === undefined || typeof obj.interact === "boolean") &&
    (obj.attack === undefined || typeof obj.attack === "boolean") &&
    (obj.talk === undefined || typeof obj.talk === "boolean")
  );
}

/** 命令消息类型守卫：只做结构校验，游戏逻辑校验在仿真层。 */
function isPlayerCommand(message: unknown): message is PlayerCommand {
  if (!message || typeof message !== "object") return false;
  const obj = message as Record<string, unknown>;
  return (
    typeof obj.type === "string" &&
    (obj.type === "consume" ||
      obj.type === "drop" ||
      obj.type === "transfer" ||
      obj.type === "craft" ||
      obj.type === "equip" ||
      obj.type === "place" ||
      obj.type === "deconstruct" ||
      obj.type === "dialogue") &&
    (obj.slot === undefined || typeof obj.slot === "number") &&
    (obj.toSlot === undefined || typeof obj.toSlot === "number") &&
    (obj.recipe === undefined || typeof obj.recipe === "string") &&
    (obj.x === undefined || typeof obj.x === "number") &&
    (obj.y === undefined || typeof obj.y === "number") &&
    (obj.target === undefined || typeof obj.target === "number") &&
    (obj.option === undefined || typeof obj.option === "number")
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
   * 已接收过首次地图碰撞体的客户端集合。
   *
   * 首次订阅时推送包含地图碰撞体的完整快照（includeMapBodies=true），
   * 之后只推送实体碰撞体（includeMapBodies=false），避免每帧发送不变的地图数据。
   * 地图切换（onMapChanged）时清空，强制订阅者重拉新图碰撞体。
   */
  private debugMapSentSubscribers = new Set<string>();

  /** 上一帧同步的地图 id（applySnapshot 检测变化用）。 */
  private prevMapId = "";

  /**
   * 调试推送冷却计时器（毫秒）。
   *
   * 每帧累加 deltaTimeMs，达到 500ms 阈值时归零并推送一次快照。
   */
  private debugPushCooldownMs = 0;

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

    // 读档恢复：server 规则配置 saveId 时接文件仓储，加载世界快照作为初始状态
    const serverRules = gameDef.resolvedRules["server"] as ServerRule | undefined;
    let repository: Repository | undefined;
    let initialRecord: WorldRecord | null = null;
    if (serverRules?.saveId) {
      repository = createFileRepository(process.env.SAVE_DIR ?? "data/saves");
      initialRecord = await repository.loadWorld(serverRules.saveId);
    }

    // 创建仿真实例——从这里开始，所有 ECS 操作都走 sim 接口
    this.sim = createGameSimulation(gameDef, {
      repository,
      saveId: serverRules?.saveId,
      initialRecord: initialRecord ?? undefined,
    });

    // RoomState 是 Colyseus Schema——客户端通过 WebSocket 增量同步
    this.state = new RoomState();

    // 启动 Colyseus tick——每 fixedDtMs 毫秒调用一次 onTick
    // 注意：deltaTime 是实际流逝时间（可能因系统负载偏大），用 || 兜底
    this.setSimulationInterval((deltaTime) => this.onTick(deltaTime, fixedDtMs), fixedDtMs);

    // --- 注册消息处理器 ---

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
   */
  onJoin(client: Client): void {
    // 让仿真层创建一个玩家实体，拿到稳定网络 ID
    const { networkId } = this.sim.addPlayer(client.sessionId);

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
  }

  /**
   * 玩家离开——销毁模拟实体，清理所有关联状态。
   *
   * 要清理的状态：
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
   * 获取碰撞调试快照——供 server.ts 的 /debug/colliders HTTP 端点调用。
   *
   * 这个方法名必须保留不变，因为 server.ts 使用 Colyseus 的
   * `matchMaker.remoteRoomCall<GameRoom>("getCollisionDebugSnapshot")` 按字符串名调用。
   *
   * 实现直接委托给仿真层，传输层不关心快照结构。
   */
  getCollisionDebugSnapshot(options?: { includeMapBodies?: boolean }): unknown {
    return this.sim.getDebugSnapshot(options);
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
   * 把仿真快照写入 Colyseus RoomState（双路径）。
   *
   * - **兴趣路径**（result.interest 存在，启用了视野裁剪）：
   *   按各客户端可见集合写入其 PlayerState.visibleEntities（per-client diff，
   *   Colyseus 按连接分别增量同步）——每个客户端只见视野内实体。
   * - **全量路径**（无 interest，未配置视野半径）：
   *   写入共享 RoomState.entities 广播给所有客户端（兼容旧协议/旧客户端）。
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
    // 地图切换：同步 mapId 并让已订阅调试的客户端重拉地图碰撞体
    const nextMapId = snapshot.mapId ?? "";
    if (nextMapId !== this.prevMapId) {
      this.state.mapId = nextMapId;
      this.onMapChanged();
    }

    if (result.interest) {
      this.applyInterest(result);
      return;
    }
    this.applyFullSnapshot(snapshot);
  }

  /**
   * 地图变更处理：清空"已发过地图碰撞体"标记并给订阅者强制推一次完整快照，
   * 避免客户端缓存旧图碰撞体（换图后旧图数据过期）。
   */
  private onMapChanged(): void {
    this.debugMapSentSubscribers.clear();
    if (this.debugSubscribers.size === 0) return;
    for (const client of this.clients) {
      if (this.debugSubscribers.has(client.sessionId)) {
        this.sendCollisionDebugSnapshot(client, true);
      }
    }
  }

  /** 全量路径：把快照写入共享 RoomState.entities。 */
  private applyFullSnapshot(snapshot: TickSnapshot): void {
    const alive = new Set<number>();
    for (const [networkId, snap] of snapshot.entities) {
      alive.add(networkId);
      const key = String(networkId);
      let entityState = this.state.entities.get(key);
      if (!entityState) {
        entityState = new EntityState();
      }
      this.writeEntityState(entityState, networkId, snap);
      this.state.entities.set(key, entityState);
    }
    this.state.entities.forEach((_value: EntityState, key: string) => {
      if (!alive.has(Number(key))) this.state.entities.delete(key);
    });
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
      for (const networkId of visible) {
        const snap = snapshot.entities.get(networkId);
        if (!snap) continue;
        const key = String(networkId);
        let entityState = playerState.visibleEntities.get(key);
        if (!entityState) {
          entityState = new EntityState();
          this.writeEntityState(entityState, networkId, snap);
          playerState.visibleEntities.set(key, entityState);
          // 先挂 state 再 add 进 view（新实例无 refId，StateView 会拒收 detached）
          (client.view as StateView | undefined)?.add(entityState);
        } else {
          this.writeEntityState(entityState, networkId, snap);
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
   */
  private writeEntityState(entityState: EntityState, networkId: number, snap: EntitySnapshot): void {
    entityState.id = networkId;

    const nextNumberKeys = new Set<string>();
    for (const [fieldKey, value] of Object.entries(snap.values)) {
      nextNumberKeys.add(fieldKey);
      entityState.values.set(fieldKey, value);
    }
    entityState.values.forEach((_v: number, k: string) => {
      if (!nextNumberKeys.has(k)) entityState.values.delete(k);
    });

    const nextStringKeys = new Set<string>();
    for (const [fieldKey, value] of Object.entries(snap.strings)) {
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

    // 节流推送不包含地图碰撞体（客户端已有首次快照的地图数据）
    const snapshot = this.sim.getDebugSnapshot({ includeMapBodies: false });
    for (const client of this.clients) {
      if (!this.debugSubscribers.has(client.sessionId)) continue;
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
    // 首次发送: forceIncludeMapBodies=true 或该客户端还没收过地图数据
    const includeMapBodies =
      forceIncludeMapBodies || !this.debugMapSentSubscribers.has(client.sessionId);

    client.send(
      "debug_colliders_snapshot",
      this.sim.getDebugSnapshot({ includeMapBodies }),
    );

    // 标记该客户端已收过地图碰撞体
    if (includeMapBodies) {
      this.debugMapSentSubscribers.add(client.sessionId);
    }
  }
}
