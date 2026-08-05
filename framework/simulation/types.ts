/**
 * 仿真模块的纯数据类型（DTO）。
 *
 * 这些类型是仿真层（SimulationPort 实现）与传输层（GameRoom / HeadlessHost）
 * 之间的数据协议。它们不包含任何 bitecs 或 ECS 类型，传输层可以完全不知道
 * ECS 的存在就能消费这些数据。
 *
 * 简单来说，这些就是"仿真出了什么数据、传输层需要什么数据"的合同。
 */

import type { Repository, WorldRecord } from "framework/repository";

/**
 * 客户端发给服务端的输入命令。
 *
 * 约定：
 * - seq 是一个自增序号，每发一条消息 +1，用于服务端去重和丢弃乱序包
 * - moveX / moveY 是方向/速度值，具体含义由仿真层的输入建模决定
 *   （当前实现直接写入 Velocity 组件，未来可能改为加速度或意图组件）
 */
export interface PlayerInput {
  /** 消息序号，用于去重；后一条的 seq 必须 > 前一条 */
  seq: number;
  /** 水平移动分量 */
  moveX: number;
  /** 垂直移动分量 */
  moveY: number;
  /**
   * 交互意图信号：本帧玩家按下交互键（采集等）。
   * 由 interactionSystem 在该 tick 内消费并清空。
   */
  interact?: boolean;
  /**
   * 攻击意图信号：本帧玩家按下攻击键（近战等）。
   * 由 interactionSystem 在该 tick 内消费并清空（与 interact 同槽互斥）。
   */
  attack?: boolean;
}

/**
 * 玩家命令——非逐帧的离散操作（背包原子：食用/丢弃/移动槽/合成/穿戴/放置）。
 *
 * 与 PlayerInput（脉冲式逐帧移动）区别：命令是即刻执行的服务端权威动作，
 * 不进入 seq 去重 / 帧缓存。type 保持框架通用机制词（consume/drop/transfer/
 * craft/equip/place），不含游戏语义。
 */
export interface PlayerCommand {
  type: "consume" | "drop" | "transfer" | "craft" | "equip" | "place";
  /** 目标槽索引（consume/drop/equip/place 用）；transfer 的源槽。 */
  slot?: number;
  /** transfer 目标槽。 */
  toSlot?: number;
  /** 合成配方 id（craft 用，引用 rules/crafting.json 的 recipes[].id）。 */
  recipe?: string;
  /** 放置目标坐标（place 用，世界坐标，服务端校验距离/重叠/阻挡）。 */
  x?: number;
  /** 放置目标坐标（place 用，世界坐标）。 */
  y?: number;
}

/**
 * 玩家加入成功时的返回信息。
 *
 * 只返回 networkId 是因为传输层需要的唯一信息就是"这个新玩家对应哪个实体"，
 * 其余数据（坐标、血量等）会在下一帧快照中自动同步。
 */
export interface PlayerJoinResult {
  /** 玩家实体的网络标识（不等于 ECS 内部的 eid，是稳定对外 ID） */
  networkId: number;
}

/**
 * 单实体快照——一个实体在某一帧的全部同步字段。
 *
 * 拆成数值 / 字符串两套 map：对应 Colyseus EntityState 的 values / stringValues。
 * 字段 key 格式 "ComponentName.field"（如 "Transform.x"）或 AoS 展开形态
 * "Component.index.field"（如 "Needs.0.current"、"Inventory.0.kind"）。
 */
export interface EntitySnapshot {
  /** 数值字段。 */
  values: Record<string, number>;
  /** 字符串字段（AoS 适配器展平出的 kind / need 名等）。 */
  strings: Record<string, string>;
}

/**
 * 单帧快照——仿真层产出的纯数据，传输层用它来更新客户端状态。
 *
 * 核心思路：
 * - entities 中只包含"还活着的实体"。传输层拿到后做 diff：
 *   快照里有但 RoomState 没有 → 新实体，创建 EntityState
 *   快照里没有但 RoomState 有 → 实体已死亡，从 RoomState 删除
 *   两边都有 → 更新字段值（含按 key diff 清理已消失的字段）
 * - 字段 key 格式为 "ComponentName.fieldName"（如 "Transform.x"），
 *   由 game.json 的 netSync 配置驱动，无硬编码。
 */
export interface TickSnapshot {
  /** 当前逻辑帧号（从 1 开始递增） */
  tick: number;
  /**
   * 存活实体快照。
   * - key: networkId（NetworkId 组件的值，稳定标识）
   * - value: 实体快照（数值字段 + 字符串字段）
   */
  entities: Map<number, EntitySnapshot>;
  /**
   * world 级昼夜状态（dayNightCycleSystem 推进）。
   * 传输层可选消费（RoomState 的 hour/phase 字段）；无配置时为 undefined。
   */
  timeOfDay?: { hour: number; phase: number };
}

/**
 * tick() 方法的返回值——包含了快照数据和性能指标。
 *
 * 传输层拿到这个后：
 * 1. 用 snapshot 更新客户端状态（写入 Colyseus RoomState）
 * 2. 忽略 tickMs / avgTickMs（如有需要也可用于监控上报）
 */
export interface TickResult {
  /** 本帧实体快照 */
  snapshot: TickSnapshot;
  /** 本帧执行耗时（毫秒），从 performance.now() 差值计算 */
  tickMs: number;
  /** 当前帧号 */
  tick: number;
  /** EMA 滑动平均帧耗时（毫秒），用于性能监控趋势判断 */
  avgTickMs: number;
  /**
   * 兴趣集合（可选）：sessionId → 该玩家本帧可见的 networkId 列表。
   *
   * 由仿真层按视野半径裁剪（own entity 恒可见）；传输层据此做 per-client 同步。
   * 未配置视野半径时缺省——传输层回退全量广播（兼容旧协议）。
   */
  interest?: Map<string, number[]>;
}

/**
 * 创建仿真实例的注入选项（可选，全缺省时行为与历史版本一致）。
 */
export interface SimulationOptions {
  /** 持久化仓储；缺省不接存档。 */
  repository?: Repository;
  /** 存档标识；配合 repository 用于定时存档与读档。 */
  saveId?: string;
  /** 启动时恢复的世界快照（读档结果）；恢复出的玩家实体供 addPlayer 复用绑定。 */
  initialRecord?: WorldRecord;
}

/**
 * 调试快照的获取选项。
 *
 * includeMapBodies 控制是否包含地图碰撞体信息。
 * 地图碰撞体每帧不变，客户端通常只需要首次拉取，
 * 后续每帧只拉实体碰撞体以节省带宽。
 */
export interface DebugSnapshotOptions {
  /** 是否包含地图静态碰撞体（首次订阅时为 true，后续推送为 false） */
  includeMapBodies?: boolean;
}
