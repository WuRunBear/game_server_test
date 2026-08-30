/**
 * 世界快照序列化/恢复——持久化的核心，纯数据层（无 I/O）。
 *
 * 职责：
 * - `serializeWorld`：把 ECS world 的全部持久状态导出为纯 JSON（WorldRecord，
 *   含全部已构建图的地理快照 maps——与实体同盘）
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
import { query, hasComponent } from "bitecs";

import { NetworkId } from "framework/components/network";
import { Kind } from "framework/components/kind";
import { Player } from "framework/components/tags";
import { spawnEntity } from "framework/entities/spawn";
import { destroyEntity } from "framework/entities/destroyEntity";
import { serializeGeometry, type SerializedMapGeometry } from "map/geometry/snapshot";
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

/** 导出世界为纯 JSON 存档（含全部已构建图的地理快照——maps 与实体同盘）。 */
export function serializeWorld(world: GameWorld, id: string): WorldRecord {
  const registry = world.components_registry;
  const entities: SerializedEntity[] = [];
  for (const eid of query(world, [NetworkId])) {
    entities.push(serializeEntity(world, eid, registry));
  }
  const maps: Record<string, SerializedMapGeometry> = {};
  for (const [key, geometry] of Object.entries(world.maps)) {
    maps[key] = serializeGeometry(geometry);
  }
  return {
    id,
    savedAt: Date.now(),
    tick: world.time.tick,
    nextNetworkId: world.nextNetworkId,
    timeOfDay: { ...world.time.timeOfDay },
    maps,
    entities,
  };
}

/** 清空当前 world 的实体（destroyEntity 同时清理 AoS 残留）。 */
function clearWorld(world: GameWorld): void {
  for (const eid of [...query(world, [NetworkId])]) {
    destroyEntity(world, eid);
  }
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
 * - 激活集：全部快照图（record.maps 键）加入 world.activeMaps（常驻语义，
 *   空图也照常运行演化/碰撞）。world.maps 的回填归 bootMaps（开机分支
 *   唯一归属地），本函数不碰 world.maps——仅接入 boot 已回填的快照图，
 *   boot 丢弃的键（配置已删）不激活。
 *
 * 防御畸形存档：entities 缺省/非数组按空处理（恢复出一个空世界，不抛错）；
 * 单实体 components 缺省按空对象处理。
 *
 * @returns 恢复出的玩家实体 eid 列表（供 addPlayer 复用绑定）。
 */
export function restoreWorld(world: GameWorld, record: WorldRecord): number[] {
  clearWorld(world);

  world.time.tick = record.tick;
  if (record.timeOfDay) {
    world.time.timeOfDay = { ...record.timeOfDay };
  }
  world.nextNetworkId = record.nextNetworkId;

  const orphanPlayers: number[] = [];
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
    applyEntityState(world, eid, saved);
    NetworkId.value[eid] = saved.networkId;
    // 玩家判定按 Player tag（与具体 kind 名解耦）
    if (hasComponent(world, eid, Player)) {
      orphanPlayers.push(eid);
    }
  }
  world.nextNetworkId = record.nextNetworkId;

  // 全部快照图接入激活集（常驻语义：空图也活着）；仅接入已回填的键——
  // world.maps 的回填归 bootMaps，boot 丢弃的快照键（配置已删）不激活。
  for (const mapKey of Object.keys(record.maps ?? {})) {
    if (world.maps[mapKey]) {
      world.activeMaps.add(mapKey);
    }
  }

  return orphanPlayers;
}
