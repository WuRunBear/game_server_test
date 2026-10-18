/**
 * 世界快照序列化/恢复——持久化的核心，纯数据层（无 I/O）。
 *
 * 职责：
 * - `serializeWorld`：把 ECS world 的全部持久状态导出为纯 JSON（WorldRecord，
 *   含全部已构建图的地理快照 maps——与实体同盘；地形写回复切片起单图条目
 *   增量优先：登记了出厂底板且有未超阈修改的图写稀疏修改项，其余走现行
 *   全量快照）
 * - `restoreWorld`：按 WorldRecord 恢复实体与全局时刻（tick/timeOfDay）并把
 *   快照图接入激活集（幂等，先清空当前实体；world.maps 回填归 bootMaps）
 *
 * 设计要点：
 * 1. **瞬态组件跳过**：运行时状态（AI 目标/黑板引用/计时器/帧脉冲/同步标记）
 *    入存档无意义——恢复后由系统与输入自然重建；组件名保持框架通用。
 * 2. **两条读路径**：SoA（bitecs 数值数组按 eid 读字段）与 AoS（JS 数组读整体
 *    结构），与 netSync 的 buildSnapshot 同构。
 * 3. **恢复语义**：按 kind 查 archetype → spawnEntity（含 tags/team/AoS 初始化）
 *    → 覆写存档组件值 → 覆写 NetworkId（保持客户端稳定标识）→ 固定 nextNetworkId。
 * 4. **eid 不保真**：恢复后 eid 由 bitecs 重新分配，跨存档引用（如 Target 的 eid）
 *    一律不入存档（瞬态名单）；客户端凭 networkId 稳定追踪实体。
 */
import { query, hasComponent, addComponent } from "bitecs";

import { NetworkId } from "framework/components/network";
import { Kind } from "framework/components/kind";
import { Health } from "framework/components/combat";
import { Offline } from "framework/components/offline";
import { Lifetime } from "framework/components/lifetime";
import { Player } from "framework/components/tags";
import { getRespawnMarkers } from "framework/systems/gameplay/deathSystem";
import { spawnEntity } from "framework/entities/spawn";
import { destroyEntity } from "framework/entities/destroyEntity";
import { restoreCraftingJobs, serializeCraftingJobs } from "framework/systems/gameplay/craftingSystem";
import { serializeGeometry, type SerializedMapGeometry } from "map/geometry/snapshot";
import {
  computeTileModifications,
  exceedsDeltaThreshold,
  type SerializedMapDelta,
} from "map/geometry/delta";
import { terrainBaselineOf } from "map/runtime/terrainWriteback";
import { getMapSeeds } from "map/runtime/mapSeeds";
import { timeOfDayOf, syncTimeOfDay } from "framework/simulation/worldClock/dayNight";
import type { GameWorld } from "framework/world";
import type { ComponentRegistry } from "framework/components/componentRegistry";
import type { SerializedEntity, WorldRecord } from "framework/repository";

/**
 * 瞬态组件黑名单：这些组件不进存档。
 *
 * 理由（逐项）：
 * - Velocity：每帧清零/写入的移动输入，存档瞬间值无意义
 * - Target / AIState / BlackboardRef：AI 运行时状态，目标 eid 跨存档失效，恢复后重感知
 * - Cooldown / Duration：计时器，重启即重置
 * - Intent：一帧脉冲信号
 * - LastSynced：传输层内部同步标记
 * - Kind：由 archetype.kind 承载（序列化用 kind 字段，恢复时 spawnEntity 重写）
 * - NetworkId：单独存于 SerializedEntity.networkId 字段，恢复时显式覆写，故不进组件块
 * - Dialogue：瞬态对话会话（当前对话树/节点/选项），断线重连后重置
 * - ExpiresAt / Interval：定时器运行时状态（绝对 tick 跨存档失效），
 *   恢复后由效果/触发配置重建；需要跨重启存续的绝对寿命请用 **Lifetime**
 *   （实体级持久到期 tick，随实体入档，不由本清单排除）。
 * - Projectile：投射物运行时实体（owner eid 跨存档失效），寿命短暂不入档
 *
 * 例外：Offline（断线保留标记 + 到期绝对 tick）**入档**——重启后保留中的
 * 玩家实体必须继续保持离线排除语义，否则会变成被饥饿/感知/袭击的幽灵玩家。
 * 恢复出的无 Offline 玩家实体（旧档或断线前的在线实体）由 GameSimulation
 * 在开机时统一补标记为离线保留。
 */
