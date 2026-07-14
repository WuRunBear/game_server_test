import { Room, type Client } from "@colyseus/core";

import { createGameSimulation, type SimulationPort } from "simulation";
import type { PlayerInput, TickSnapshot } from "simulation/types";
import { loadGameDefinition } from "framework/bootstrap/loadGameDefinition";
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
    typeof obj.moveY === "number"
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
   */
  private debugMapSentSubscribers = new Set<string>();

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
   * 2. 创建仿真实例（GameSimulation → GameInstance → ECS World）
   * 3. 初始化 Colyseus RoomState
   * 4. 注册消息处理器（input / debug 订阅等）
   * 5. 启动 Colyseus tick 循环（setSimulationInterval）
   */
  onCreate(options?: Record<string, unknown>): void {
    // Colyseus 默认在 onLeave 最后一个客户端时自动 dispose 房间，
    // 这里禁用它——因为单房间模式下房间应常驻
    this.autoDispose = false;

    // 加载游戏配置（从 game/ 目录加载 JSON + zod 校验 + 引用完整性检查）
    const gameJsonPath = options?.gameJsonPath as string | undefined;
    const gameDef = loadGameDefinition({ gameJsonPath });

    // 计算固定步长（如 tickRate=20 → fixedDtMs=50）
    const fixedDtMs = Math.max(1, Math.floor(1000 / gameDef.tickRate));

    // 创建仿真实例——从这里开始，所有 ECS 操作都走 sim 接口
    this.sim = createGameSimulation(gameDef);

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
   */
  onJoin(client: Client): void {
    // 让仿真层创建一个玩家实体，拿到稳定网络 ID
    const { networkId } = this.sim.addPlayer(client.sessionId);

    // 写入 Colyseus PlayerState——客户端通过它知道"自己控制哪个实体"
    const playerState = new PlayerState();
    playerState.sessionId = client.sessionId;
    playerState.entityId = networkId;
    this.state.players.set(client.sessionId, playerState);
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
    const result = this.sim.tick(deltaTimeMs || fixedDtMs);
    this.applySnapshot(result.snapshot);
    this.pushCollisionDebugSnapshots(deltaTimeMs || fixedDtMs);
  }

  /**
   * 把仿真快照写入 Colyseus RoomState。
   *
   * 这一步是"最终扩散点"——所有客户端的同步数据最终都通过这里写入。
   *
   * **与旧实现的区别**：
   * 旧实现（syncState）直接读 ECS world→query→SoA 数组→写 EntityState，
   * 新实现只遍历纯数据 TickSnapshot，不 import 任何 ECS 符号。
   *
   * **diff 策略**（找出新增/存续/删除的实体）：
   * 1. 快照中有的 entity → 新增或更新 EntityState
   * 2. RoomState 中有的但快照中没有 → 实体已死亡，从 RoomState 删除
   *
   * @param snapshot 仿真产出的纯数据快照
   */
  private applySnapshot(snapshot: TickSnapshot): void {
    this.state.tick = snapshot.tick;

    // alive 集合记录快照中出现的所有实体 networkId
    const alive = new Set<number>();

    for (const [networkId, values] of snapshot.entities) {
      alive.add(networkId);
      const key = String(networkId);

      // 获取或创建 EntityState——复用实例减少 GC
      let entityState = this.state.entities.get(key);
      if (!entityState) {
        entityState = new EntityState();
        entityState.id = networkId;
        this.state.entities.set(key, entityState);
      }

      // 逐字段更新（Colyseus Schema 的 MapSchema.set 会标记 dirty，触发增量序列化）
      for (const [fieldKey, value] of Object.entries(values)) {
        entityState.values.set(fieldKey, value);
      }
    }

    // 清理已死亡的实体：RoomState 中有但 alive 集合中没有的
    this.state.entities.forEach((_value: EntityState, key: string) => {
      if (!alive.has(Number(key))) this.state.entities.delete(key);
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
