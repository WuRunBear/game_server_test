import { query } from "bitecs";
import { NetworkId, Velocity, Inventory, Intent, Health } from "components";
import { spawnEntity } from "framework/entities/spawn";
import { destroyEntity } from "framework/entities/destroyEntity";
import { createGameInstance, type GameInstance } from "framework/bootstrap/GameInstance";
import type { LoadedGameDefinition } from "framework/config/schema/GameDefinitionSchema";
import { getCollisionDebugSnapshot } from "systems/core/collisionSystem";
import { recordTick } from "framework/metrics";
import type { ComponentRegistry } from "framework/components/componentRegistry";
import type { ArchetypeRegistry } from "framework/entities/archetypeRegistry";
import type { EntityId, GameWorld } from "world";
import { consumeSlot, dropSlot, transferSlot } from "framework/systems/gameplay/inventoryOps";
import { equipSlot } from "framework/systems/gameplay/equipmentSystem";
import { craftRecipe } from "framework/systems/gameplay/craftingSystem";
import { placeEntity } from "framework/systems/gameplay/placeableSystem";
import { getAosSyncAdapter } from "framework/simulation/aosSyncAdapters";
import { serializeWorld, restoreWorld } from "framework/persistence/worldSerializer";
import type { Repository } from "framework/repository";
import type { ServerRule } from "framework/config/schema/RuleSchema";
import { computeInterest } from "./interest";
import { createInputGuard, type InputGuard } from "./inputValidation";