const RUNTIME_ONLY_COMPONENTS = new Set([
  "Velocity",
  "Target",
  "AIState",
  "BlackboardRef",
  "Cooldown",
  "Duration",
  "Intent",
  "LastSynced",
  "Kind",
  "NetworkId",
  "Dialogue",
  "ExpiresAt",
  "Interval",
  "Projectile",
]);

/** 序列化单实体：遍历组件注册表，按 SoA/AoS 读当前值。 */
function serializeEntity(
  world: GameWorld,
  eid: number,
  registry: ComponentRegistry,
): SerializedEntity {
  const components: Record<string, unknown> = {};
  for (const [name, comp] of Object.entries(registry.all())) {
    if (RUNTIME_ONLY_COMPONENTS.has(name)) continue;

    if (registry.isAosComponent(name)) {
      const value = (comp as unknown[])[eid];
      if (value !== undefined) {
        components[name] = structuredClone(value);
      }
      continue;
    }

    const compObj = comp as Record<string, { [eid: number]: number }>;
    // Offline 入档需按"实际挂载"判定：bitecs legacy 组件字段是定长 typed array，
    // `eid in arr` 恒为 true（含从未挂载/已摘除的实体），直接按值序列化会把
    // 所有实体都写成 Offline{untilTick:0}，恢复后下一 tick 全被清扫。
    if (name === "Offline" && !hasComponent(world, eid, Offline)) continue;
    // Lifetime 同理：只有真正挂载了持久寿命的实体（死亡容器等）才写入档，
    // 避免给所有实体塞一个 expiresTick:0（恢复时缺 hasComponent 也会被丢弃）。
    if (name === "Lifetime" && !hasComponent(world, eid, Lifetime)) continue;
    const values: Record<string, number> = {};
    for (const field of Object.keys(compObj)) {
      const arr = compObj[field];
      if (typeof arr === "object" && eid in arr) {
        values[field] = arr[eid];
      }
    }
    if (Object.keys(values).length > 0) {
      components[name] = values;
    }
  }
  return { networkId: NetworkId.value[eid], kind: Kind[eid] ?? "", components };
}

/**
 * 单图快照条目序列化（地形写回复切片起增量优先）：
 * - 登记了出厂底板且存在修改、且修改数未超阈值 → 增量条目
 *   （SerializedMapDelta：稀疏终态修改项 + 底板指纹——底板由读档按 seed 重算，
 *   不重复落盘）；
 * - 无底板（全量回填路径）、零修改、修改数超阈值（>10% tiles，降级）→ 现行
 *   全量条目（serializeGeometry）。零修改也走全量：保持「键集 = 已构建图键集」
 *   且全量条目读档即逐字节还原（现行读档契约不变）。
 */
function serializeMapEntry(
  world: GameWorld,
  key: string,
  geometry: Parameters<typeof serializeGeometry>[0],
): SerializedMapGeometry | SerializedMapDelta {
  const baseline = terrainBaselineOf(world, key);
  if (baseline) {
    const modifications = computeTileModifications(geometry, baseline);
    if (modifications.length > 0 && !exceedsDeltaThreshold(modifications.length, geometry)) {
      return { format: "delta", key, baseVersion: baseline.version, modifications };
    }
  }
  return serializeGeometry(geometry);
}

/** 导出世界为纯 JSON 存档（含全部已构建图的地理快照——maps 与实体同盘）。 */
export function serializeWorld(world: GameWorld, id: string): WorldRecord {
  const registry = world.components_registry;
  const entities: SerializedEntity[] = [];
  for (const eid of query(world, [NetworkId])) {
    entities.push(serializeEntity(world, eid, registry));
  }
  const maps: Record<string, SerializedMapGeometry | SerializedMapDelta> = {};
  for (const [key, geometry] of Object.entries(world.maps)) {
    maps[key] = serializeMapEntry(world, key, geometry);
  }
  // 每图 seed 解析结果固化进存档（bootMaps 两条开机分支写入弱表；读档路径
  // 据此恢复演化选点流——快照回填不重建几何，但演化流须与存档世界同 seed）
  const mapSeeds = getMapSeeds(world);
  return {
    id,
    savedAt: Date.now(),
    tick: world.time.tick,
    nextNetworkId: world.nextNetworkId,
    // 昼夜从 tick 现场派生（有 daynight 规则时）——存档与时钟永不漂移；
    // 无规则世界回退缓存值（时间冻结的既有语义）。
    timeOfDay: { ...timeOfDayOf(world) },
    maps,
    ...(mapSeeds ? { mapSeeds: { ...mapSeeds } } : {}),
    progress: { ...world.progress },
    craftingJobs: serializeCraftingJobs(world),
    entities,
  };
}

