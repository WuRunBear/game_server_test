/**
 * 客户端表现事件 outbox（CC-04）。
 *
 * 内部系统产生的事件只在这里**排队**，每 tick 结束后由 GameSimulation 统一
 * 排出、按受众过滤成 per-client 的 `ClientEvent[]`，再由 GameRoom 批量发送。
 *
 * ## 为什么不是 GameWorld 公共字段？
 *
 * outbox / seq 都是**传输层内部**的暂存数据，不属于仿真世界的权威状态。
 * 这里用模块级 WeakMap 按 world 隔离（`GameWorld` 类型零改动），避免存档、
 * 调试快照或其它系统误把事件队列当成世界状态。
 *
 * ## 受众模型
 *
 * - `self`   ：仅当事人（按实体 eid 精确匹配；客户端永远看不到 eid）。
 * - `nearby` ：同图 + 锚点半径内（锚点在**事件产生时**记录，不延迟读取已销毁
 *              实体）。
 * - `map`    ：同图玩家。
 * - `world`  ：全房间。
 *
 * ## seq 规则
 *
 * `seq` 在**事件产生时**分配，per-world 全局单调递增（每个内部事件 +1）。
 * 一个事件可能只发给部分客户端，因此客户端看到的 seq 会有空洞；它只保证
 * **严格单调**，用于去重/判断新旧，而不是“连续无缺口”。
 *
 * ## 出网约束
 *
 * 本模块只输出 `ClientEvent { seq, tick, type, data }`；`audience`、锚点、
 * 当事人 eid 等过滤信息**不会**进入发给客户端的 JSON。data 里的实体引用
 * 必须是 networkId（调用方负责 eid → networkId 转换）。
 *
 * ## 音频/VFX id 挂接
 *
 * `emitClientEvent` 在入队前按 `type` 查询当前表现配置的 `audio.events` /
 * `vfx.events`，把 `sfx` / `vfx`（不透明 id 数组）并入 `data`；无映射时
 * **不加键**。一条事件仍只发一条消息（不为每个音效/特效拆消息，避免消息膨胀），
 * 调用方显式放在 data 里的同名键优先（不覆盖）。
 *
 * `weather-change` / `map-change` 不强制携带 music/ambient：客户端可从 manifest
 * 的 `maps[].musicId` / `maps[].ambientId` 与事件自行决定音乐/环境音切换；
 * 服务端只发 id，不解释资源与切换策略。
 */
import { hasComponent } from "bitecs";

import { NetworkId } from "components/network";
import { Transform } from "components/transform";
import { entityMapOf } from "components/entityMap";
import { audioIdsForEvent, vfxIdsForEvent } from "framework/content/presentation";
import type { GameWorld, EntityId } from "framework/world";

/** 客户端事件受众（仅服务端过滤用，不出网）。 */
export type ClientEventAudience = "self" | "nearby" | "map" | "world";

/** 发给客户端的单条事件（唯一出网形态）。 */
export interface ClientEvent {
  /** per-world 全局单调递增序号。 */
  seq: number;
  /** 事件产生时的逻辑帧号。 */
  tick: number;
  /** 事件类型（如 hit / death / craft-complete）。 */
  type: string;
  /**
   * 事件载荷：实体引用一律 networkId，无 eid。
   *
   * 可选 `sfx` / `vfx`（string[]）：由 `emitClientEvent` 按 type 挂接的不透明
   * 播放 id（无映射时键不存在）。
   */
  data: Record<string, unknown>;
}

/** 客户端过滤视角：玩家当前实体/地图/坐标。 */
export interface ClientEventViewer {
  /** 玩家实体 eid（仅服务端内部使用）。 */
  eid: EntityId;
  /** 玩家当前地图 id。 */
  mapId: string;
  /** 玩家当前世界坐标 x。 */
  x: number;
  /** 玩家当前世界坐标 y。 */
  y: number;
}