import type { SimulationPort } from "./SimulationPort";
import type {
  PlayerInput, PlayerJoinResult, TickSnapshot, TickResult, DebugSnapshotOptions, PlayerCommand, EntitySnapshot,
  SimulationOptions,
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
 * 2. **输入处理**：`submitInput()` 接收 + seq 去重，`applyInputs()` 写入 ECS；`submitCommand()` 处理离散动作
 * 3. **快照构建**：`buildSnapshot()` 用配置的 netSync 字段从 ECS 派生快照（含 AoS 适配）
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
  private netSyncFields: { component: string; fields: string[]; tags?: string[] }[];

  /**
   * 组件注册表引用，用于 netSync 配置中按名称查找 bitecs 组件对象。
   * 例如 "Transform" → bitecs Transform 组件（一个 SoA 对象）。
   */
  private componentRegistry: ComponentRegistry;

  /** 持久化仓储（可选；缺省不接存档）。 */
  private repository?: Repository;

  /** 存档标识（配合 repository 用于定时存档）。 */
  private saveId?: string;

  /** 距上次存档累计毫秒（按 world.time.dtMs 累加）。 */
  private sinceLastSaveMs = 0;

  /** 自动存档间隔（毫秒，来自 rules/server.json）；缺省不自动存档。 */
  private saveIntervalMs?: number;

  /** 兴趣管理视野半径（来自 rules/server.json）；缺省不裁剪。 */
  private viewRadius?: number;

  /** 输入校验器（速度上限 + 命令频率限流；无规则时全放行）。 */
  private inputGuard: InputGuard;

  /** 读档恢复出的、尚未绑定 session 的玩家实体 eid 队列（addPlayer 时复用）。 */
  private orphanPlayerEids: number[] = [];

  /**
   * 创建仿真实例。
   *
   * @param gameDef 游戏配置（已通过 loadGameDefinition 加载 + 校验）
   * @param options 可选注入（持久化仓储/存档标识/启动恢复快照）
   */
  constructor(gameDef: LoadedGameDefinition, options?: SimulationOptions) {
    this.instance = createGameInstance(gameDef);
    this.world = this.instance.world;
    this.netSyncFields = gameDef.netSync?.fields ?? [];
    this.componentRegistry = this.world.components_registry as ComponentRegistry;

    this.repository = options?.repository;
    this.saveId = options?.saveId;
    if (options?.initialRecord) {
      this.orphanPlayerEids = restoreWorld(this.world, options.initialRecord);
    }

    const serverRules = this.world.gameDef.resolvedRules["server"] as ServerRule | undefined;
    this.saveIntervalMs = serverRules?.saveIntervalMs;
    this.viewRadius = serverRules?.viewRadius;
    const tickRate = this.world.time.fixedDtMs > 0 ? Math.max(1, Math.round(1000 / this.world.time.fixedDtMs)) : 20;
    this.inputGuard = createInputGuard(serverRules, tickRate);
  }

  /**
   * 推进一个逻辑帧——这是整个仿真的核心循环。
   *
   * **执行顺序**（顺序很重要，不能乱）：
   * 1. applyInputs()  — 把缓存的玩家输入写入 ECS（在当前帧系统执行前生效）
   * 2. instance.step() — 运行所有 ECS 系统（move/phys/collision/combat/ai...）
   * 3. buildSnapshot() — 从 ECS world 拉取数据，构建纯数据快照
   * 4. recordTick()   — 记录本帧耗时，用 EMA 更新平均值
   * 5. 帧耗时告警       — 如果帧耗时超过固定步长 1.5x 或 step 抛异常，输出告警
   *
   * **错误隔离**：若 applyInputs 或 step 抛异常，catch 后记录日志，
   * 降级构建快照（使用系统执行到一半的状态），不中断 tick 循环。
   *
   * @param dtMs 本帧步长（毫秒）
   * @returns TickResult（快照 + 性能指标）
   */
  tick(dtMs: number): TickResult {
    const start = performance.now();

    let stepFailed = false;
    try {
      this.applyInputs();
      this.instance.step(dtMs);
    } catch (err) {
      stepFailed = true;
      this.world.logger.error("tick 执行失败", {
        tick: this.world.time.tick,
        error: err instanceof Error ? err.stack : String(err),
      });
    }

    const snapshot = this.buildSnapshot();
    const tickMs = performance.now() - start;

    recordTick(this.world.metrics, tickMs);

    if (stepFailed) {
      this.world.logger.warn("tick 已降级（使用部分状态快照）", {
        tick: this.world.time.tick,
        tickMs,
      });
    } else if (tickMs > this.world.time.fixedDtMs * 1.5) {
      this.world.logger.warn("单帧耗时过高", {
        tick: this.world.time.tick,
        tickMs,
        fixedDtMs: this.world.time.fixedDtMs,
      });
    }

    this.maybeAutosave(dtMs);

    let interest: Map<string, number[]> | undefined;
    if (this.viewRadius !== undefined && this.playerEidBySessionId.size > 0) {
      interest = computeInterest(this.world, this.playerEidBySessionId, snapshot, this.viewRadius);
    }

    return {
      snapshot,
      tickMs,
      tick: this.world.time.tick,
      avgTickMs: this.world.metrics.avgTickMs,
      interest,
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
    let eid: number;

    // 读档恢复的玩家实体优先复用绑定（networkId 保持存档值，进度不丢）；
    // 队列空时按现有逻辑新建玩家实体。
    if (this.orphanPlayerEids.length > 0) {
      eid = this.orphanPlayerEids.shift()!;
    } else {
      // 读取出生点，没有配置则默认 (0, 0)
      const playerSpawn = this.world.map?.spawns.player ?? { x: 0, y: 0 };
      const archetype = (this.world.archetypes as ArchetypeRegistry).get("player");
      eid = spawnEntity(this.world, archetype, this.componentRegistry, {
        x: playerSpawn.x,
        y: playerSpawn.y,
      });
    }

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
      // destroyEntity 同时清理 AoS 残留（防 eid 复用后被序列化进存档）
      destroyEntity(this.world, eid);
    }

    this.playerEidBySessionId.delete(sessionId);
    this.lastSeqBySessionId.delete(sessionId);
    this.latestInputBySessionId.delete(sessionId);
    this.inputGuard.removeSession(sessionId);
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

    // 输入校验（anti-cheat）：超速输入被拒且不推进 seq，客户端无法靠重发绕过
    if (!this.inputGuard.validateMove(input)) {
      this.world.logger.warn("输入被拒：超出移动速度上限", {
        sessionId,
        speed: Math.hypot(input.moveX, input.moveY),
      });
      return;
    }

    this.lastSeqBySessionId.set(sessionId, input.seq);
    this.latestInputBySessionId.set(sessionId, input);
  }

  /**
   * 提交玩家命令（离散动作）：食用 / 丢弃 / 槽位移动。
   * 立即执行服务端权威变更；立即返回是否成功。
   *
   * @param sessionId Colyseus 连接标识
   * @param command 命令数据（consume/drop/transfer）
   */
  submitCommand(sessionId: string, command: PlayerCommand): boolean {
    const eid = this.playerEidBySessionId.get(sessionId);
    if (typeof eid !== "number") return false;

    // 死亡/重生窗口内（原地重置语义，实体未移除）不执行背包命令——
    // 与 applyInputs / interactionSystem 的死亡守卫语义一致，防幽灵操作
    if ((Health.current[eid] ?? 0) <= 0) return false;

    // 输入校验（anti-cheat）：命令频率超限被拒并日志
    if (!this.inputGuard.submitCommandAllowed(sessionId, this.world.time.tick)) {
      this.world.logger.warn("命令被拒：超出频率上限", {
        sessionId,
        type: command.type,
        tick: this.world.time.tick,
      });
      return false;
    }

    switch (command.type) {
      case "consume":
        return consumeSlot(this.world, eid, command.slot ?? -1);
      case "drop":
        return dropSlot(this.world, eid, command.slot ?? -1);
      case "transfer":
        return transferSlot(
          Inventory[eid]!,
          command.slot ?? -1,
          command.toSlot ?? -1,
          (kind) => this.world.gameDef.itemsByKind?.get(kind)?.maxStack ?? 1,
        );
      case "equip":
        return equipSlot(this.world, eid, command.slot ?? -1);
      case "craft":
        return craftRecipe(this.world, eid, command.recipe ?? "");
      case "place":
        return placeEntity(this.world, eid, command.slot ?? -1, command.x ?? 0, command.y ?? 0);
      default:
        return false;
    }
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
   * 定时存档：按累计 dtMs 达到 saveIntervalMs 时序列化并写盘。
   *
   * 序列化同步完成（快照一致性），写盘 fire-and-forget（异步 I/O 不入 ECS 系统）；
   * 未注入 repository / 未配置间隔时 no-op。
   *
   * @param dtMs 本帧步长
   */
  private maybeAutosave(dtMs: number): void {
    if (!this.repository || !this.saveId || this.saveIntervalMs === undefined) return;

    this.sinceLastSaveMs += dtMs;
    if (this.sinceLastSaveMs < this.saveIntervalMs) return;
    this.sinceLastSaveMs = 0;

    const record = serializeWorld(this.world, this.saveId);
    void this.repository.saveWorld(record).catch((err) => {
      this.world.logger.error("存档写入失败", {
        saveId: this.saveId,
        error: err instanceof Error ? err.stack : String(err),
      });
    });
  }

  /**
   * 将缓存的最新玩家输入应用到 ECS。
   *
   * **脉冲式输入模型**：
   * 1. 先清零所有 player 实体的 Velocity（无输入 → 停止）
   * 2. 应用当帧收到的最新输入
   * 3. 清空输入缓存（下一帧无新输入则保持停止）
   *
   * 与旧实现的差异：旧实现不清空缓存，导致断线后玩家持续移动。
   * 现在改为每帧"消费即丢弃"，每个输入只生效一帧。
   *
   * 另外：若 input.interact 为真，写入 Intent[eid] = "interact"，
   * 由 interactionSystem 在本帧 step 内消费。
   */
  private applyInputs(): void {
    for (const eid of this.playerEidBySessionId.values()) {
      Velocity.vx[eid] = 0;
      Velocity.vy[eid] = 0;
    }

    for (const [sessionId, input] of this.latestInputBySessionId) {
      const eid = this.playerEidBySessionId.get(sessionId);
      if (typeof eid !== "number") continue;
      // 死亡/重生窗口内（原地重置语义，实体未移除）：不接收移动与意图输入
      if ((Health.current[eid] ?? 0) <= 0) continue;
      Velocity.vx[eid] = input.moveX;
      Velocity.vy[eid] = input.moveY;
      // 交互/攻击意图：本帧按下则置位，由 interactionSystem 在 step 中消费并清空
      if (input.interact) {
        Intent[eid] = "interact";
      }
      if (input.attack) {
        Intent[eid] = "attack";
      }
    }

    this.latestInputBySessionId.clear();
  }

  /**
   * 从 ECS World 构建快照——读取所有存活实体的同步字段。
   *
   * **OR 语义**：按每个 netSync 条目独立查询并合并，实体只要命中任一条目
   * 的限定条件就会被同步对应字段。历史单一 AND-query 会把"缺一个同步组件
   * 的实体"整体排除（如裸 Transform 的 item 实体对客户端不可见），已废弃。
   *
   * **两条数据路径**：
   * - SoA 组件（bitecs）：按该组件 query，读 `comp[field][eid]` 标量数值
   * - AoS 组件（JS 数组）：按 entry.tags 限定 query 范围，交 aosSyncAdapter
   *   展平为 `{ numbers, strings }`，字符串写入 stringValues（见 EntityState）
   *
   * @returns 本帧纯数据快照（无 bitecs/ECS 依赖）
   */
  private buildSnapshot(): TickSnapshot {
    const tick = this.world.time.tick;
    const entities = new Map<number, EntitySnapshot>();

    // 无同步配置 → 空快照（客户端看不到实体）
    if (this.netSyncFields.length === 0) {
      return { tick, entities, timeOfDay: { ...this.world.time.timeOfDay } };
    }
    for (const field of this.netSyncFields) {
      const comp = this.componentRegistry.get(field.component) as
        | Record<string, unknown>
        | unknown[]
        | undefined;
      if (!comp) continue;

      const ensure = (id: number): EntitySnapshot => {
        let snap = entities.get(id);
        if (!snap) {
          snap = { values: {}, strings: {} };
          entities.set(id, snap);
        }
        return snap;
      };

      if (Array.isArray(comp)) {
        // AoS 组件：通过 tags 限定查询范围，再交适配器展平为 numbers/strings
        const adapter = getAosSyncAdapter(field.component);
        if (!adapter) continue;
        for (const eid of this.queryByTags(field.tags)) {
          const snap = ensure(NetworkId.value[eid]);
          const result = adapter(this.world, eid, field.fields);
          Object.assign(snap.values, result.numbers);
          Object.assign(snap.strings, result.strings);
        }
        continue;
      }

      // SoA 组件：按该组件查询实体（含 NetworkId），读标量数值
      for (const eid of query(this.world, [NetworkId, comp as object])) {
        const id = NetworkId.value[eid];
        const snap = ensure(id);
        for (const fname of field.fields) {
          const arr = (comp as Record<string, { [eid: number]: number }>)[fname];
          if (typeof arr === "object" && eid in arr) {
            snap.values[`${field.component}.${fname}`] = arr[eid];
          }
        }
      }
    }

    return {
      tick,
      entities,
      timeOfDay: { ...this.world.time.timeOfDay },
    };
  }

  /**
   * 按 netSync 条目的 tags 限定查询实体（始终含 NetworkId）。
   * tags 提供 AoS 适配查询范围（如 ItemMeta 仅查 [Item] 实体）；
   * 不提供 tags 时返回所有带 NetworkId 的实体，由适配器判断 AoS 数据是否在。
   */
  private queryByTags(tags: readonly string[] | undefined): ReturnType<typeof query> {
    const comps: object[] = [NetworkId];
    if (tags) {
      for (const t of tags) {
        if (this.componentRegistry.has(t)) {
          comps.push(this.componentRegistry.get(t) as object);
        }
      }
    }
    return query(this.world, comps);
  }
}

/**
 * 创建仿真实例的工厂函数。
 *
 * 遵循框架中 createGameInstance / createGameWorld 的命名惯例。
 * 返回 SimulationPort 接口类型而非具体类，外部代码只依赖接口。
 *
 * @param gameDef 已加载和校验的游戏配置
 * @param options 可选注入（持久化仓储/存档标识/启动恢复快照）
 * @returns 仿真端口实例
 */
export function createGameSimulation(
  gameDef: LoadedGameDefinition,
  options?: SimulationOptions,
): SimulationPort {
  return new GameSimulation(gameDef, options);
}