/** 清空当前 world 的实体（destroyEntity 同时清理 AoS 残留）。 */
function clearWorld(world: GameWorld): void {
  for (const eid of [...query(world, [NetworkId])]) {
    destroyEntity(world, eid);
  }
}

/**
 * 恢复断线保留标记：Offline 随档入档（见 RUNTIME_ONLY_COMPONENTS 注释）。
 *
 * spawnEntity 不挂 Offline（原型配置表达不了会话事实），故按存档条目显式
 * 补挂后再写字段；畸形 untilTick 归一为 0（下一 tick 清扫即销毁，不让坏档
 * 留下永久幽灵实体）。
 */
function restoreOfflineMarker(world: GameWorld, eid: number, saved: SerializedEntity): void {
  const raw = saved.components["Offline"];
  if (!raw || typeof raw !== "object") return;
  if (!hasComponent(world, eid, Offline)) {
    addComponent(world, eid, Offline);
  }
  const until = (raw as { untilTick?: unknown }).untilTick;
  Offline.untilTick[eid] =
    typeof until === "number" && Number.isFinite(until) && until >= 0 ? Math.floor(until) : 0;
}

/** 覆写单实体的组件值（SoA 写字段，AoS 整体替换）。 */
function applyEntityState(world: GameWorld, eid: number, saved: SerializedEntity): void {
  const registry = world.components_registry;
  for (const [name, state] of Object.entries(saved.components)) {
    if (RUNTIME_ONLY_COMPONENTS.has(name)) continue;
    if (!registry.has(name)) continue;

    const comp = registry.get(name) as Record<string, unknown> | unknown[];
    if (Array.isArray(comp)) {
      (comp as unknown[])[eid] = structuredClone(state);
      continue;
    }
    // SoA 组件：只写实体上真实挂载的组件（hasComponent 守卫，防版本漂移时
    // 向未挂载的组件写死数据——数据会静默丢失且污染后续序列化）
    if (!hasComponent(world, eid, comp as object)) continue;
    const compObj = comp as Record<string, Record<number, unknown>>;
    for (const [field, value] of Object.entries(state as Record<string, unknown>)) {
      if (compObj[field] !== undefined) {
        compObj[field][eid] = value as number;
      }
    }
  }
}

/**
 * 按存档恢复世界状态（职责单一：实体 + 全局时刻 + 激活集）。
 *
 * - 实体恢复：按 kind 查 archetype → spawnEntity → 覆写存档组件值
 *   （含 EntityMap 归属）→ 覆写 NetworkId → 固定 nextNetworkId；
 * - 全局时刻：world.time.tick = 存档 tick、timeOfDay = 存档值（离线补差
 *   由 GameSimulation 在本函数返回后接手，墙钟折算不入本模块）；
 * - 世界进度账本：world.progress = 存档 progress（旧档缺字段按空账本恢复）；
 * - 延时制作任务：按合成者 NetworkId 映射回新 eid 恢复（旧档缺字段按空表）；
 * - 激活集：全部快照图（record.maps 键）加入 world.activeMaps（常驻语义，
 *   空图也照常运行演化/碰撞）。world.maps 的回填归 bootMaps（开机分支
 *   唯一归属地），本函数不碰 world.maps——仅接入 boot 已回填的快照图，
 *   boot 丢弃的键（配置已删）不激活。
 *
 * 防御畸形存档：entities 缺省/非数组按空处理（恢复出一个空世界，不抛错）；
 * 单实体 components 缺省按空对象处理。
 *
 * @returns 恢复出的玩家实体 eid 列表（GameSimulation 开机时对其中无 Offline
 *   标记的实体统一补 marked-offline，避免旧档/在线实体变成幽灵玩家；
 *   不再作为 addPlayer 的 FIFO 复用队列——身份复用只按 networkId 严格匹配）。
 */
