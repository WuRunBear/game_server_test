/**
 * 报价会话 id 归一：接受数字或**数字字符串**。
 *
 * 客户端从 `RoomState.offers` 的 map 键取 offerId（键是字符串形态）并原样
 * 回传（offer-accept / offer-cancel）——协议层两种形态都合法。非法值返回
 * -1（会话不存在 → 命令被拒）。
 */
function offerIdOf(value: unknown): number {
  if (typeof value === "number" && Number.isInteger(value)) return value;
  if (typeof value === "string" && /^\d+$/.test(value.trim())) return Number(value.trim());
  return -1;
}

/**
 * 仿真层实现——SimulationPort 接口的具体实现（类级 JSDoc 见下方 GameSimulation，
 * 完整说明架构位置、玩家管理/输入处理/快照构建/持久化等职责，此处不重复）。
 */
import { query, hasComponent, addComponent, removeComponent } from "bitecs";
import {
  NetworkId,
  Velocity,
  Inventory,
  Intent,
  Health,
  entityMapOf,
  SpawnPoint,
  Player,
  Transform,
  Cooldown,
  Equipment,
  Placeable,
  CraftingStation,
  LightSource,
  Dialogue,
} from "components";
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
import { consumeSlot, dropSlot, transferSlot, lootContainerSlot, addToInventory } from "framework/systems/gameplay/inventoryOps";
import { equipSlot, getEquippedItemKind } from "framework/systems/gameplay/equipmentSystem";
import {
  craftRecipe,
  stepCraftingJobs,
  cancelCrafting,
  craftingProgressOf,
  validateCraftingRules,
  craftingStationRange,
  stationsInRange,
} from "framework/systems/gameplay/craftingSystem";
import { stepFuelBurn, refuelStation, validateFuelRules, fastForwardFuelBurn } from "framework/systems/gameplay/fuelSystem";
import { placeEntity } from "framework/systems/gameplay/placeableSystem";
import { deconstructEntity } from "framework/systems/gameplay/deconstructSystem";
import { throwWeapon } from "framework/systems/gameplay/projectileSystem";
import {
  startThrowAction,
  cancelAction,
} from "framework/simulation/actions/actionSystem";
import {
  ActionInput,
  ActionState,
  getIntentActionId,
} from "framework/simulation/actions/actionState";
import { isGameplayReachable } from "framework/utils/gameplayDistance";
import { advanceDialogue } from "framework/systems/gameplay/dialogueSystem";
import { getAosSyncAdapter } from "framework/simulation/aosSyncAdapters";
import { serializeWorld, restoreWorld } from "framework/persistence/worldSerializer";
import { timeOfDayOf } from "framework/simulation/worldClock/dayNight";
import { environmentAt } from "framework/simulation/worldClock";
import { evolve } from "map/evolution/engine";
import { createMapEvolveDeps } from "map/runtime/evolveDeps";
import { mapSeedOf } from "map/runtime/mapSeeds";
import { serializeGeometry, type SerializedMapGeometry } from "map/geometry/snapshot";
import { advanceTickTo, computeOfflineTicks } from "map/runtime/clock";
import { setGround } from "map/runtime/terrainWriteback";
import { noopBootDeps, type BootDeps } from "map/runtime/boot";
import { fastForwardStateMachines } from "framework/simulation/stateMachine/stateMachineSystem";
import { fastForwardPopulations } from "framework/simulation/population/populationSystem";
import type { Repository, WorldRecord } from "framework/repository";
import type { ServerRule, CraftingRecipe } from "framework/config/schema/RuleSchema";
import { computeInterest } from "./interest";
import { createInputGuard, type InputGuard } from "./inputValidation";
import { CRAFTING_SYNC_COMPONENT } from "./netSyncDerived";
import { ACTION_SYNC_COMPONENT } from "framework/simulation/actions/actionState";
import { openOffer, acceptOffer, cancelOffer, isValidSettleTerms } from "framework/economy/offer";
import { queueEvent, tapEvents } from "framework/simulation/events/eventBus";
import { tapGameEvents } from "framework/events/gameEvents";
import {
  collectEventsForClient,
  drainClientEventOutbox,
  emitClientEvent,
  networkIdOf,
  DEFAULT_CLIENT_EVENT_VIEW_RADIUS,
  type PendingClientEvent,
  type ClientEvent,
} from "framework/simulation/clientEvents";
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

/**
 * 移动分量归一化：缺省（undefined/null）按 0；非 number / 非有限数返回
 * undefined（调用方拒绝整条输入）；有限数钳到安全轴上限。
 *
 * 注意协议单位：moveX/moveY 是**像素/秒**（见 docs/CLIENT-INTEGRATION.md），
 * 因此这里不能钳到 [-1,1]（那会让角色只能以 1px/s 移动）。安全上限取一个
 * 远高于任何合法配置的值，只用于挡住 `Number.MAX_VALUE` 级别的异常输入；
 * 真正的速度上限仍由 server 规则 maxMoveSpeed 拒绝式校验负责。
 */
const MAX_INPUT_AXIS = 10_000;

function normalizeMoveAxis(value: unknown): number | undefined {
  if (value === undefined || value === null) return 0;
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  return Math.max(-MAX_INPUT_AXIS, Math.min(MAX_INPUT_AXIS, value));
}

/**
 * 可选目标 networkId 归一：只接受正整数（协议层稳定 id）；非法/缺省返回
 * undefined（由 interactionSystem 回退最近目标，不拒绝整条输入）。
 */
function normalizeTargetNetworkId(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) return undefined;
  return value;
}

/** 可选瞄准坐标归一：必须有限数；缺省/非法返回 undefined。 */
function normalizeAimCoordinate(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  return value;
}

