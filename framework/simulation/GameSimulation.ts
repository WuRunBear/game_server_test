/**
 * 仿真层实现——SimulationPort 接口的具体实现（类级 JSDoc 见下方 GameSimulation，
 * 完整说明架构位置、玩家管理/输入处理/快照构建/持久化等职责，此处不重复）。
 */
import { query, hasComponent, addComponent, removeComponent } from "bitecs";
import { NetworkId, Velocity, Inventory, Intent, Health, entityMapOf, SpawnPoint, Player } from "components";
import { entityLevelOf } from "framework/components/entityLevel";
import { Offline, isOfflineRetained } from "components/offline";
import { spawnEntity } from "framework/entities/spawn";
import { destroyEntity } from "framework/entities/destroyEntity";
import { createGameInstance, type GameInstance } from "framework/bootstrap/GameInstance";
import type { LoadedGameDefinition } from "framework/config/schema/GameDefinitionSchema";
import type { MapConfig } from "framework/config/schema/MapRegistrySchema";
import { pickSpawnPosition } from "map/runtime/spawn";
import { getCollisionDebugSnapshot } from "systems/core/collisionSystem";
import { recordTick } from "framework/metrics";
import type { ComponentRegistry } from "framework/components/componentRegistry";
import type { ArchetypeRegistry } from "framework/entities/archetypeRegistry";
import type { EntityId, GameWorld } from "world";
import { consumeSlot, dropSlot, transferSlot, lootContainerSlot } from "framework/systems/gameplay/inventoryOps";
import { equipSlot } from "framework/systems/gameplay/equipmentSystem";
import { craftRecipe, stepCraftingJobs, cancelCrafting, validateCraftingRules } from "framework/systems/gameplay/craftingSystem";
import { stepFuelBurn, refuelStation, validateFuelRules } from "framework/systems/gameplay/fuelSystem";
import { placeEntity } from "framework/systems/gameplay/placeableSystem";
import { deconstructEntity } from "framework/systems/gameplay/deconstructSystem";
import { advanceDialogue } from "framework/systems/gameplay/dialogueSystem";
import { getAosSyncAdapter } from "framework/simulation/aosSyncAdapters";
import { serializeWorld, restoreWorld } from "framework/persistence/worldSerializer";
import { evolve } from "map/evolution/engine";
import { createMapEvolveDeps } from "map/runtime/evolveDeps";
import { mapSeedOf } from "map/runtime/mapSeeds";
import { advanceTickTo, computeOfflineTicks } from "map/runtime/clock";
import { noopBootDeps, type BootDeps } from "map/runtime/boot";
import { fastForwardStateMachines } from "framework/simulation/stateMachine/stateMachineSystem";
import { fastForwardPopulations } from "framework/simulation/population/populationSystem";
import type { Repository, WorldRecord } from "framework/repository";
import type { ServerRule } from "framework/config/schema/RuleSchema";
import { computeInterest } from "./interest";
import { createInputGuard, type InputGuard } from "./inputValidation";
import { openOffer, acceptOffer, cancelOffer } from "framework/economy/offer";
import { queueEvent } from "framework/simulation/events/eventBus";
import { mixSeed } from "framework/simulation/rng";
import { createLogger } from "framework/utils/logger";

/** 装配期日志器（world.logger 尚不可用的开机阶段使用）。 */
const assemblyLogger = createLogger("game-simulation");

/**
 * 离线补差 tick 上限缺省值：按缺省 tickRate=20 折算约 24 小时真实离线时长
 * （20 × 60 × 60 × 24 = 1,728,000 tick）。超过该上限的停服时长不再全额补差
 * （computeOfflineTicks 截断到上限并告警）——防超长停服的演化成本悬崖。
 */
export const DEFAULT_MAX_OFFLINE_TICKS = 1_728_000;

/**
 * 断线保留缺省时长（秒）：rules/server.json 未配置 offlineRetentionTicks 时
 * 生效，按 tickRate 折算为 tick（20tps 下 = 6000 tick）。防闪断丢进度的
 * 缺省保留窗口；0 配置值表示维持旧行为（断线立即销毁）。
 */
