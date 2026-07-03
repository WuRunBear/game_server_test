import { query, removeEntity } from "bitecs";
import { Room, type Client } from "@colyseus/core";

import { Collider, Health, NetworkId, Size, Transform, Velocity } from "components";
import { spawnEntity } from "framework/entities/spawn";
import { getRegistries } from "framework/bootstrap";
import { createGameInstance } from "framework/bootstrap/GameInstance";
import { loadGameDefinition } from "framework/bootstrap/loadGameDefinition";
import type { GameInstance } from "framework/bootstrap/GameInstance";
import { EntityState } from "network/colyseus/state/EntityState";
import { RoomState } from "network/colyseus/state/RoomState";
import { PlayerState } from "network/colyseus/state/PlayerState";
import { recordTick } from "framework/metrics";
import { getCollisionDebugSnapshot, type CollisionDebugSnapshot } from "systems/core/collisionSystem";
import type { EntityId, GameWorld } from "world";

/**
 * 客户端输入（最小示例）。
 *
 * 约定：
 * - seq 用于去重与丢弃旧输入
 * - moveX/moveY 直接写入速度（Velocity），单位与服务器逻辑一致
 */
interface ClientInput {
  seq: number;
  moveX: number;
  moveY: number;
}

const DEBUG_COLLIDERS_PUSH_INTERVAL_MS = 500;

/**
 * 判断消息是否为合法的客户端输入结构。
 *
 * @param message 任意输入
 * @returns 是否满足 ClientInput 的字段约束
 */
function isClientInput(message: unknown): message is ClientInput {
  if (!message || typeof message !== "object") return false;
  const obj = message as Record<string, unknown>;
  return (
    typeof obj.seq === "number" &&
    typeof obj.moveX === "number" &&
    typeof obj.moveY === "number"
  );
}

/**
 * 单房间游戏房间：负责连接管理、输入接收、tick 驱动 ECS，并将 ECS 状态写回 RoomState 以触发增量同步。
 *
 * 设计要点：
 * - ECS 仍是权威模拟：网络层只收输入，不直接改 RoomState.entities
 * - RoomState 仅作为“对客户端可见的同步层”，由 syncState() 从 ECS 拉取并写回
 * - 写回时尽量复用 EntityState 实例，仅更新字段，以减少增量补丁体积
 */
export class GameRoom extends Room<{ state: RoomState }> {
  private world!: GameWorld;
  private gameInstance!: GameInstance;
  private debugSubscribers = new Set<string>();
  private debugMapSentSubscribers = new Set<string>();
  private debugPushCooldownMs = 0;

  /**
   * sessionId -> eid 映射，用于把输入作用到正确的玩家实体。
   */
  private playerEidBySessionId = new Map<string, EntityId>();

  /**
   * sessionId -> lastSeq，用于丢弃乱序/重复输入。
   */
  private lastSeqBySessionId = new Map<string, number>();

  /**
   * sessionId -> 最新输入。
   *
   * 当前策略：每 tick 只消费“最新一条输入”，不会回放中间输入。
   */
  private latestInputBySessionId = new Map<string, ClientInput>();

  /**
   * 房间创建回调：初始化 World、系统列表与地图/NPC，并启动 tick。
   */
  onCreate(): void {
    this.autoDispose = false;

    const gameDef = loadGameDefinition();
    this.gameInstance = createGameInstance(gameDef);
    this.world = this.gameInstance.world;
    const fixedDtMs = Math.max(1, Math.floor(1000 / gameDef.tickRate));

    this.state = new RoomState();

    this.setSimulationInterval((deltaTime) => this.step(deltaTime, fixedDtMs), fixedDtMs);

    this.onMessage("input", (client: Client, message: unknown) => {
      if (!isClientInput(message)) return;
      const lastSeq = this.lastSeqBySessionId.get(client.sessionId) ?? 0;
      if (message.seq <= lastSeq) return;

      this.lastSeqBySessionId.set(client.sessionId, message.seq);
      this.latestInputBySessionId.set(client.sessionId, message);
    });

    this.onMessage("debug_colliders_subscribe", (client: Client) => {
      this.debugSubscribers.add(client.sessionId);
      this.sendCollisionDebugSnapshot(client, true);
    });

    this.onMessage("debug_colliders_unsubscribe", (client: Client) => {
      this.debugSubscribers.delete(client.sessionId);
      this.debugMapSentSubscribers.delete(client.sessionId);
    });

    this.onMessage("debug_colliders_pull", (client: Client) => {
      this.sendCollisionDebugSnapshot(client);
    });
  }

  /**
   * 玩家加入回调：创建玩家实体，并写入 players 状态以便客户端获取自身 entityId。
   *
   * @param client Colyseus 客户端连接
   */
  onJoin(client: Client): void {
    const playerSpawn = this.world.map?.spawns.player ?? { x: 0, y: 0 };
    const { componentRegistry, archetypeRegistry } = getRegistries();
    const archetype = archetypeRegistry.get("player");
    const eid = spawnEntity(this.world, archetype, componentRegistry, { x: playerSpawn.x, y: playerSpawn.y });
    this.playerEidBySessionId.set(client.sessionId, eid);

    const playerState = new PlayerState();
    playerState.sessionId = client.sessionId;
    playerState.entityId = NetworkId.value[eid];
    this.state.players.set(client.sessionId, playerState);
  }

