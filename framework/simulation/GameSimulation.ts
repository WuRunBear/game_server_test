import { query, removeEntity } from "bitecs";
import { NetworkId, Velocity } from "components";
import { spawnEntity } from "framework/entities/spawn";
import { createGameInstance, type GameInstance } from "framework/bootstrap/GameInstance";
import type { LoadedGameDefinition } from "framework/config/schema/GameDefinitionSchema";
import { getCollisionDebugSnapshot } from "systems/core/collisionSystem";
import { recordTick } from "framework/metrics";
import type { ComponentRegistry } from "framework/components/componentRegistry";
import type { ArchetypeRegistry } from "framework/entities/archetypeRegistry";
import type { EntityId, GameWorld } from "world";

import type { SimulationPort } from "./SimulationPort";
import type {
  PlayerInput, PlayerJoinResult, TickSnapshot, TickResult, DebugSnapshotOptions,
} from "./types";

/**
 * 游戏仿真——SimulationPort 的具体实现，封装了 GameInstance 和所有 ECS 操作。
 *
 * ## 它在架构中的位置
 *
 * ```
 * 传输层（GameRoom / HeadlessHost）
 *         │  只调 SimulationPort 接口
 *         ▼
 *  GameSimulation  ← 你在这里
 *         │  持有 GameInstance
 *         ▼
 *  GameInstance → systems[] → ECS World (bitecs)
 * ```
 *
 * GameSimulation 是传输层和 ECS 之间的"隔离墙"：
 * - 传输层看不到 bitecs、GameWorld、SoA 数组
 * - 所有 spawn/remove/query/写组件 的操作都封在这个类里
 * - 对外只输出纯数据 DTO（TickSnapshot、PlayerJoinResult）
 *
 * ## 主要职责
 *
 * 1. **玩家管理**：`addPlayer()` 创建玩家实体，`removePlayer()` 销毁并清理
 * 2. **输入处理**：`submitInput()` 接收 + seq 去重，`applyInputs()` 写入 ECS
 * 3. **快照构建**：`buildSnapshot()` 用 bitecs query 遍历实体，读取配置的同步字段
 * 4. **指标记录**：`tick()` 中记录性能数据，帧过慢时输出告警
 * 5. **调试支持**：`getDebugSnapshot()` 获取碰撞调试数据
 */
export class GameSimulation implements SimulationPort {
  /** 底层仿真实例（持有 ECS world + 系统列表） */
  private instance: GameInstance;

  /** ECS world 引用，内部操作需要（spawn/query/remove 等） */
  private world: GameWorld;

  /**
   * sessionId → eid 的映射表。
   *
   * Colyseus 用 sessionId 标识连接，ECS 用 eid 标识实体。
   * 这个 Map 是两者之间的桥梁：收到输入时通过 sessionId 找到 eid，
   * 才能往正确的实体上写 Velocity 组件。
   */
  private playerEidBySessionId = new Map<string, EntityId>();

  /**
   * sessionId → 已接收的最新 seq 号。
   *
   * 用于输入去重：客户端每条消息带一个递增的 seq，服务端只接受
   * seq > 已记录 seq 的消息，防止乱序包和重放攻击。
   */
  private lastSeqBySessionId = new Map<string, number>();

  /**
   * sessionId → 等待下帧应用的最新输入。
   *
   * 输入不会立即生效，而是缓存起来。tick() 的第一步 applyInputs()
   * 会读取这个缓存，把数据写入 ECS 组件。每帧只消费最新一条输入。
   */
  private latestInputBySessionId = new Map<string, PlayerInput>();

  /**
   * 网络同步字段配置（来自 game.json 的 netSync.fields）。
   *
   * 例如：
   * ```json
   * { "component": "Transform", "fields": ["x", "y"] }
   * ```
   * 表示每帧快照要包含 Transform.x 和 Transform.y。
   */
  private netSyncFields: { component: string; fields: string[] }[];

  /**
   * 组件注册表引用，用于 netSync 配置中按名称查找 bitecs 组件对象。
   * 例如 "Transform" → bitecs Transform 组件（一个 SoA 对象）。
   */
  private componentRegistry: ComponentRegistry;

  /**
   * 创建仿真实例。
   *
   * @param gameDef 游戏配置（已通过 loadGameDefinition 加载 + 校验）
   */
  constructor(gameDef: LoadedGameDefinition) {
    this.instance = createGameInstance(gameDef);
    this.world = this.instance.world;
    this.netSyncFields = gameDef.netSync?.fields ?? [];
    this.componentRegistry = this.world.components_registry as ComponentRegistry;
  }

