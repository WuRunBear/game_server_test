/**
 * 世界快照序列化/恢复——持久化的核心，纯数据层（无 I/O）。
 *
 * 职责：
 * - `serializeWorld`：把 ECS world 的全部持久状态导出为纯 JSON（WorldRecord）
 * - `restoreWorld`：按 WorldRecord 重建实体与组件（幂等，先清空当前 world）
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
import { EntityMap } from "framework/components/entityMap";
import { spawnEntity } from "framework/entities/spawn";
import { destroyEntity } from "framework/entities/destroyEntity";
import { ensureMapActive } from "framework/map/switchMap";
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

/** 导出世界为纯 JSON 存档。 */
export function serializeWorld(world: GameWorld, id: string): WorldRecord {
  const registry = world.components_registry;
  const entities: SerializedEntity[] = [];
  for (const eid of query(world, [NetworkId])) {
    entities.push(serializeEntity(world, eid, registry));
  }
  return {
    id,
    savedAt: Date.now(),
    tick: world.time.tick,
    nextNetworkId: world.nextNetworkId,
    timeOfDay: { ...world.time.timeOfDay },
    // 保留写 mapId：仅作旧档迁移回退（新档实体归属以 components["EntityMap"]
    // 为准）。写 world.defaultMapId 而非弃用别名 world.map——多图世界下 world.map
    // 仅是默认图引用（T2 弃用别名），默认图 id 的权威字段是 world.defaultMapId。
    mapId: world.defaultMapId,
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
 * 按存档重建 world（先清空当前实体，避免与初始刷怪重复）。
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
  const restoredMaps = new Set<string>();
  const savedEntities = Array.isArray(record.entities) ? record.entities : [];
  for (const saved of savedEntities) {
    if (!saved || typeof saved !== "object") continue;
    const archetype = world.archetypes.has(saved.kind) ? world.archetypes.get(saved.kind) : undefined;
    if (!archetype) {
      world.logger.warn("存档实体原型未知，跳过", { kind: saved.kind, networkId: saved.networkId });
      continue;
    }

    // 地图归属优先级链：存档实体标记 > 旧档 record.mapId 回退 > 世界默认图。
    // 顺序说明：spawnEntity 先写 EntityMap[eid] = overrides.mapId ?? defaultMapId；
    // 随后的 applyEntityState 对 components["EntityMap"]（若有）整体覆写回 eid——
    // 与 overrides.mapId 同值（同源解析），两条路径交汇于同一归属，存档值胜出。
    // 旧档实体无 EntityMap 组件 → applyEntityState 不写，回退值由 spawn 写入生效。
    const savedMap = (saved.components as Record<string, unknown> | undefined)?.["EntityMap"];
    const mapId = typeof savedMap === "string" ? savedMap : (record.mapId ?? world.defaultMapId);
    const eid = spawnEntity(world, archetype, world.components_registry, { mapId });
    applyEntityState(world, eid, saved);
    NetworkId.value[eid] = saved.networkId;
    if (typeof EntityMap[eid] === "string" && EntityMap[eid] !== "") {
      restoredMaps.add(EntityMap[eid] as string);
    }
    // 玩家判定按 Player tag（与具体 kind 名解耦）
    if (hasComponent(world, eid, Player)) {
      orphanPlayers.push(eid);
    }
  }
  world.nextNetworkId = record.nextNetworkId;

  // 按恢复实体的地图归属重建激活集：实体归属生效即保证该图已构建/已激活
  // （ensureMapActive 幂等；未知图返回 false 静默跳过，空串已过滤）。
  // EntityMap 值即 registry key（运行时命名空间键），直接作为 ensureMapActive 的 mapId
  // 按 key 查来源即可，无需反查 source.id。
  // 以 { spawnInitialNpcs: false } 激活：恢复出的 NPC 已是存档实体，禁止在其上
  // 二次 spawn 初始 NPC（否则持久化 NPC 之上叠加同坐标的第二波，见 todo 修复）；投影
  // 图 activeMaps 收齐即可（常驻语义），实际实体由恢复循环重建。
  for (const mapId of restoredMaps) {
    ensureMapActive(world, mapId, { spawnInitialNpcs: false });
  }

  return orphanPlayers;
}