  /**
   * 玩家离开回调：回收玩家实体、清理输入缓存与状态映射。
   *
   * @param client Colyseus 客户端连接
   */
  onLeave(client: Client): void {
    const eid = this.playerEidBySessionId.get(client.sessionId);
    if (typeof eid === "number") {
      const networkId = NetworkId.value[eid];
      this.state.entities.delete(String(networkId));
      removeEntity(this.world, eid);
    }

    this.playerEidBySessionId.delete(client.sessionId);
    this.lastSeqBySessionId.delete(client.sessionId);
    this.latestInputBySessionId.delete(client.sessionId);
    this.debugSubscribers.delete(client.sessionId);
    this.debugMapSentSubscribers.delete(client.sessionId);
    this.state.players.delete(client.sessionId);
  }

  /**
   * 获取服务端当前帧的碰撞调试快照。
   *
   * @param options 快照裁剪选项
   * @returns 可序列化的碰撞体列表与 tick 信息
   */
  getCollisionDebugSnapshot(options?: { includeMapBodies?: boolean }): CollisionDebugSnapshot {
    return getCollisionDebugSnapshot(this.world, options);
  }

  /**
   * 单帧推进：更新 tick 时间、应用输入、执行系统、同步状态，并记录性能指标。
   *
   * @param deltaTimeMs Colyseus 提供的间隔时间（毫秒）
   * @param fixedDtMs 兜底固定步长（毫秒）
   */
  private step(deltaTimeMs: number, fixedDtMs: number): void {
    const start = performance.now();

    this.applyInputs();
    this.gameInstance.step(deltaTimeMs || fixedDtMs);

    this.syncState();
    this.pushCollisionDebugSnapshots(deltaTimeMs || fixedDtMs);

    const tickMs = performance.now() - start;
    recordTick(this.world.metrics, tickMs);

    if (tickMs > fixedDtMs * 1.5) {
      this.world.logger.warn("单帧耗时过高", {
        tick: this.world.time.tick,
        tickMs,
        fixedDtMs,
      });
    }
  }

  /**
   * 将缓存的最新输入写入 ECS。
   *
   * 当前实现为最小示例：直接把 moveX/moveY 写入 Velocity.vx/vy。
   * 后续可替换为更完整的“意图组件/加速度/摩擦”等输入建模方式。
   */
  private applyInputs(): void {
    for (const [sessionId, input] of this.latestInputBySessionId) {
      const eid = this.playerEidBySessionId.get(sessionId);
      if (typeof eid !== "number") continue;

      Velocity.vx[eid] = input.moveX;
      Velocity.vy[eid] = input.moveY;
    }
  }

  /**
   * 将 ECS 的权威状态写回 RoomState，以触发 Colyseus 的增量同步。
   *
   * 策略：
   * - 使用 NetworkId 作为 entities 的稳定 key（字符串化）
   * - 存量实体复用 EntityState，只更新字段，避免每 tick 重建对象
   * - 通过 alive 集合清理已被移除的实体
   */
  private syncState(): void {
    this.state.tick = this.world.time.tick;

    const alive = new Set<string>();

    for (const eid of query(this.world, [NetworkId, Transform, Health, Collider, Size])) {
      const id = NetworkId.value[eid];
      const key = String(id);
      alive.add(key);

      let entityState = this.state.entities.get(key);
      if (!entityState) {
        entityState = new EntityState();
        entityState.id = id;
        this.state.entities.set(key, entityState);
      }

      entityState.x = Transform.x[eid];
      entityState.y = Transform.y[eid];
      entityState.hp = Health.current[eid];
      entityState.shape = Collider.shape[eid];
      entityState.radius = Collider.radius[eid];
      entityState.w = Size.w[eid];
      entityState.h = Size.h[eid];
    }

    this.state.entities.forEach((_value: EntityState, key: string) => {
      if (!alive.has(key)) this.state.entities.delete(key);
    });
  }

  /**
   * 按固定间隔向已订阅的客户端推送碰撞调试快照。
   *
   * @param deltaTimeMs 本次 tick 的步长（毫秒）
   */
  private pushCollisionDebugSnapshots(deltaTimeMs: number): void {
    if (this.debugSubscribers.size === 0) return;

    this.debugPushCooldownMs += deltaTimeMs;
    if (this.debugPushCooldownMs < DEBUG_COLLIDERS_PUSH_INTERVAL_MS) {
      return;
    }
    this.debugPushCooldownMs = 0;

    const snapshot = this.getCollisionDebugSnapshot({ includeMapBodies: false });
    for (const client of this.clients) {
      if (!this.debugSubscribers.has(client.sessionId)) continue;
      client.send("debug_colliders_snapshot", snapshot);
    }
  }

  /**
   * 向指定客户端发送当前帧碰撞调试快照。
   *
   * @param client Colyseus 客户端连接
   */
  private sendCollisionDebugSnapshot(client: Client, forceIncludeMapBodies = false): void {
    const includeMapBodies =
      forceIncludeMapBodies || !this.debugMapSentSubscribers.has(client.sessionId);
    client.send(
      "debug_colliders_snapshot",
      this.getCollisionDebugSnapshot({ includeMapBodies }),
    );
    if (includeMapBodies) {
      this.debugMapSentSubscribers.add(client.sessionId);
    }
  }
}