  /**
   * 推进一个逻辑帧——这是整个仿真的核心循环。
   *
   * **执行顺序**（顺序很重要，不能乱）：
   * 1. applyInputs()  — 把缓存的玩家输入写入 ECS（在当前帧系统执行前生效）
   * 2. instance.step() — 运行所有 ECS 系统（move/phys/collision/combat/ai...）
   * 3. buildSnapshot() — 从 ECS world 拉取数据，构建纯数据快照
   * 4. recordTick()   — 记录本帧耗时，用 EMA 更新平均值
   * 5. 慢帧告警        — 如果帧耗时的 1.5x fixedDtMs，输出 warn 日志
   *
   * @param dtMs 本帧步长（毫秒）
   * @returns TickResult（快照 + 性能指标）
   */
  tick(dtMs: number): TickResult {
    const start = performance.now();

    this.applyInputs();
    this.instance.step(dtMs);
    const snapshot = this.buildSnapshot();

    const tickMs = performance.now() - start;

    // 记录性能指标（EMA 滑动平均）
    recordTick(this.world.metrics, tickMs);

    // 帧耗时超过固定步长 1.5 倍 → 告警（可能出现卡顿）
    if (tickMs > this.world.time.fixedDtMs * 1.5) {
      this.world.logger.warn("单帧耗时过高", {
        tick: this.world.time.tick,
        tickMs,
        fixedDtMs: this.world.time.fixedDtMs,
      });
    }

    return {
      snapshot,
      tickMs,
      tick: this.world.time.tick,
      avgTickMs: this.world.metrics.avgTickMs,
    };
  }

  /**
   * 玩家加入——创建玩家实体并返回网络标识。
   *
   * 内部做了三件事：
   * 1. 从地图配置读取玩家出生点（map.spawns.player）
   * 2. 从原型注册表获取 "player" archetype 的组件规格
   * 3. 调用 spawnEntity 创建实体（自动分配 NetworkId + Transform 等组件）
   *
   * @param sessionId Colyseus 连接标识
   * @returns { networkId } 新实体的网络标识
   */
  addPlayer(sessionId: string): PlayerJoinResult {
    // 读取出生点，没有配置则默认 (0, 0)
    const playerSpawn = this.world.map?.spawns.player ?? { x: 0, y: 0 };
    const archetype = (this.world.archetypes as ArchetypeRegistry).get("player");
    const eid = spawnEntity(this.world, archetype, this.componentRegistry, {
      x: playerSpawn.x,
      y: playerSpawn.y,
    });

    // 建立 sessionId → eid 映射，后续输入可以通过 sessionId 找到玩家实体
    this.playerEidBySessionId.set(sessionId, eid);

    return { networkId: NetworkId.value[eid] };
  }

  /**
   * 玩家离开——销毁玩家实体，清理所有关联缓存。
   *
   * 要清理的缓存：
   * - playerEidBySessionId 映射（核心）
   * - lastSeqBySessionId（输入去重）
   * - latestInputBySessionId（待应用输入）
   *
   * @param sessionId Colyseus 连接标识
   */
  removePlayer(sessionId: string): void {
    const eid = this.playerEidBySessionId.get(sessionId);
    if (typeof eid === "number") {
      // bitecs 的 removeEntity 会清空该 eid 上的所有组件数据
      removeEntity(this.world, eid);
    }

    this.playerEidBySessionId.delete(sessionId);
    this.lastSeqBySessionId.delete(sessionId);
    this.latestInputBySessionId.delete(sessionId);
  }

  /**
   * 接收客户端输入——验证序号后缓存，等待下帧 tick 时应用。
   *
   * **seq 去重逻辑**：
   * - 客户端每条输入带一个递增的 seq（自增号）
   * - 服务端记录每个 session 已接收的最大 seq
   * - 如果收到的 seq ≤ 已记录的 seq → 丢弃（乱序/重复包）
   * - 如果收到的 seq > 已记录的 seq → 更新缓存
   *
   * 这种"每帧只消费最新一条"的策略叫"最新状态优先"，
   * 适合快节奏实时游戏；缺点是会丢弃中间输入（对于需要精确回放的游戏不适用）。
   *
   * @param sessionId Colyseus 连接标识
   * @param input 客户端输入
   */
  submitInput(sessionId: string, input: PlayerInput): void {
    const lastSeq = this.lastSeqBySessionId.get(sessionId) ?? 0;
    if (input.seq <= lastSeq) return;

    this.lastSeqBySessionId.set(sessionId, input.seq);
    this.latestInputBySessionId.set(sessionId, input);
  }

  /**
   * 获取碰撞调试快照。
   *
   * 返回值是 unknown 而非具体类型，因为传输层不需要理解快照结构——
   * 它只是把数据原样用 WebSocket 转发给客户端。如果传输层需要类型安全，
   * 可以 import CollisionDebugSnapshot 类型（但这就引入了对 systems 的依赖）。
   *
   * @param options 调试选项（是否包含地图碰撞体等）
   * @returns 可序列化的碰撞调试数据
   */
  getDebugSnapshot(options?: DebugSnapshotOptions): unknown {
    return getCollisionDebugSnapshot(this.world, options);
  }