export const DEFAULT_OFFLINE_RETENTION_SEC = 300;

import type { SimulationPort } from "./SimulationPort";
import type {
  PlayerInput, PlayerJoinResult, PlayerJoinOptions, TickSnapshot, TickResult, DebugSnapshotOptions, PlayerCommand, EntitySnapshot,
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
 * 1. **玩家管理**：`addPlayer()` 创建/复用玩家实体，`removePlayer()` 按断线
 *    保留策略标记或销毁实体并清理会话缓存；保留到期由 tick 内清扫点销毁
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

  /** 断线保留时长（tick，来自 rules/server.json；0 = 断线立即销毁旧行为）。 */
  private offlineRetentionTicks: number;

  /** 读档恢复出的、尚未绑定 session 的玩家实体 eid 队列（addPlayer 时复用）。 */
  private orphanPlayerEids: number[] = [];

  /** 地图 key → 生成配置（演化钩子按图取 seed）。 */
  private mapConfigsByKey = new Map<string, MapConfig>();

  /** 待冲刷的 on-command 事件缓存（submitCommand 间期产生，下一 tick beforeSystems 入队）。 */
  private pendingCommandEvents: { eid: number; type: string }[] = [];

  /**
   * 创建仿真实例。
   *
   * @param gameDef 游戏配置（已通过 loadGameDefinition 加载 + 校验）
   * @param options 可选注入（持久化仓储/存档标识）
   * @param bootDeps 开机读档单一通道（由 createGameSimulation 装配：预载快照
   *   经 loadRecord 同步注入 bootMaps 与 restoreWorld；缺省无档不落盘）
   */
  constructor(
    gameDef: LoadedGameDefinition,
    options?: SimulationOptions,
    bootDeps: BootDeps = noopBootDeps,
  ) {
    this.instance = createGameInstance(gameDef, bootDeps);
    this.world = this.instance.world;
    this.netSyncFields = gameDef.netSync?.fields ?? [];
    this.componentRegistry = this.world.components_registry as ComponentRegistry;

    this.repository = options?.repository;
    this.saveId = options?.saveId;

    for (const config of gameDef.resolvedMapConfigs ?? []) {
      this.mapConfigsByKey.set(config.key, config);
    }

    const initialRecord = bootDeps.loadRecord();
    if (initialRecord) {
      // 实体/全局时刻/激活集恢复（地图快照回填归 bootMaps，已在
      // createGameInstance → bootMaps 完成）
      this.orphanPlayerEids = restoreWorld(this.world, initialRecord);
    }

    const serverRules = this.world.gameDef.resolvedRules["server"] as ServerRule | undefined;
    this.saveIntervalMs = serverRules?.saveIntervalMs;
    this.viewRadius = serverRules?.viewRadius;
    const tickRate = this.world.time.fixedDtMs > 0 ? Math.max(1, Math.round(1000 / this.world.time.fixedDtMs)) : 20;
    this.inputGuard = createInputGuard(serverRules, tickRate);

    // 断线保留时长：配置值优先；缺省按 tickRate 折算 5 分钟（防闪断丢进度）。
    this.offlineRetentionTicks = Math.max(
      0,
      Math.floor(serverRules?.offlineRetentionTicks ?? tickRate * DEFAULT_OFFLINE_RETENTION_SEC),
    );

    // 切片 C/E：合成规则（解锁条件/时长）与燃料段配置构造期 fail-fast 校验——
    // 未知条件名/非法参数/非法燃料配置在此即抛，不带病进 tick 循环。
    validateCraftingRules(this.world);
    validateFuelRules(this.world);

    // 离线补差：restore 完成后按墙钟一次性折算离线跨度，逐激活图一次
    // evolve 推到演化边界（与开机初始演化/每 tick 增量共用同一 evolve，D6）。
    if (initialRecord) {
      this.runOfflineCatchUp(initialRecord);
    }

    // 演化钩子：每 tick 对全部激活图按 (tick-1, tick] 跨度补差（常驻语义 D13）。
    // 注入位置见 GameInstance.beforeSystems——位于 tick 自增与系统拓扑序之间。
    // 命令事件冲刷在同一钩子先行：submitCommand 产生的 on-command 事件在
    // 帧首事件总线清空**之后**入队，供同 tick 的 trigger 阶段消费。
    // 同钩子挂切片 C/E 的每 tick 推进：光源燃料燃烧（未配置 fuel 段空转）
    // 与延时制作结算（无任务早退）——均先于系统拓扑序。
    this.instance.beforeSystems = () => {
      this.flushPendingCommandEvents();
      this.evolveActiveMaps();
      stepFuelBurn(this.world);
      stepCraftingJobs(this.world);
    };
  }

  /**
   * 冲刷待发命令事件：把 submitCommand 间期缓存的 on-command 事件
   * 注入类型化事件总线（触发器在同一 tick 的固定阶段消费）。
   */
  private flushPendingCommandEvents(): void {
    if (this.pendingCommandEvents.length === 0) return;
    for (const evt of this.pendingCommandEvents) {
      queueEvent(this.world, "on-command", evt);
    }
    this.pendingCommandEvents = [];
  }

  /**
   * 逐图演化：对 world.activeMaps 中每张已构建图调用 evolve，跨度
   * (fromTick, toTick]。规则/配置缺图时跳过该图。
   *
   * seed 源：bootMaps 解析并写入弱表的每图 seed（读档路径 = 快照固化值，
   * 新档 = 配置值或开机随机值）——快照回填不重建几何，但每 tick/离线补差
   * 的演化选点流必须与存档世界同源；弱表未命中回退配置 seed。
   */
  private evolveMaps(fromTick: number, toTick: number): void {
    const rules = this.world.gameDef.resolvedEntityRules ?? [];
    if (rules.length === 0) return;

    for (const mapKey of this.world.activeMaps) {
      const geometry = this.world.maps[mapKey];
      const config = this.mapConfigsByKey.get(mapKey);
      if (!geometry || !config) continue;
      const seed = mapSeedOf(this.world, mapKey) ?? config.seed ?? 0;
      evolve(this.world, geometry, rules, fromTick, toTick, createMapEvolveDeps(this.world, geometry, seed));
    }
  }

  /** 每 tick 演化钩子：跨度 (tick-1, tick]（见 GameInstance.beforeSystems）。 */
  private evolveActiveMaps(): void {
    const tick = this.world.time.tick;
    this.evolveMaps(tick - 1, tick);
  }

  /**
   * 离线补差（读档路径专用，构造期执行一次）：
   * 1. 墙钟只在此读一次，computeOfflineTicks 把离线时长折算为 tick 数
   *    （超 DEFAULT_MAX_OFFLINE_TICKS 截断并告警）；
   * 2. 对全部激活图一次性 evolve(存档tick → 存档tick+离线ticks)——与开机
   *    初始演化、每 tick 增量共用同一 evolve（D6，唯一动作不变式）；
   * 3. advanceTickTo 把 world.time.tick 推到演化边界——否则下一运行 tick
   *    会重走离线跨度。
   */
  private runOfflineCatchUp(record: WorldRecord): void {
    const offlineTicks = computeOfflineTicks(
      record.savedAt,
      Date.now(),
      this.world.gameDef.tickRate,
      DEFAULT_MAX_OFFLINE_TICKS,
    );
    if (offlineTicks <= 0) return;

    const fromTick = record.tick;
    this.evolveMaps(fromTick, fromTick + offlineTicks);
    // 状态机离线快进：迁移步进（非逐 tick）把全部实体状态机推到演化边界，
    // 落地「读档后状态正确恢复 + 离线等价」——与逐 tick 推进最终状态一致。
    fastForwardStateMachines(this.world, fromTick + offlineTicks);
    // 族群节点离线快进：槽步进（非逐 tick）把全部节点数量推到演化边界——
    // 与逐 tick 推进最终数量/上限/最后演进 tick 完全一致（核心断言）。
    fastForwardPopulations(this.world, fromTick + offlineTicks);
    advanceTickTo(this.world, fromTick + offlineTicks);
    this.world.logger.info("offline catch-up complete", {
      savedTick: fromTick,
      offlineTicks,
      tick: this.world.time.tick,
    });
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

    // 断线保留清扫点：系统循环之后、快照构建之前——到期实体销毁并立即存档，
    // 本帧快照即不含已到期实体（客户端同帧看到移除，无幽灵残留）。
    this.sweepExpiredOfflinePlayers();

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

    // 恒计算 interest：客户端恒按 per-client 可见集同步；
    // viewRadius 缺省时 computeInterest 返回同图全量（todo 11）。
    const interest = computeInterest(
      this.world,
      this.playerEidBySessionId,
      snapshot,
      this.viewRadius,
    );

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
   * 实体来源按优先级：
   * 1. **断线保留实体**：options.networkId 命中保留中的离线实体 → 复用
   *    （清除 Offline 保留标记、恢复会话映射，背包/位置/进度原样保留）
   * 2. **读档 orphan**：restoreWorld 恢复的玩家实体（networkId 保持存档值）
   * 3. **新生成**：按玩家出生规则（game/rules/player.json → resolvedPlayerRule.spawn）
   *    在默认图选出生点（random 每玩家独立随机 / seededRandom 同图同点 /
   *    exact 固定），写入持久化 SpawnPoint 组件，并按 "player" archetype 生成
   *
   * @param sessionId Colyseus 连接标识
   * @param options 可选加入参数（重连复用保留实体的匹配键）
   * @returns { networkId } 玩家实体的网络标识
   */
  addPlayer(sessionId: string, options?: PlayerJoinOptions): PlayerJoinResult {
    let eid: number | undefined;

    // 1) 断线保留实体：按客户端自报 networkId 匹配（Player 限定，防误挂非玩家实体）
    if (typeof options?.networkId === "number") {
      const retained = [...query(this.world, [NetworkId, Player, Offline])].find(
        (candidate) => NetworkId.value[candidate] === options.networkId,
      );
      if (retained !== undefined) {
        eid = retained;
        removeComponent(this.world, eid, Offline);
        this.world.logger.info("重连复用断线保留实体", {
          sessionId,
          eid,
          networkId: NetworkId.value[eid],
        });
      } else {
        // 提示键未命中（实体已到期销毁/存档恢复前断线等）：降级常规路径
        this.world.logger.warn("重连提示 networkId 未命中保留实体，走常规加入", {
          sessionId,
          networkId: options.networkId,
        });
      }
    }

    // 2) 读档恢复的玩家实体优先复用绑定（networkId 保持存档值，进度不丢）；
    // 持久化出生点已随存档恢复，复用路径不重新选点。
    if (eid === undefined && this.orphanPlayerEids.length > 0) {
      eid = this.orphanPlayerEids.shift()!;
    }

    // 3) 新生成
    if (eid === undefined) {
      eid = this.spawnNewPlayer();
    }

    // 建立 sessionId → eid 映射，后续输入可以通过 sessionId 找到玩家实体
    this.playerEidBySessionId.set(sessionId, eid);

    return { networkId: NetworkId.value[eid] };
  }

  /** 新生成玩家实体（出生点选择 + SpawnPoint 落盘 + archetype 生成）。 */
  private spawnNewPlayer(): number {
    const geometry = this.world.maps[this.world.defaultMapId];
    const rule = this.world.gameDef.resolvedPlayerRule?.spawn;
    // random 模式确定性种子：世界/地图 seed + 玩家标识（nextNetworkId，稳定且逐玩家不同）
    const spawnSeed = mixSeed(
      mapSeedOf(this.world, this.world.defaultMapId) ?? this.world.defaultMapId,
      this.world.nextNetworkId,
    );
    const picked =
      geometry && rule ? pickSpawnPosition(geometry, rule, spawnSeed) : undefined;
    if (geometry && rule && !picked) {
      // 候选池为空（区域缺失/全不可走）：显式报错，回退地图几何中心
      this.world.logger.error("玩家出生规则无合法候选点，回退地图几何中心", {
        mapId: this.world.defaultMapId,
        mode: rule.mode,
        region: rule.region ?? null,
      });
    }
    const playerSpawn = picked ?? (geometry
      ? {
          x: (geometry.grid.width / 2) * geometry.grid.tileWidth,
          y: (geometry.grid.height / 2) * geometry.grid.tileHeight,
        }
      : { x: 0, y: 0 });
    const archetype = (this.world.archetypes as ArchetypeRegistry).get("player");
    const eid = spawnEntity(this.world, archetype, this.componentRegistry, {
      x: playerSpawn.x,
      y: playerSpawn.y,
      mapId: this.world.defaultMapId,
    });
    // 持久化出生点：Transform 会被移动覆盖，重生（respawnSystem）读本字段
    SpawnPoint[eid] = { mapId: this.world.defaultMapId, x: playerSpawn.x, y: playerSpawn.y };
    return eid;
  }

  /**
   * 玩家离开——按断线保留策略处理玩家实体，清理所有会话关联缓存。
   *
   * 实体处理（offlineRetentionTicks 驱动）：
   * - 保留时长 > 0：标记 Offline（瞬态组件，不入档）+ 记录到期 tick，
   *   实体保留在 ECS 中——保留期内对同步与玩法系统不可见（isOfflineRetained
   *   排除点），重连可按 networkId 复用；到期由 sweepExpiredOfflinePlayers
   *   销毁并触发一次立即存档。
   * - 保留时长 = 0：旧行为，立即销毁（destroyEntity 同时清理 AoS 残留，
   *   防 eid 复用后被序列化进存档）。
   *
   * 无论哪种路径都要清理的会话缓存：
   * - playerEidBySessionId 映射（核心）
   * - lastSeqBySessionId（输入去重）
   * - latestInputBySessionId（待应用输入）
   *
   * @param sessionId Colyseus 连接标识
   */
  removePlayer(sessionId: string): void {
    const eid = this.playerEidBySessionId.get(sessionId);
    if (typeof eid === "number") {
      if (this.offlineRetentionTicks > 0) {
        // 保留：挂标记 + 到期 tick（标记是"按标记跳过"排除逻辑的唯一依据）。
        addComponent(this.world, eid, Offline);
        Offline.untilTick[eid] = this.world.time.tick + this.offlineRetentionTicks;
        // 脉冲输入模型下，断线实体不再被 applyInputs 清零速度——显式归零，
        // 防止保留期内以最后速度惯性漂移（movement/physics 本身照常运行）。
        Velocity.vx[eid] = 0;
        Velocity.vy[eid] = 0;
      } else {
        destroyEntity(this.world, eid);
      }
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
        return this.finishCommand(eid, command.type, consumeSlot(this.world, eid, command.slot ?? -1));
      case "drop":
        return this.finishCommand(eid, command.type, dropSlot(this.world, eid, command.slot ?? -1));
      case "transfer":
        if (command.target !== undefined) {
          // transfer + target：从目标容器实体的槽位取回物品到本人背包
          // （死亡容器等承载物；同图校验与满包不吞语义见 lootContainerSlot）
          return this.finishCommand(
            eid,
            command.type,
            lootContainerSlot(this.world, eid, command.target, command.slot ?? -1),
          );
        }
        return this.finishCommand(
          eid,
          command.type,
          transferSlot(
            Inventory[eid]!,
            command.slot ?? -1,
            command.toSlot ?? -1,
            (kind) => this.world.gameDef.itemsByKind?.get(kind)?.maxStack ?? 1,
          ),
        );
      case "equip":
        return this.finishCommand(eid, command.type, equipSlot(this.world, eid, command.slot ?? -1));
      case "craft":
        return this.finishCommand(eid, command.type, craftRecipe(this.world, eid, command.recipe ?? ""));
      case "craft-cancel":
        // 取消进行中的延时制作（退料原子：放不下则拒绝取消）
        return this.finishCommand(eid, command.type, cancelCrafting(this.world, eid, command.recipe ?? ""));
      case "refuel":
        // 加燃料：附近燃料型站点 + 背包燃料物品（fuel.items 配置声明序）
        return this.finishCommand(eid, command.type, refuelStation(this.world, eid, command.target));
      case "place":
        return this.finishCommand(eid, command.type, placeEntity(this.world, eid, command.slot ?? -1, command.x ?? 0, command.y ?? 0));
      case "deconstruct":
        return this.finishCommand(eid, command.type, deconstructEntity(this.world, eid, command.target ?? -1));
      case "dialogue":
        return this.finishCommand(eid, command.type, advanceDialogue(this.world, eid, command.option ?? -1));
      case "offer": {
        if (!command.offer) return false;
        const expiresTick =
          command.ttlTicks !== undefined && command.ttlTicks > 0
            ? this.world.time.tick + command.ttlTicks
            : undefined;
        // 发起方本人视为已确认；无玩家方即时成立（openOffer 语义）
        const offerId = openOffer(this.world, command.offer, {
          confirmedParties: [eid],
          expiresTick,
        });
        return this.finishCommand(eid, command.type, offerId !== null);
      }
      case "offer-accept":
        return this.finishCommand(eid, command.type, acceptOffer(this.world, eid, command.offerId ?? -1));
      case "offer-cancel":
        return this.finishCommand(eid, command.type, cancelOffer(this.world, eid, command.offerId ?? -1));
      default:
        return false;
    }
  }

  /**
   * 命令收尾：成功时缓存一条 on-command 事件（下一 tick beforeSystems 冲刷
   * 进事件总线，供 on-command 触发器消费），并透传命令结果。
   */
  private finishCommand(eid: number, type: string, success: boolean): boolean {
    if (success) {
      this.pendingCommandEvents.push({ eid, type });
    }
    return success;
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

    this.saveNow("autosave");
  }

  /**
   * 立即存档：序列化当前世界并写盘（fire-and-forget，写盘失败仅记日志）。
   *
   * 复用 maybeAutosave 的序列化/写盘通路（同一 serializeWorld → repository
   * 单一路径），只是绕过间隔门控——断线保留到期销毁时调用一次，把销毁后
   * 的最后世界状态落盘。仅要求 repository + saveId 就绪（不要求配置了
   * saveIntervalMs：到期落盘是保留语义的一部分，与定时存档开关正交）。
   *
   * @param reason 存档触发原因（日志定位用）
   */
  private saveNow(reason: string): void {
    if (!this.repository || !this.saveId) return;

    // 序列化同步完成；写盘 fire-and-forget（异步 I/O 不入 ECS 系统）
    const record = serializeWorld(this.world, this.saveId);
    void this.repository.saveWorld(record).catch((err) => {
      this.world.logger.error("存档写入失败", {
        saveId: this.saveId,
        reason,
        error: err instanceof Error ? err.stack : String(err),
      });
    });
    // 重置定时存档累计：立即存档已落盘，避免紧随其后的重复定时存档
    this.sinceLastSaveMs = 0;
  }

  /**
   * 断线保留清扫点（每 tick 一次，位于系统循环后、快照构建前）：
   * 到期（untilTick ≤ 当前 tick）的保留实体销毁，并触发一次立即存档把
   * 销毁后的最后状态落盘。无保留实体时空转（一次 query）。
   */
  private sweepExpiredOfflinePlayers(): void {
    // 快照展开后销毁：bitecs query 为活迭代器，边查边删不安全
    const expired = [...query(this.world, [NetworkId, Offline])].filter(
      (eid) => Offline.untilTick[eid] <= this.world.time.tick,
    );
    if (expired.length === 0) return;

    for (const eid of expired) {
      const untilTick = Offline.untilTick[eid];
      // destroyEntity 同时清理 AoS 残留（防 eid 复用后被序列化进存档）
      destroyEntity(this.world, eid);
      this.world.logger.info("断线保留到期，实体销毁", {
        eid,
        networkId: NetworkId.value[eid],
        untilTick,
        tick: this.world.time.tick,
      });
    }
    this.saveNow("offline-retention-expired");
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
      if (input.talk) {
        Intent[eid] = "talk";
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
    const playerMaps = new Map<string, string>();
    for (const [sessionId, eid] of this.playerEidBySessionId) {
      playerMaps.set(sessionId, entityMapOf(this.world, eid));
    }

    // 无同步配置 → 空快照（客户端看不到实体）
    if (this.netSyncFields.length === 0) {
      return { tick, entities, timeOfDay: { ...this.world.time.timeOfDay }, playerMaps };
    }
    for (const field of this.netSyncFields) {
      const comp = this.componentRegistry.get(field.component) as
        | Record<string, unknown>
        | unknown[]
        | undefined;
      if (!comp) continue;

      const ensure = (id: number, eid: number): EntitySnapshot => {
        let snap = entities.get(id);
        if (!snap) {
          snap = {
            values: {},
            strings: {},
            mapId: entityMapOf(this.world, eid),
            level: entityLevelOf(eid),
          };
          entities.set(id, snap);
        }
        return snap;
      };

      if (Array.isArray(comp)) {
        // AoS 组件：通过 tags 限定查询范围，再交适配器展平为 numbers/strings
        const adapter = getAosSyncAdapter(field.component);
        if (!adapter) continue;
        for (const eid of this.queryByTags(field.tags)) {
          // 断线保留期实体不进快照 → 对所有在线玩家不可见（interest 只读
          // 快照，兴趣排除由本门控传递达成）
          if (isOfflineRetained(this.world, eid)) continue;
          const snap = ensure(NetworkId.value[eid], eid);
          const result = adapter(this.world, eid, field.fields);
          Object.assign(snap.values, result.numbers);
          Object.assign(snap.strings, result.strings);
        }
        continue;
      }

      // SoA 组件：按该组件查询实体（含 NetworkId），读标量数值
      for (const eid of query(this.world, [NetworkId, comp as object])) {
        // 断线保留期实体不进快照（同上：对一切客户端不可见的唯一门控）
        if (isOfflineRetained(this.world, eid)) continue;
        const id = NetworkId.value[eid];
        const snap = ensure(id, eid);
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
      playerMaps,
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
 * 创建仿真实例的工厂函数（装配处）。
 *
 * 遵循框架中 createGameInstance / createGameWorld 的命名惯例。
 * 返回 SimulationPort 接口类型而非具体类，外部代码只依赖接口。
 *
 * **读档预载**（原 GameRoom.onCreate 逻辑移入）：repository + saveId 就绪时
 * 在构造前读档一次，经 BootDeps 单一通道以同步闭包注入——bootMaps（地图
 * 快照回填）与 restoreWorld（实体恢复）共用同一份预载快照，读档通道唯一。
 *
 * @param gameDef 已加载和校验的游戏配置
 * @param options 可选注入（持久化仓储/存档标识）
 * @returns 仿真端口实例
 */
export async function createGameSimulation(
  gameDef: LoadedGameDefinition,
  options?: SimulationOptions,
): Promise<SimulationPort> {
  const { repository, saveId } = options ?? {};
  const initialRecord = repository && saveId ? await repository.loadWorld(saveId) : null;

  const bootDeps: BootDeps = {
    loadRecord: () => initialRecord,
    saveRecord: repository && saveId
      ? (record) => {
          // 首存快照的 id 以装配处 saveId 为准（fileRepository 按 record.id 落盘）
          void repository.saveWorld({ ...record, id: saveId }).catch((err) => {
            assemblyLogger.error("boot save failed", {
              saveId,
              error: err instanceof Error ? err.stack : String(err),
            });
          });
        }
      : noopBootDeps.saveRecord,
  };

  return new GameSimulation(gameDef, options, bootDeps);
}