/**
 * 服务端内部待过滤事件。
 *
 * `mapId/x/y` 是**事件产生时**的锚点快照；`targetEid` 仅 self 受众使用。
 */
export interface PendingClientEvent {
  seq: number;
  tick: number;
  type: string;
  data: Record<string, unknown>;
  audience: ClientEventAudience;
  /** self 受众的当事人 eid。 */
  targetEid?: EntityId;
  /** 锚点地图（nearby / map 用；world 可省略）。 */
  mapId?: string;
  /** 锚点世界坐标 x（nearby 用）。 */
  x?: number;
  /** 锚点世界坐标 y（nearby 用）。 */
  y?: number;
}

/** `emitClientEvent` 的可选上下文。 */
export interface EmitClientEventOptions {
  /** self 受众的当事人（必填，否则事件被丢弃——防止误发全服）。 */
  targetEid?: EntityId;
  /** 锚点实体：取其**当前**坐标/地图并固化到事件（推荐用于 nearby/map）。 */
  anchorEid?: EntityId;
  /** 显式锚点地图（anchorEid 缺省时使用）。 */
  mapId?: string;
  /** 显式锚点坐标 x（anchorEid 缺省时使用）。 */
  x?: number;
  /** 显式锚点坐标 y（anchorEid 缺省时使用）。 */
  y?: number;
}

/** nearby 受众缺省视野半径（像素）；GameSimulation 有 server 规则时优先规则值。 */
export const DEFAULT_CLIENT_EVENT_VIEW_RADIUS = 320;

/** world → 待过滤事件队列（传输层内部暂存，不污染 GameWorld 公共类型）。 */
const outboxes = new WeakMap<GameWorld, PendingClientEvent[]>();

/** world → 下一个可用 seq（per-world 全局单调）。 */
const seqCounters = new WeakMap<GameWorld, number>();

/** 取实体的 networkId；无 NetworkId 组件/非法值返回 undefined。 */
export function networkIdOf(world: GameWorld, eid: EntityId): number | undefined {
  if (!Number.isInteger(eid) || eid < 0) return undefined;
  if (!hasComponent(world, eid, NetworkId)) return undefined;
  const networkId = NetworkId.value[eid];
  return typeof networkId === "number" && networkId > 0 ? networkId : undefined;
}

/** 按事件 type 把表现配置里的 sfx/vfx id 并入 data（无映射返回原对象）。 */
function withPresentationIds(
  type: string,
  data: Record<string, unknown>,
): Record<string, unknown> {
  const sfx = audioIdsForEvent(type);
  const vfx = vfxIdsForEvent(type);
  if (sfx.length === 0 && vfx.length === 0) return data;

  const enriched: Record<string, unknown> = { ...data };
  // 调用方显式给的值优先（允许单个事件覆盖配置映射）
  if (sfx.length > 0 && !Object.hasOwn(enriched, "sfx")) enriched.sfx = sfx;
  if (vfx.length > 0 && !Object.hasOwn(enriched, "vfx")) enriched.vfx = vfx;
  return enriched;
}

/**
 * 入队一条客户端事件。
 *
 * @param world 游戏世界
 * @param type 事件类型
 * @param data 载荷（实体引用必须是 networkId）
 * @param audience 受众模型
 * @param options self 当事人 / 锚点（nearby、map 强烈建议传 anchorEid）
 * @returns 入队的事件；self 缺目标或锚点缺失导致无法安全过滤时返回 undefined
 */