export function restoreWorld(world: GameWorld, record: WorldRecord): number[] {
  clearWorld(world);

  world.time.tick = record.tick;
  if (record.timeOfDay) {
    world.time.timeOfDay = { ...record.timeOfDay };
  }
  // 单一时钟：有 daynight 规则时 hour/phase 从恢复后的 tick 重算（存档值仅
  // 作为无规则世界的回退）；离线补差随后推进 tick 时由 advanceTickTo 再次重算。
  syncTimeOfDay(world);
  world.nextNetworkId = record.nextNetworkId;

  // 世界进度账本：缺省（旧档）按空账本恢复；只收有限数值，畸形条目丢弃。
  const restoredProgress: Record<string, number> = {};
  const savedProgress = record.progress;
  if (savedProgress && typeof savedProgress === "object") {
    for (const [key, value] of Object.entries(savedProgress)) {
      if (typeof value === "number" && Number.isFinite(value)) {
        restoredProgress[key] = value;
      }
    }
  }
  world.progress = restoredProgress;

  const orphanPlayers: number[] = [];
  const eidByNetworkId = new Map<number, number>();
  const savedEntities = Array.isArray(record.entities) ? record.entities : [];
  for (const saved of savedEntities) {
    if (!saved || typeof saved !== "object") continue;
    const archetype = world.archetypes.has(saved.kind) ? world.archetypes.get(saved.kind) : undefined;
    if (!archetype) {
      world.logger.warn("存档实体原型未知，跳过", { kind: saved.kind, networkId: saved.networkId });
      continue;
    }

    // 归属恢复：spawnEntity 先写默认图，随后的 applyEntityState 用存档
    // components["EntityMap"]（AoS 自动入档）整体覆写——存档值胜出。
    const eid = spawnEntity(world, archetype, world.components_registry);
    restoreOfflineMarker(world, eid, saved);
    // Lifetime 是运行时挂载的可选组件（原型不声明）：存档存在该块时先补挂，
    // 否则 applyEntityState 的 hasComponent 守卫会丢弃到期 tick，容器变永久。
    if (saved.components["Lifetime"] !== undefined && !hasComponent(world, eid, Lifetime)) {
      addComponent(world, eid, Lifetime);
    }
    applyEntityState(world, eid, saved);
    NetworkId.value[eid] = saved.networkId;
    eidByNetworkId.set(saved.networkId, eid);
    // 玩家判定按 Player tag（与具体 kind 名解耦）
    if (hasComponent(world, eid, Player)) {
      orphanPlayers.push(eid);
    }
  }
  world.nextNetworkId = record.nextNetworkId;

  // 延时制作任务：实体恢复完成后按 networkId → eid 映射重建（旧档缺字段 =
  // 空表；绝对 finishTick 已随世界时钟恢复，离线补差推进 tick 后自然到期）。
  restoreCraftingJobs(world, record.craftingJobs, eidByNetworkId);

  // 重启重复死亡修复（F-32）：重生标记是运行时状态、不入档。若玩家在死亡窗口
  // 内被存档，重启后 deathSystem 会把"0 血且无标记"再次当成首次死亡——重复
  // 掷掉落并再生成一个空容器（背包已在首次死亡转移走）。恢复后统一补重生标记
  // （当前 tick 即到期），首 tick 由 respawnSystem 复活；deathSystem 因已有
  // 标记直接跳过，容器/掉落均不重复。
  const respawnMarkers = getRespawnMarkers(world);
  const nowMs = world.time.tick * world.time.fixedDtMs;
  for (const eid of orphanPlayers) {
    if (!hasComponent(world, eid, Player)) continue;
    if (!hasComponent(world, eid, Health)) continue;
    if ((Health.current[eid] ?? 0) > 0) continue;
    if (!respawnMarkers.has(eid)) {
      respawnMarkers.set(eid, { respawnAtMs: nowMs });
    }
  }

  // 全部快照图接入激活集（常驻语义：空图也活着）；仅接入已回填的键——
  // world.maps 的回填归 bootMaps，boot 丢弃的快照键（配置已删）不激活。
  for (const mapKey of Object.keys(record.maps ?? {})) {
    if (world.maps[mapKey]) {
      world.activeMaps.add(mapKey);
    }
  }

  return orphanPlayers;
}