import type { SimulationPort } from "./SimulationPort";
import type {
  PlayerInput, PlayerJoinResult, PlayerJoinOptions, TickSnapshot, TickResult, DebugSnapshotOptions, PlayerCommand, EntitySnapshot,
  SimulationOptions, OfferSummary, CommandResult, CommandResultCode,
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

  /** 地图 key → 生成配置（演化钩子按图取 seed）。 */
  private mapConfigsByKey = new Map<string, MapConfig>();

  /** 待冲刷的 on-command 事件缓存（submitCommand 间期产生，下一 tick beforeSystems 入队）。 */
  private pendingCommandEvents: { eid: number; type: string }[] = [];

  /**
   * CC-04 变化检测状态（首帧只记录基线，不发事件）：
   * - 天气 id：environmentSystem 每 tick 重算；
   * - 每玩家地图：snapshot.playerMaps；
   * - 每图地形 version：terrainWriteback 后重算。
   */
  private lastWeatherId?: string;
  private lastMapIdBySessionId = new Map<string, string>();
  private lastTerrainVersionByMapId = new Map<string, string>();

  /**
   * 本 tick 已由 `killed` 发过 death 事件的受害者 networkId。
   *
   * deathSystem 的 on-death 事件随后还会到；用它去重，保证一次死亡只发一条
   * death（攻击致死带 killer，需求耗尽等只带 victim/kind）。
   */
  private deathAnnouncedVictims = new Set<number>();

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
    let restoredPlayerEids: number[] = [];
    if (initialRecord) {
      // 实体/全局时刻/激活集恢复（地图快照回填归 bootMaps，已在
      // createGameInstance → bootMaps 完成）
      restoredPlayerEids = restoreWorld(this.world, initialRecord);
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

    // CC-04：旁路观察帧内事件（不取走事件，不影响既有消费方）。
    tapEvents(this.world, (name, payload) => this.observeTypedEvent(name, payload));
    tapGameEvents(this.world, (event) => this.observeGameEvent(event));

    // 切片 C/E：合成规则（解锁条件/时长）与燃料段配置构造期 fail-fast 校验——
    // 未知条件名/非法参数/非法燃料配置在此即抛，不带病进 tick 循环。
    validateCraftingRules(this.world);
    validateFuelRules(this.world);

    // 离线补差：restore 完成后按墙钟一次性折算离线跨度，逐激活图一次
    // evolve 推到演化边界（与开机初始演化/每 tick 增量共用同一 evolve，D6）。
    if (initialRecord) {
      this.runOfflineCatchUp(initialRecord);
    }

    // 读档玩家实体统一按"离线保留"处理：带 Offline 的保留档内 untilTick（随档
    // 恢复）；无 Offline 的（旧档/崩溃瞬间在线）补标为保留实体，避免幽灵玩家。
    // 放在离线补差之后：untilTick 基于补差后的当前 tick，旧档玩家仍有一次
    // 完整的重连窗口（否则停机时长会立即耗尽保留期）。
    this.retainRestoredPlayers(restoredPlayerEids);

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
   * 读档恢复出的玩家实体 → 统一离线保留语义。
   *
   * - 已带 Offline（新档）：保留存档时写入的 untilTick（断线时刻推导，跨重启
   *   有效期语义不变），不刷新；
   * - 无 Offline（旧档或崩溃瞬间在线）：补标 Offline，untilTick = 当前 tick +
   *   offlineRetentionTicks——重启后它们对系统不可见，客户端按 networkId
   *   重连可复用，否则到期清扫；
   * - offlineRetentionTicks = 0：保留语义关闭，直接销毁这些无主实体（与
   *   removePlayer 的 0 配置行为一致，避免幽灵玩家）。
   */
  private retainRestoredPlayers(eids: number[]): void {
    if (eids.length === 0) return;

    for (const eid of eids) {
      if (this.offlineRetentionTicks <= 0) {
        destroyEntity(this.world, eid);
        continue;
      }
      if (isOfflineRetained(this.world, eid)) continue;
      addComponent(this.world, eid, Offline);
      Offline.untilTick[eid] = this.world.time.tick + this.offlineRetentionTicks;
      this.world.logger.info("读档玩家实体补标记为离线保留", {
        eid,
        networkId: NetworkId.value[eid],
        untilTick: Offline.untilTick[eid],
      });
    }
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
   * 2. advanceTickTo 先把 world.time.tick 推到补差边界——timeOfDay（及
   *    environment 等 tick 派生状态）随之自动正确，无需额外时钟快进代码；
   * 3. 对全部激活图一次性 evolve(存档tick → 存档tick+离线ticks)——与开机
   *    初始演化、每 tick 增量共用同一 evolve（D6，唯一动作不变式）；
   *    条件（如 isNight）在补差终点相位求值一次；
   * 4. 状态机/族群/燃料按同一跨度闭式快进（纯计算，非逐 tick）；
   * 5. 延时制作到点结算：世界时钟已到边界，stepCraftingJobs 与在线同款
   *    （到期任务产出；满包/站点失效则挂起保留）。
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
    const toTick = fromTick + offlineTicks;
    // 时钟先落到边界：hour/phase 是 tick 纯函数，派生状态（timeOfDay）自动一致，
    // 也保证离线条件求值看到的是补差终点的相位而非存档旧相位。
    advanceTickTo(this.world, toTick);
    this.evolveMaps(fromTick, toTick);
    // 状态机离线快进：迁移步进（非逐 tick）把全部实体状态机推到演化边界，
    // 落地「读档后状态正确恢复 + 离线等价」——与逐 tick 推进最终状态一致。
    fastForwardStateMachines(this.world, toTick);
    // 族群节点离线快进：槽步进（非逐 tick）把全部节点数量推到演化边界——
    // 与逐 tick 推进最终数量/上限/最后演进 tick 完全一致（核心断言）。
    fastForwardPopulations(this.world, toTick);
    // 燃料离线闭式快进：离线期间燃料真实消耗（耗尽的光源/站点按既有规则失效）
    fastForwardFuelBurn(this.world, offlineTicks);
    // 延时制作到点结算：任务 finishTick 为绝对 tick，推进后与在线 tick 同款结算
    stepCraftingJobs(this.world);
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
    // death 去重窗口按 tick 重置（killed 与 on-death 在同一 tick 内配对）。
    this.deathAnnouncedVictims.clear();

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

    // CC-04：世界级变化检测（天气/换图/地形写回）在系统跑完后入 outbox；
    // 首帧只记基线，不发事件（初始状态由 RoomState 承担）。
    this.detectWorldChanges(snapshot);

    // 统一排空本 tick 事件并按客户端受众过滤（seq 已产生，过滤不重排）。
    const clientEvents = this.collectClientEvents(drainClientEventOutbox(this.world));

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
      clientEvents,
      // 兼容别名：CC-04 文档的 TickResult.events 名称（同一 Map 引用）。
      events: clientEvents,
    };
  }

  /**
   * 把本 tick 排空的事件按每个在线客户端过滤成 `ClientEvent[]`。
   *
   * 视角数据取 tick 结束时玩家的真实位置/地图（锚点在事件产生时已固化）。
   * 返回 Map 只包含有事件的会话；无事件不发空包。
   */
  private collectClientEvents(events: PendingClientEvent[]): Map<string, ClientEvent[]> {
    const result = new Map<string, ClientEvent[]>();
    if (events.length === 0) return result;

    // 与兴趣裁剪同一规则源；未配置 viewRadius 时事件过滤用 320px 缺省。
    const radius = this.viewRadius ?? DEFAULT_CLIENT_EVENT_VIEW_RADIUS;
    for (const [sessionId, eid] of this.playerEidBySessionId) {
      if (!hasComponent(this.world, eid, Transform)) continue;
      const visible = collectEventsForClient(
        events,
        {
          eid,
          mapId: entityMapOf(this.world, eid),
          x: Transform.x[eid],
          y: Transform.y[eid],
        },
        radius,
      );
      if (visible.length > 0) result.set(sessionId, visible);
    }
    return result;
  }

  /**
   * 世界级变化检测（每 tick，系统跑完后）：
   * - `weather-change`：weatherId 变化 → world；
   * - `map-change`：玩家所属图变化 → self（from/to/mapVersion）；
   * - `terrain-writeback`：地图 geometry.version 变化 → map（无逐格 delta）。
   *
   * 全部采用「首帧记基线、之后比较」语义，避免开机即为所有图/玩家补发事件。
   */
  private detectWorldChanges(snapshot: TickSnapshot): void {
    const tick = this.world.time.tick;
    const environment = this.world.time.environment;

    // 天气
    if (this.lastWeatherId !== undefined && environment.weatherId !== this.lastWeatherId) {
      emitClientEvent(
        this.world,
        "weather-change",
        {
          weatherId: environment.weatherId,
          phaseId: environment.phaseId,
          tick,
        },
        "world",
      );
    }
    this.lastWeatherId = environment.weatherId;

    // 换图（per-player）
    for (const [sessionId, mapId] of snapshot.playerMaps) {
      const previous = this.lastMapIdBySessionId.get(sessionId);
      this.lastMapIdBySessionId.set(sessionId, mapId);
      if (previous === undefined || previous === mapId) continue;
      const eid = this.playerEidBySessionId.get(sessionId);
      if (typeof eid !== "number") continue;
      const version = this.world.maps[mapId]?.version;
      emitClientEvent(
        this.world,
        "map-change",
        {
          from: previous,
          to: mapId,
          ...(typeof version === "string" && version.length > 0 ? { mapVersion: version } : {}),
        },
        "self",
        { targetEid: eid },
      );
    }
    // 会话已断开：清掉基线，防 sessionId 复用造成假换图
    for (const sessionId of [...this.lastMapIdBySessionId.keys()]) {
      if (!this.playerEidBySessionId.has(sessionId)) this.lastMapIdBySessionId.delete(sessionId);
    }

    // 地形写回（按图 version 变化；无逐格 delta 时只通知版本）
    for (const [mapId, geometry] of Object.entries(this.world.maps)) {
      const previous = this.lastTerrainVersionByMapId.get(mapId);
      this.lastTerrainVersionByMapId.set(mapId, geometry.version);
      if (previous === undefined || previous === geometry.version) continue;
      emitClientEvent(
        this.world,
        "terrain-writeback",
        { mapId, version: geometry.version },
        "map",
        { mapId },
      );
    }
  }

  /**
   * 类型化事件总线 tap：把内部事件翻译成客户端表现事件。
   *
   * 只做 eid → networkId 转换，不复制任何玩法判定；载荷里**绝不**出现 eid。
   */
  private observeTypedEvent(name: string, payload: unknown): void {
    if (!payload || typeof payload !== "object") return;
    const data = payload as Record<string, unknown>;

    switch (name) {
      case "on-hit": {
        const attackerEid = data.attacker;
        const targetEid = data.target;
        if (typeof attackerEid !== "number" || typeof targetEid !== "number") return;
        const attacker = networkIdOf(this.world, attackerEid);
        const target = networkIdOf(this.world, targetEid);
        if (attacker === undefined || target === undefined) return;
        emitClientEvent(
          this.world,
          "hit",
          {
            attacker,
            target,
            damage: data.damage,
            ...(data.crit === true ? { crit: true } : {}),
            ...(typeof data.damageType === "string" ? { damageType: data.damageType } : {}),
          },
          "nearby",
          { anchorEid: attackerEid },
        );
        return;
      }
      case "on-death": {
        const victimEid = data.eid;
        if (typeof victimEid !== "number") return;
        this.announceDeath(victimEid, undefined, data.kind, victimEid);
        return;
      }
      case "on-item-break": {
        const ownerEid = data.eid;
        if (typeof ownerEid !== "number") return;
        const player = networkIdOf(this.world, ownerEid);
        if (player === undefined) return;
        emitClientEvent(
          this.world,
          "item-break",
          {
            player,
            ...(typeof data.kind === "string" ? { kind: data.kind } : {}),
            ...(typeof data.slot === "string" ? { slot: data.slot } : {}),
          },
          "self",
          { targetEid: ownerEid },
        );
        return;
      }
      case "on-achievement": {
        const playerEid = data.eid;
        if (typeof playerEid !== "number" || playerEid <= 0) return;
        const player = networkIdOf(this.world, playerEid);
        if (player === undefined) return;
        emitClientEvent(
          this.world,
          "achievement",
          {
            player,
            achievementId: data.id,
            ...(typeof data.name === "string" ? { name: data.name } : {}),
          },
          "self",
          { targetEid: playerEid },
        );
        return;
      }
      case "on-raid-warning": {
        const centerEid = data.eid;
        if (typeof centerEid !== "number" || data.remainingTicks === undefined) return;
        const mapId = entityMapOf(this.world, centerEid);
        emitClientEvent(
          this.world,
          "raid-warning",
          { remainingTicks: data.remainingTicks },
          "map",
          { mapId },
        );
        return;
      }
      default:
        return;
    }
  }

  /**
   * 帧内轻量事件 tap：攻击致命一击的 `killed`（带 killer）优先于 deathSystem
   * 的 `on-death`（只有 victim/kind），按受害者 networkId 去重。
   */
  private observeGameEvent(event: { type: string; data: Record<string, unknown> }): void {
    if (event.type !== "killed") return;
    const victimEid = event.data.victim;
    const killerEid = event.data.killer;
    if (typeof victimEid !== "number") return;
    // 锚点取受害者位置：death 是「这里有人倒下」的空间事件，附近玩家都应看到；
    // killer 可能隔着射程，但不会远于战斗距离。
    this.announceDeath(
      victimEid,
      typeof killerEid === "number" ? killerEid : undefined,
      event.data.kind,
      victimEid,
    );
  }

  /**
   * 发 `death` 客户端事件（nearby，锚点优先取受害者位置）。
   *
   * 同一受害者同 tick 只发一次；攻击致死带 killer networkId，其它致死源
   * 只带 victim/kind。
   */
  private announceDeath(
    victimEid: number,
    killerEid: number | undefined,
    kind: unknown,
    anchorEid: number,
  ): void {
    const victim = networkIdOf(this.world, victimEid);
    if (victim === undefined) return;
    if (this.deathAnnouncedVictims.has(victim)) return;
    this.deathAnnouncedVictims.add(victim);

    const killer = killerEid !== undefined ? networkIdOf(this.world, killerEid) : undefined;
    emitClientEvent(
      this.world,
      "death",
      {
        victim,
        ...(killer !== undefined ? { killer } : {}),
        ...(typeof kind === "string" && kind.length > 0 ? { kind } : {}),
      },
      "nearby",
      { anchorEid },
    );
  }

  /**
   * 玩家加入——创建玩家实体并返回网络标识。
   *
   * 实体来源：
   * 1. **断线保留实体**：options.networkId 命中保留中且未到期的离线实体 →
   *    复用（清除 Offline 保留标记、恢复会话映射，背包/位置/进度原样保留）
   * 2. **新生成**：按玩家出生规则（game/rules/player.json → resolvedPlayerRule.spawn）
   *    在默认图选出生点（random 每玩家独立随机 / seededRandom 同图同点 /
   *    exact 固定），写入持久化 SpawnPoint 组件，并按 "player" archetype 生成
   *
   * 身份复用**只按客户端给出的 networkId 严格匹配**：未提供或未命中时新建
   * 实体，绝不按 FIFO 把他人（或已过期）的旧实体绑给新客户端；读档/保留的
   * 未认领实体由保留期到期清扫负责清理。
   *
   * @param sessionId Colyseus 连接标识
   * @param options 可选加入参数（重连复用保留实体的匹配键）
   * @returns { networkId } 玩家实体的网络标识
   */
  addPlayer(sessionId: string, options?: PlayerJoinOptions): PlayerJoinResult {
    let eid: number | undefined;

    // 断线保留实体：按客户端自报 networkId 匹配（Player + Offline 限定，
    // 且只复用未到期的保留实体——到期实体的复用等同篡改保留语义）。
    if (typeof options?.networkId === "number") {
      const now = this.world.time.tick;
      const retained = [...query(this.world, [NetworkId, Player, Offline])].find(
        (candidate) =>
          NetworkId.value[candidate] === options.networkId &&
          Offline.untilTick[candidate] > now,
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
        // 提示键未命中（实体已到期销毁/不存在）：走常规路径新建，不挪用旧实体
        this.world.logger.warn("重连提示 networkId 未命中可用保留实体，走常规加入", {
          sessionId,
          networkId: options.networkId,
        });
      }
    }

    // 未命中 → 新生成（无 FIFO / orphan 兜底）
    if (eid === undefined) {
      eid = this.spawnNewPlayer();
    }

    // 建立 sessionId → eid 映射，后续输入可以通过 sessionId 找到玩家实体
    // 动作状态是瞬态：重连复用/新生成都从干净状态开始（eid 复用防串台）。
    // 若有残留动作（重连复用保留实体），先向附近发 action-cancel 再清空。
    cancelAction(this.world, eid, "session-reset");
    ActionInput[eid] = undefined;
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
   * - 保留时长 > 0：标记 Offline（入档组件）+ 记录到期 tick，
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
      // 断线即取消进行中的动作（保留实体也不应继续挥砍/采集）
      cancelAction(this.world, eid, "disconnect");
      ActionInput[eid] = undefined;
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
    // 入口严格数值校验（F-43）：seq 必须为有限非负整数；moveX/moveY 缺省按 0，
    // 出现时必须为有限数；NaN/Infinity/非整数 seq 一律拒绝（含未配置
    // maxMoveSpeed 时），绝不让非法值进入 ECS Velocity。
    const seq = input?.seq;
    if (typeof seq !== "number" || !Number.isInteger(seq) || seq < 0) {
      this.world.logger.warn("输入被拒：seq 非有限非负整数", { sessionId, seq: String(seq) });
      return;
    }
    const moveX = normalizeMoveAxis(input.moveX);
    const moveY = normalizeMoveAxis(input.moveY);
    if (moveX === undefined || moveY === undefined) {
      this.world.logger.warn("输入被拒：移动分量非有限数", {
        sessionId,
        moveX: String(input.moveX),
        moveY: String(input.moveY),
      });
      return;
    }
    const normalized: PlayerInput = {
      seq,
      moveX,
      moveY,
      interact: input.interact === true,
      attack: input.attack === true,
      talk: input.talk === true,
    };
    // 可选目标/瞄准：target 是 networkId（不是 eid）；解析失败由 interaction
    // 回退最近目标，绝不因可选字段非法而丢弃整条移动输入。
    const target = normalizeTargetNetworkId(input.target);
    const aimX = normalizeAimCoordinate(input.aimX);
    const aimY = normalizeAimCoordinate(input.aimY);
    if (target !== undefined) normalized.target = target;
    if (aimX !== undefined && aimY !== undefined) {
      normalized.aimX = aimX;
      normalized.aimY = aimY;
    }

    const lastSeq = this.lastSeqBySessionId.get(sessionId) ?? 0;
    if (seq <= lastSeq) return;

    // 输入校验（anti-cheat）：超速输入被拒且不推进 seq，客户端无法靠重发绕过
    if (!this.inputGuard.validateMove(normalized)) {
      this.world.logger.warn("输入被拒：超出移动速度上限", {
        sessionId,
        speed: Math.hypot(normalized.moveX, normalized.moveY),
      });
      return;
    }

    this.lastSeqBySessionId.set(sessionId, seq);
    this.latestInputBySessionId.set(sessionId, normalized);
  }

  /**
   * 提交玩家命令（离散动作）：食用 / 丢弃 / 槽位移动 / 制作 / 放置 ...
   * 立即执行服务端权威变更；返回统一 `CommandResult`（成功也回执）。
   *
   * 失败错误码在 `finishCommand` 里按命令类型做**只读**归因（不复制判定、
   * 不改变原子行为）；归因不到的保持 `unknown`，绝不编造具体原因。
   *
   * @param sessionId Colyseus 连接标识
   * @param command 命令数据
   */
  submitCommand(sessionId: string, command: PlayerCommand): CommandResult {
    const eid = this.playerEidBySessionId.get(sessionId);
    if (typeof eid !== "number") return { ok: false, code: "invalid" };

    // 死亡/重生窗口内（原地重置语义，实体未移除）不执行背包命令——
    // 与 applyInputs / interactionSystem 的死亡守卫语义一致，防幽灵操作
    if ((Health.current[eid] ?? 0) <= 0) return { ok: false, code: "dead" };

    // 输入校验（anti-cheat）：命令频率超限被拒并日志
    if (!this.inputGuard.submitCommandAllowed(sessionId, this.world.time.tick)) {
      this.world.logger.warn("命令被拒：超出频率上限", {
        sessionId,
        type: command.type,
        tick: this.world.time.tick,
      });
      return { ok: false, code: "rate_limited" };
    }

    switch (command.type) {
      case "consume":
        return this.finishCommand(eid, command, consumeSlot(this.world, eid, command.slot ?? -1));
      case "drop":
        return this.finishCommand(eid, command, dropSlot(this.world, eid, command.slot ?? -1));
      case "transfer":
        if (command.target !== undefined) {
          // transfer + target：从目标容器实体的槽位取回物品到本人背包
          // （死亡容器等承载物；同图校验与满包不吞语义见 lootContainerSlot）
          return this.finishCommand(
            eid,
            command,
            lootContainerSlot(this.world, eid, command.target, command.slot ?? -1),
          );
        }
        return this.finishCommand(
          eid,
          command,
          transferSlot(
            Inventory[eid]!,
            command.slot ?? -1,
            command.toSlot ?? -1,
            (kind) => this.world.gameDef.itemsByKind?.get(kind)?.maxStack ?? 1,
          ),
        );
      case "equip":
        return this.finishCommand(eid, command, equipSlot(this.world, eid, command.slot ?? -1));
      case "craft":
        return this.finishCommand(eid, command, craftRecipe(this.world, eid, command.recipe ?? ""));
      case "craft-cancel":
        // 取消进行中的延时制作（退料原子：放不下则拒绝取消）
        return this.finishCommand(eid, command, cancelCrafting(this.world, eid, command.recipe ?? ""));
      case "refuel":
        // 加燃料：附近燃料型站点 + 背包燃料物品（fuel.items 配置声明序）
        return this.finishCommand(eid, command, refuelStation(this.world, eid, command.target));
      case "place":
        return this.finishCommand(
          eid,
          command,
          placeEntity(this.world, eid, command.slot ?? -1, command.x ?? 0, command.y ?? 0),
        );
      case "deconstruct":
        return this.finishCommand(eid, command, deconstructEntity(this.world, eid, command.target ?? -1));
      case "throw": {
        // 投掷：配置了动作时间轴时只**启动动作**，投射物在 release 事件阶段由
        // throwWeapon 生成；未配置时保持旧瞬时投掷（向后兼容）。
        // 方向优先取瞄准点 x/y，缺省按最近敌人/移动朝向回退。
        const throwActionId = getIntentActionId(this.world, "throw");
        if (throwActionId) {
          return this.finishCommand(
            eid,
            command,
            startThrowAction(this.world, eid, throwActionId, command.x, command.y),
          );
        }
        return this.finishCommand(
          eid,
          command,
          throwWeapon(this.world, eid, command.x, command.y),
        );
      }
      case "dialogue":
        return this.finishCommand(eid, command, advanceDialogue(this.world, eid, command.option ?? -1));
      case "offer": {
        // 交易条款严格校验（F-01）：恰好两方、结构合法、发起者在条款中、
        // 另一方必须是**当前在线的 Player 实体**（有会话绑定且非断线保留）。
        // 非 Player/离线/不存在/重复 party 一律拒绝——杜绝"非玩家方自动确认"
        // 把尸体/箱子当交易对手搬空。
        //
        // 协议层 party 为**参与方 networkId**（客户端可见的稳定 id；服务端
        // 内部 eid 客户端不可见）→ 此处反查为 eid，解析失败即拒绝整条命令
        // （伪造/过期的 networkId 不会命中任何实体）。
        const terms = command.offer;
        if (!isValidSettleTerms(terms)) return { ok: false, code: "invalid" };
        if (terms.length !== 2) return { ok: false, code: "invalid" };
        const partyNetworkIds = terms.map((party) => party.party);
        if (new Set(partyNetworkIds).size !== 2) return { ok: false, code: "invalid" };
        const partyEids: number[] = [];
        for (const networkId of partyNetworkIds) {
          const partyEid = this.eidByNetworkId(networkId);
          if (partyEid === undefined) return { ok: false, code: "invalid" };
          partyEids.push(partyEid);
        }
        if (!partyEids.includes(eid)) return { ok: false, code: "not_owner" };
        const counterparty = partyEids.find((partyEid) => partyEid !== eid)!;
        if (!this.isOnlinePlayerEid(counterparty)) return { ok: false, code: "out_of_range" };
        const expiresTick =
          command.ttlTicks !== undefined &&
          Number.isInteger(command.ttlTicks) &&
          command.ttlTicks > 0
            ? this.world.time.tick + command.ttlTicks
            : undefined;
        // 发起方本人视为已确认；另一方必须 offer-accept 显式确认（双方均为
        // 在线 Player，openOffer 不会把任何一方当作自动确认方）。
        const offerId = openOffer(
          this.world,
          terms.map((party, index) => ({
            ...party,
            party: partyEids[index]!,
          })),
          {
            confirmedParties: [eid],
            expiresTick,
            initiator: eid,
          },
        );
        return this.finishCommand(eid, command, offerId !== null);
      }
      case "offer-accept":
        return this.finishCommand(eid, command, acceptOffer(this.world, eid, offerIdOf(command.offerId)));
      case "offer-cancel":
        return this.finishCommand(eid, command, cancelOffer(this.world, eid, offerIdOf(command.offerId)));
      default:
        return { ok: false, code: "invalid" };
    }
  }

  /**
   * 实体是否为**当前在线**的玩家：带 Player 标签、有 session 绑定、且不处于
   * 断线保留期。用于 offer 交易对手身份校验（非 Player/离线一律不可交易）。
   */
  private isOnlinePlayerEid(eid: number): boolean {
    if (!hasComponent(this.world, eid, Player)) return false;
    if (isOfflineRetained(this.world, eid)) return false;
    for (const onlineEid of this.playerEidBySessionId.values()) {
      if (onlineEid === eid) return true;
    }
    return false;
  }

  /**
   * networkId → eid 反查（协议层只见 networkId，服务端内部只见 eid）。
   *
   * 只认**当前存在**的实体（NetworkId 组件在身）；断线保留实体的 networkId
   * 仍可解析（保留期内实体仍在世界里），但后续的在线校验会拒绝它。
   * 解析不到（伪造/从未存在/已销毁）返回 undefined → 命令被拒。
   */
  private eidByNetworkId(networkId: number): number | undefined {
    if (!Number.isInteger(networkId) || networkId <= 0) return undefined;
    for (const eid of query(this.world, [NetworkId])) {
      if (NetworkId.value[eid] === networkId) return eid;
    }
    return undefined;
  }

  /**
   * 构建进行中报价会话的摘要列表（协议层可见形态）。
   *
   * 只取 pending 会话（已结算/已作废/已过期的会话不再出现在摘要里）。
   * 视角以**发起方**为基准：give = 发起方给出的物品、take = 发起方收取的物品。
   * 参与方一律以 networkId 表达（客户端可见的稳定标识）。
   */
  private buildOfferSummaries(): OfferSummary[] {
    const summaries: OfferSummary[] = [];
    for (const session of this.world.offerSessions.values()) {
      if (session.status !== "pending") continue;
      const initiatorTerms = session.terms.find((party) => party.party === session.initiator);
      const counterpartyTerms = session.terms.find((party) => party.party !== session.initiator);
      if (!initiatorTerms || !counterpartyTerms) continue;
      summaries.push({
        offerId: session.id,
        from: NetworkId.value[session.initiator] ?? 0,
        to: NetworkId.value[counterpartyTerms.party] ?? 0,
        give: (initiatorTerms.give ?? []).map((amount) => [amount.kind, amount.count]),
        take: (initiatorTerms.take ?? []).map((amount) => [amount.kind, amount.count]),
      });
    }
    return summaries;
  }

  /**
   * 命令收尾：成功时缓存一条 on-command 事件（下一 tick beforeSystems 冲刷
   * 进事件总线，供 on-command 触发器消费），失败时做只读错误码归因。
   */
  private finishCommand(eid: number, command: PlayerCommand, success: boolean): CommandResult {
    if (success) {
      this.pendingCommandEvents.push({ eid, type: command.type });
      return { ok: true };
    }
    return { ok: false, code: this.commandFailureCode(eid, command) };
  }

  /**
   * 失败原因归因（只读，不重跑/不改变原子判定）。
   *
   * 原则：能按与原子相同的**前置条件**确定的才给具体码；拿不到确定原因时
   * 一律 `unknown`，不编造。归因顺序尽量与原子内部校验顺序一致。
   */
  private commandFailureCode(eid: number, command: PlayerCommand): CommandResultCode {
    const inv = Inventory[eid];
    const slotIndex = command.slot ?? -1;

    switch (command.type) {
      case "consume": {
        const stack = inv?.slots[slotIndex];
        if (!stack) return "no_item";
        const item = this.world.gameDef.itemsByKind?.get(stack.kind);
        if (!item?.consume || item.consume.length === 0) return "invalid";
        return "unknown";
      }
      case "drop": {
        const stack = inv?.slots[slotIndex];
        if (!stack) return "no_item";
        if (!hasComponent(this.world, eid, Transform)) return "invalid";
        return "unknown";
      }
      case "transfer": {
        if (!inv) return "invalid";
        if (command.target !== undefined) {
          const containerEid = this.eidByNetworkId(command.target);
          if (containerEid === undefined || containerEid === eid) return "invalid";
          const containerInv = Inventory[containerEid];
          if (!containerInv) return "invalid";

          // 可达性（与 lootContainerSlot 同序：同图 → 同层距离 → 槽位 → 满包）
          if (!hasComponent(this.world, eid, Transform) || !hasComponent(this.world, containerEid, Transform)) {
            return "invalid";
          }
          if (isOfflineRetained(this.world, containerEid)) return "out_of_range";
          if (entityMapOf(this.world, containerEid) !== entityMapOf(this.world, eid)) {
            return "out_of_range";
          }
          const placeRules = this.world.gameDef.resolvedRules["place"] as
            | { containerRange?: number }
            | undefined;
          const range = placeRules?.containerRange ?? 64;
          if (
            !isGameplayReachable(
              { x: Transform.x[eid], y: Transform.y[eid], level: entityLevelOf(eid) },
              {
                x: Transform.x[containerEid],
                y: Transform.y[containerEid],
                level: entityLevelOf(containerEid),
              },
              range,
            )
          ) {
            return "out_of_range";
          }
          const stack = containerInv.slots[slotIndex];
          if (!stack) return "no_item";
          // 满包判定：干跑 addToInventory（与原子同一入包函数，只读克隆）
          const dry = {
            capacity: inv.capacity,
            slots: inv.slots.map((slot) => (slot ? { ...slot } : null)),
          };
          const leftover = addToInventory(dry, this.world.gameDef.itemsByKind, stack.kind, stack.count, {
            spoilAt: stack.spoilAt,
            durability: stack.durability,
          });
          if (leftover >= stack.count) return "inventory_full";
          return "unknown";
        }
        if (command.slot === command.toSlot) return "invalid";
        if (!Number.isInteger(slotIndex) || !Number.isInteger(command.toSlot ?? -1)) return "invalid";
        const stack = inv.slots[slotIndex];
        if (!stack) return "no_item";
        return "unknown";
      }
      case "equip": {
        const stack = inv?.slots[slotIndex];
        if (!stack) return "no_item";
        const equip = this.world.gameDef.itemsByKind?.get(stack.kind)?.equip;
        if (!equip || !hasComponent(this.world, eid, Equipment)) return "invalid";
        return "unknown";
      }
      case "craft": {
        const craftingRule = this.world.gameDef.resolvedRules["crafting"] as
          | { recipes?: CraftingRecipe[] }
          | undefined;
        const recipe = craftingRule?.recipes?.find((entry) => entry.id === (command.recipe ?? ""));
        if (!recipe) return "invalid";
        if (!inv) return "invalid";

        // unlock 条件在 craftingSystem 内是已注册函数，外部无法安全求值——
        // 有解锁门且无法确定是否通过时保持 unknown（不猜测）。
        if ((recipe as CraftingRecipe & { unlock?: unknown }).unlock !== undefined) return "unknown";

        const stationType = recipe.stationType ?? 0;
        if (stationType !== 0) {
          const range = craftingStationRange(this.world);
          const usable = stationsInRange(this.world, eid, range).some(
            (stationEid) =>
              hasComponent(this.world, stationEid, CraftingStation) &&
              CraftingStation.stationType[stationEid] === stationType &&
              (!hasComponent(this.world, stationEid, LightSource) ||
                LightSource.fuelInfinite[stationEid] === 1 ||
                (LightSource.fuelRemainingMs[stationEid] ?? 0) > 0),
          );
          if (!usable) return "out_of_range";
        }

        // 缺料（与 hasMaterials 同口径：跨槽合计）
        for (const input of recipe.inputs) {
          let total = 0;
          for (const stack of inv.slots) {
            if (stack && stack.kind === input.kind) total += stack.count;
          }
          if (total < input.count) return "no_item";
        }

        // 满包（与 outputsFit 同口径：干跑 addToInventory）
        const dry = {
          capacity: inv.capacity,
          slots: inv.slots.map((slot) => (slot ? { ...slot } : null)),
        };
        for (const output of recipe.outputs) {
          const leftover = addToInventory(dry, this.world.gameDef.itemsByKind, output.kind, output.count, {
            nowTick: this.world.time.tick,
          });
          if (leftover > 0) return "inventory_full";
        }
        return "unknown";
      }
      case "craft-cancel": {
        const jobs = this.world.craftingJobs.get(eid);
        if (!jobs?.some((job) => job.recipeId === (command.recipe ?? ""))) return "invalid";
        // 退料放不下也会拒绝（原子快照回退）——无法从外部区分 → unknown
        return "unknown";
      }
      case "refuel": {
        const craftingRule = this.world.gameDef.resolvedRules["crafting"] as
          | { fuel?: { items?: Record<string, number> } }
          | undefined;
        if (!craftingRule?.fuel) return "invalid";
        const range = craftingStationRange(this.world);
        const stations = stationsInRange(this.world, eid, range).filter((stationEid) => {
          if (!hasComponent(this.world, stationEid, LightSource)) return false;
          if (command.target === undefined) return true;
          return NetworkId.value[stationEid] === command.target;
        });
        if (stations.length === 0) return "out_of_range";
        const fuelKinds = Object.keys(craftingRule.fuel.items ?? {});
        const hasFuel = inv?.slots.some((stack) => stack !== null && fuelKinds.includes(stack.kind)) ?? false;
        if (!hasFuel) return "no_item";
        return "unknown";
      }
      case "place": {
        const stack = inv?.slots[slotIndex];
        if (!stack) return "no_item";
        const item = this.world.gameDef.itemsByKind?.get(stack.kind);
        if (!item?.place) return "invalid";
        if (!this.world.archetypes.has(item.place.archetype)) return "invalid";
        if (!hasComponent(this.world, eid, Transform)) return "invalid";
        const rules = this.world.gameDef.resolvedRules["place"] as
          | { placeRange?: number }
          | undefined;
        const range = rules?.placeRange ?? 64;
        const level = entityLevelOf(eid);
        if (
          !isGameplayReachable(
            { x: Transform.x[eid], y: Transform.y[eid], level },
            { x: command.x ?? 0, y: command.y ?? 0, level },
            range,
          )
        ) {
          return "out_of_range";
        }
        // 距离已过：原子剩余拒绝原因 = 重叠/占用/地图阻挡 → blocked
        return "blocked";
      }
      case "deconstruct": {
        const targetEid = this.eidByNetworkId(command.target ?? -1);
        if (targetEid === undefined) return "invalid";
        if (!hasComponent(this.world, targetEid, Placeable)) return "invalid";
        if (!hasComponent(this.world, eid, Transform) || !hasComponent(this.world, targetEid, Transform)) {
          return "invalid";
        }
        if (entityMapOf(this.world, targetEid) !== entityMapOf(this.world, eid)) {
          return "out_of_range";
        }
        const owner = Placeable.ownerNetworkId[targetEid] ?? 0;
        if (owner === 0 || owner !== NetworkId.value[eid]) return "not_owner";
        const rules = this.world.gameDef.resolvedRules["place"] as
          | { placeRange?: number }
          | undefined;
        const range = rules?.placeRange ?? 64;
        if (
          !isGameplayReachable(
            { x: Transform.x[eid], y: Transform.y[eid], level: entityLevelOf(eid) },
            { x: Transform.x[targetEid], y: Transform.y[targetEid], level: entityLevelOf(targetEid) },
            range,
          )
        ) {
          return "out_of_range";
        }
        // 连接器 stranded 等结构约束 → blocked
        return "blocked";
      }
      case "throw": {
        if ((Cooldown.remainingMs[eid] ?? 0) > 0) return "cooldown";
        const weapon = getEquippedItemKind(this.world, eid, "weapon");
        if (!weapon?.throw) return "no_item";
        return "unknown";
      }
      case "dialogue": {
        if (!Dialogue[eid]) return "invalid";
        return "unknown";
      }
      case "offer":
        return "invalid";
      case "offer-accept":
      case "offer-cancel": {
        const session = this.world.offerSessions.get(offerIdOf(command.offerId));
        if (!session) return "invalid";
        if (!session.terms.some((party) => party.party === eid)) return "not_owner";
        return "unknown";
      }
      default:
        return "invalid";
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
    const snapshot = getCollisionDebugSnapshot(this.world, options) as {
      entityBodies: Array<Record<string, unknown> & { eid?: number }>;
      pairs?: Array<{ id: string; a: string; b: string; overlap: number }>;
    };
    // CC-04：调试碰撞体补稳定对外 id。`networkId` 是客户端应使用的字段；
    // `eid` 仅按 CC-04 的兼容许可保留给旧调试客户端（事件/业务载荷不含 eid）。
    for (const body of snapshot.entityBodies) {
      const eid = body.eid;
      if (typeof eid !== "number") continue;
      const networkId = networkIdOf(this.world, eid);
      if (networkId !== undefined) body.networkId = networkId;
    }
    // 碰撞对的调试 id 形如 `entity:<eid>`：一并换成 networkId，避免旁路泄漏。
    const remapToken = (token: string): string => {
      if (!token.startsWith("entity:")) return token;
      const eid = Number(token.slice("entity:".length));
      const networkId = Number.isInteger(eid) ? networkIdOf(this.world, eid) : undefined;
      return `entity:${networkId ?? "unknown"}`;
    };
    if (snapshot.pairs) {
      for (const pair of snapshot.pairs) {
        pair.a = remapToken(pair.a);
        pair.b = remapToken(pair.b);
        const [left, right] = pair.a < pair.b ? [pair.a, pair.b] : [pair.b, pair.a];
        pair.id = `${left}|${right}`;
      }
    }
    return snapshot;
  }

  /**
   * 取某张图的实时几何快照（世界当前持有的几何，含运行期写回）。
   *
   * 图不在 world.maps 中（未构建/未知 key）时返回 undefined——调用方据此
   * 回退到「按配置重建」的视图。
   */
  getMapGeometry(mapId: string): SerializedMapGeometry | undefined {
    const geometry = this.world.maps[mapId];
    if (!geometry) return undefined;
    return serializeGeometry(geometry);
  }

  /** 地图生成配置清单（配置声明序）——传输层据此描述地图元信息。 */
  getMapConfigs(): MapConfig[] {
    return [...this.mapConfigsByKey.values()];
  }

  /**
   * 调试用：写回单格地面语义（terrainWriteback 唯一合法入口）。
   *
   * 供「/maps 端点读 live 几何」的验证：写回后 tiles 与 version 指纹变化，
   * live 视图与「按配置重建」视图随即分叉。
   */
  debugSetGround(mapId: string, tileIndex: number, semanticId: number): boolean {
    return setGround(this.world, mapId, tileIndex, semanticId);
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
    // 序列化同步完成；写盘 fire-and-forget（异步 I/O 不入 ECS 系统）
    void this.flushSave(reason);
  }

  /**
   * 立即存档（可等待版本）——供**进程退出/存档 flush** 路径使用，保证写盘
   * 完成后再让调用方继续（GameRoom.onDispose / SIGINT/SIGTERM 停机）。
   *
   * 与定时存档共用同一 `serializeWorld → repository.saveWorld` 通路；序列化
   * 同步完成（快照一致性），写盘串行化由仓储实现负责。重复调用幂等：同一
   * 世界状态重复落盘，最后一次内容一致；失败仅记日志并返回 false。
   *
   * @param reason 存档触发原因（日志定位用）
   * @returns 是否成功落盘；未接仓储/存档 id 时返回 false（no-op）
   */
  async flushSave(reason = "manual"): Promise<boolean> {
    if (!this.repository || !this.saveId) return false;

    const record = serializeWorld(this.world, this.saveId);
    // 重置定时存档累计：本次已落盘，避免紧随其后的重复定时存档
    this.sinceLastSaveMs = 0;

    try {
      await this.repository.saveWorld(record);
      return true;
    } catch (err) {
      this.world.logger.error("存档写入失败", {
        saveId: this.saveId,
        reason,
        error: err instanceof Error ? err.stack : String(err),
      });
      return false;
    }
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
      // 动作载荷是单帧脉冲：无新 interact/attack 输入则清空（不跨帧堆积）
      ActionInput[eid] = undefined;
    }

    for (const [sessionId, input] of this.latestInputBySessionId) {
      const eid = this.playerEidBySessionId.get(sessionId);
      if (typeof eid !== "number") continue;
      // 死亡/重生窗口内（原地重置语义，实体未移除）：不接收移动与意图输入
      if ((Health.current[eid] ?? 0) <= 0) continue;
      // 动作锁移动：锁定期清零速度（不把本帧移动输入写进 ECS），动作结束/
      // 取消后的下一 tick 自动恢复；interruptible 动作仍允许输入意图替换。
      const action = ActionState[eid];
      if (!action?.locked) {
        Velocity.vx[eid] = input.moveX;
        Velocity.vy[eid] = input.moveY;
      }
      if (input.interact || input.attack) {
        ActionInput[eid] = {
          ...(input.target !== undefined ? { target: input.target } : {}),
          ...(input.aimX !== undefined && input.aimY !== undefined
            ? { aimX: input.aimX, aimY: input.aimY }
            : {}),
        };
      }
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
    // 环境派生（相位/天气/进度）：tick 的纯函数（environmentAt），与
    // environmentSystem 的缓存同源——离线补差后同样正确。
    const environment = environmentAt(this.world);
    const snapshotShell = {
      tick,
      entities,
      timeOfDay: { ...timeOfDayOf(this.world) },
      environment: {
        weatherId: environment.weatherId,
        phaseId: environment.phaseId,
        phaseProgress: environment.progress,
      },
      offers: this.buildOfferSummaries(),
      playerMaps,
    };

    // 无同步配置 → 空快照（客户端看不到实体）
    if (this.netSyncFields.length === 0) {
      return snapshotShell;
    }
    for (const field of this.netSyncFields) {
      const ensure = (id: number, eid: number): EntitySnapshot => {
        let snap = entities.get(id);
        if (!snap) {
          snap = {
            values: {},
            strings: {},
            mapId: entityMapOf(this.world, eid),
            level: entityLevelOf(eid),
            player: hasComponent(this.world, eid, Player),
          };
          entities.set(id, snap);
        }
        return snap;
      };

      // 派生投影（非 ECS 组件）：制作进度直接从 world.craftingJobs 展平
      if (field.component === CRAFTING_SYNC_COMPONENT) {
        this.writeCraftingProjection(field, ensure);
        continue;
      }

      // 派生投影：动作时间轴瞬态状态（ActionState 不注册持久组件，避免入档/
      // 恢复出指向旧 eid 的动作；每帧从 AoS 状态经适配器展平 Action.* key）
      if (field.component === ACTION_SYNC_COMPONENT) {
        this.writeActionProjection(field, ensure);
        continue;
      }

      const comp = this.componentRegistry.get(field.component) as
        | Record<string, unknown>
        | unknown[]
        | undefined;
      if (!comp) continue;

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
      // tags 语义：条目声明 tags 时**只同步带该标签的实体**（如 Cooldown 只给
      // Player 标签实体），未声明 tags 时按组件全量同步（历史行为）。
      const soaEntities = field.tags
        ? [...this.queryByTags(field.tags)].filter((eid) =>
            hasComponent(this.world, eid, comp as object),
          )
        : query(this.world, [NetworkId, comp as object]);
      for (const eid of soaEntities) {
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

    return snapshotShell;
  }

  /**
   * 动作时间轴派生投影（`component: "Action"` netSync 条目）。
   *
   * ActionState 是瞬态 AoS 状态（不注册为持久组件、不入档），这里按 netSync
   * 白名单经 AoS 适配器展平为 `Action.*` 动态 key：
   * - `Action.actionId` / `Action.phase`（stringValues）
   * - `Action.startedTick` / `durationTicks` / `phaseIndex` / `target`（values；
   *   target 是 **networkId**，适配器绝不输出 eid）
   * - `Action.dirX` / `Action.dirY`（values）
   *
   * 无动作的实体不写入任何 Action.* key → GameRoom key diff 清掉旧残留。
   */
  private writeActionProjection(
    field: { fields: string[]; tags?: string[] },
    ensure: (id: number, eid: number) => EntitySnapshot,
  ): void {
    const adapter = getAosSyncAdapter(ACTION_SYNC_COMPONENT);
    if (!adapter) return;
    for (const eid of this.queryByTags(field.tags)) {
      if (!ActionState[eid]) continue;
      // 断线保留期实体不进快照（与 SoA/AoS 路径同一门控）
      if (isOfflineRetained(this.world, eid)) continue;
      const snap = ensure(NetworkId.value[eid], eid);
      const result = adapter(this.world, eid, field.fields);
      Object.assign(snap.values, result.numbers);
      Object.assign(snap.strings, result.strings);
    }
  }

  /**
   * 制作进度派生投影（`component: "Crafting"` netSync 条目）。
   *
   * `world.craftingJobs` 是运行时任务表（非 ECS 组件），这里按玩家展平为
   * EntityState 动态 key（客户端只读，按前缀分组）：
   * - `Crafting.<i>.recipeId`（stringValues）——配方 id
   * - `Crafting.<i>.remainingTicks`（values）——距完成剩余 tick（0 = 到点）
   * - `Crafting.<i>.progress`（values）——时间进度 [0,1]，挂起中恒 1
   * - `Crafting.<i>.suspended`（values）——1 = 到点但产出条件未满足（站点
   *   失效/满包），0 = 正常倒计时
   *
   * 索引 `i` 是任务表顺序（0..n-1 连续）；任务完成/取消后该条目整体消失，
   * GameRoom 的 key diff 会清除旧键。条目命中即让实体进快照（OR 语义），
   * 与 SoA/AoS 条目一致地受 isOfflineRetained 门控。
   */
  private writeCraftingProjection(
    field: { fields: string[]; tags?: string[] },
    ensure: (id: number, eid: number) => EntitySnapshot,
  ): void {
    if (!field.fields.includes("jobs")) return;
    for (const eid of this.queryByTags(field.tags)) {
      // 断线保留期实体不进快照（与 AoI/SoA 路径同一门控）
      if (isOfflineRetained(this.world, eid)) continue;
      const snap = ensure(NetworkId.value[eid], eid);
      const jobs = craftingProgressOf(this.world, eid);
      for (let i = 0; i < jobs.length; i++) {
        const job = jobs[i]!;
        snap.strings[`Crafting.${i}.recipeId`] = job.recipeId;
        snap.values[`Crafting.${i}.remainingTicks`] = job.remainingTicks;
        snap.values[`Crafting.${i}.progress`] = job.progress;
        snap.values[`Crafting.${i}.suspended`] = job.remainingTicks === 0 ? 1 : 0;
      }
    }
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