export function emitClientEvent(
  world: GameWorld,
  type: string,
  data: Record<string, unknown>,
  audience: ClientEventAudience,
  options: EmitClientEventOptions = {},
): PendingClientEvent | undefined {
  // self 必须有当事人：宁可丢弃也不能误发全服（隐私优先）。
  if (audience === "self" && typeof options.targetEid !== "number") return undefined;

  const seq = (seqCounters.get(world) ?? 0) + 1;
  seqCounters.set(world, seq);

  const anchor = resolveAnchor(world, options);
  const event: PendingClientEvent = {
    seq,
    tick: world.time.tick,
    type,
    data: withPresentationIds(type, data),
    audience,
    ...(typeof options.targetEid === "number" ? { targetEid: options.targetEid } : {}),
    ...anchor,
  };

  let queue = outboxes.get(world);
  if (!queue) {
    queue = [];
    outboxes.set(world, queue);
  }
  queue.push(event);
  return event;
}

/** 解析并固化锚点（优先实体当前坐标，其次显式坐标/地图）。 */
function resolveAnchor(
  world: GameWorld,
  options: EmitClientEventOptions,
): { mapId?: string; x?: number; y?: number } {
  if (typeof options.anchorEid === "number" && hasComponent(world, options.anchorEid, Transform)) {
    return {
      mapId: entityMapOf(world, options.anchorEid),
      x: Transform.x[options.anchorEid],
      y: Transform.y[options.anchorEid],
    };
  }
  return {
    ...(typeof options.mapId === "string" ? { mapId: options.mapId } : {}),
    ...(typeof options.x === "number" && Number.isFinite(options.x) ? { x: options.x } : {}),
    ...(typeof options.y === "number" && Number.isFinite(options.y) ? { y: options.y } : {}),
  };
}

/**
 * 排空某世界的待过滤事件（每 tick 由 GameSimulation 调用一次）。
 *
 * 返回后 outbox 为空；seq 计数器保留（跨 tick 持续单调）。
 */
export function drainClientEventOutbox(world: GameWorld): PendingClientEvent[] {
  const queue = outboxes.get(world);
  if (!queue || queue.length === 0) return [];
  outboxes.set(world, []);
  return queue;
}

/**
 * 纯函数：按客户端视角过滤待发事件。
 *
 * 规则：
 * - world：恒可见；
 * - self：`targetEid === viewer.eid`；
 * - map：事件锚点地图 === 玩家当前地图（无地图信息时不发，避免误广播）；
 * - nearby：同图 + 锚点距离 ≤ viewRadius；锚点缺失时退化为同图（map 语义）。
 *
 * 输出保持输入顺序（seq 单调），data 做浅拷贝，避免调用方修改共享载荷。
 */
export function collectEventsForClient(
  events: readonly PendingClientEvent[],
  viewer: ClientEventViewer,
  viewRadius: number = DEFAULT_CLIENT_EVENT_VIEW_RADIUS,
): ClientEvent[] {
  const visible: ClientEvent[] = [];
  const radius = Number.isFinite(viewRadius) && viewRadius >= 0
    ? viewRadius
    : DEFAULT_CLIENT_EVENT_VIEW_RADIUS;
  const radiusSq = radius * radius;

  for (const event of events) {
    if (!isEventVisibleTo(event, viewer, radiusSq)) continue;
    visible.push({
      seq: event.seq,
      tick: event.tick,
      type: event.type,
      data: { ...event.data },
    });
  }
  return visible;
}

/** 单事件可见性判定（collectEventsForClient 的内部纯函数）。 */
function isEventVisibleTo(
  event: PendingClientEvent,
  viewer: ClientEventViewer,
  radiusSq: number,
): boolean {
  switch (event.audience) {
    case "world":
      return true;
    case "self":
      return event.targetEid === viewer.eid;
    case "map":
      return event.mapId !== undefined && event.mapId === viewer.mapId;
    case "nearby": {
      if (event.mapId === undefined || event.mapId !== viewer.mapId) return false;
      // 锚点坐标缺失时无法做距离判定：退化为同图（保守但不跨图泄漏）。
      if (event.x === undefined || event.y === undefined) return true;
      const dx = event.x - viewer.x;
      const dy = event.y - viewer.y;
      return dx * dx + dy * dy <= radiusSq;
    }
    default:
      return false;
  }
}