  /**
   * 将缓存的最新玩家输入应用到 ECS。
   *
   * **当前实现**：直接把 moveX/moveY 写入 Velocity.vx/vy。
   * 这是最简单的输入模型（"输入 = 直接速度"），适合俯瞰视角游戏。
   *
   * **未来可能的改进**：
   * - 改为"输入 = 加速度" → 写入 Acceleration.ax/ay，由 physicsSystem 处理
   * - 改为"输入 = 方向意图" → 写入 Intent 组件，由 aiSystem 或 movementSystem 处理
   * - 加入摩擦力/最大速度限制
   *
   * 注意：每次 tick 后不清空 latestInputBySessionId。
   * 如果客户端断线（不再发送输入），玩家会保持最后一个输入方向继续移动。
   * 如果需要在断线时停止，可在 removePlayer 或超时逻辑中处理。
   */
  private applyInputs(): void {
    for (const [sessionId, input] of this.latestInputBySessionId) {
      const eid = this.playerEidBySessionId.get(sessionId);
      if (typeof eid !== "number") continue;

      // 直接写入 bitecs SoA 数组：Velocity.vx[eid] 是 eid 号实体的 x 速度
      Velocity.vx[eid] = input.moveX;
      Velocity.vy[eid] = input.moveY;
    }
  }

  /**
   * 从 ECS World 构建快照——读取所有存活实体的同步字段。
   *
   * **bitecs query 机制**（初学者理解这个很重要）：
   *
   * bitecs 实体是一个整数（eid），组件是 SoA（Structure of Arrays）——
   * 每种组件属性的所有实体值存在一个数组中。例如：
   * ```
   * Transform.x = [undefined, 100, 200, 50, ...]
   *    索引 eid=1 的 x 值是 100
   *    索引 eid=2 的 x 值是 200
   * ```
   *
   * `query(world, [ComponentA, ComponentB])` 返回同时拥有这些组件的所有 eid。
   *
   * **buildSnapshot 的工作流程**：
   * 1. 根据 netSync 配置构造 query 的组件列表：[NetworkId, Transform, Health, ...]
   * 2. 调用 bitecs query 获取所有需要同步的实体 eid
   * 3. 对每个实体：通过 NetworkId.value[eid] 获取稳定 ID，通过 comp[field][eid] 读字段值
   * 4. 组装成 TickSnapshot DTO
   *
   * @returns 本帧纯数据快照（无 bitecs/ECS 依赖）
   */
  private buildSnapshot(): TickSnapshot {
    const tick = this.world.time.tick;
    const entities = new Map<number, Record<string, number>>();

    // 如果 game.json 没有配置 netSync 字段，返回空快照（客户端看不到实体）
    if (this.netSyncFields.length === 0) return { tick, entities };

    // 构建 bitecs query 组件列表
    // NetworkId 是必需的——它是快照中实体的 key
    const queryComponents: unknown[] = [NetworkId];
    for (const field of this.netSyncFields) {
      if (this.componentRegistry.has(field.component)) {
        queryComponents.push(this.componentRegistry.get(field.component));
      }
    }

    // 遍历每一个同时拥有 NetworkId + 配置组件的实体
    for (const eid of query(this.world, queryComponents)) {
      const id = NetworkId.value[eid]; // 稳定网络 ID（不等于 eid）
      const values: Record<string, number> = {};

      // 读取 netSync 配置的每个字段值
      for (const field of this.netSyncFields) {
        // 从注册表拿到 bitecs 组件对象（如 Transform 组件）
        const comp = this.componentRegistry.get(field.component) as
          Record<string, unknown> | undefined;
        if (!comp) continue;

        for (const fname of field.fields) {
          // 组件对象是一个 SoA 结构：comp.x = [undefined, 100, 200, ...]
          // comp.x[eid] 就是 eid 号实体的 x 值
          const arr = (comp as Record<string, { [eid: number]: number }>)[fname];
          if (typeof arr === "object" && eid in arr) {
            // key 格式："Transform.x"、"Health.current" 等
            values[`${field.component}.${fname}`] = arr[eid];
          }
        }
      }

      entities.set(id, values);
    }

    return { tick, entities };
  }
}

/**
 * 创建仿真实例的工厂函数。
 *
 * 遵循框架中 createGameInstance / createGameWorld 的命名惯例。
 * 返回 SimulationPort 接口类型而非具体类，外部代码只依赖接口。
 *
 * @param gameDef 已加载和校验的游戏配置
 * @returns 仿真端口实例
 */
export function createGameSimulation(gameDef: LoadedGameDefinition): SimulationPort {
  return new GameSimulation(gameDef);
}
