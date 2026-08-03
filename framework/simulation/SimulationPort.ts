import type {
  PlayerInput, PlayerJoinResult, TickResult, DebugSnapshotOptions, PlayerCommand,
} from "./types";

/**
 * 仿真端口——传输层与仿真层之间的双向协议（接口）。
 *
 * ## 为什么需要这个接口？
 *
 * 重构前，GameRoom 直接 import bitecs、直接读 SoA 数组、直接调 spawnEntity——
 * 传输层和仿真层深度耦合，换 ECS 或换传输都得改 GameRoom。
 *
 * SimulationPort 把仿真操作抽象成一组合约接口：
 * - 传输层（GameRoom / HeadlessHost）只通过这个接口驱动仿真
 * - 传输层不知道 ECS 的存在，不 import 任何 bitecs 符号
 * - 仿真层（GameSimulation）实现这个接口，内部随便用什么技术
 *
 * ## 方法分为两类
 *
 * **驱动类**（每帧调用）：
 * - tick()          → 推进仿真
 * - submitInput()   → 提交玩家输入（tick 时消费）
 * - getDebugSnapshot() → 获取调试数据
 *
 * **生命周期类**（事件触发）：
 * - addPlayer()     → 玩家连入
 * - removePlayer()  → 玩家断开
 */
export interface SimulationPort {
  /**
   * 推进一个逻辑帧。
   *
   * 内部执行顺序：应用玩家输入 → 运行 ECS 系统 → 构建快照 → 记录性能指标。
   * 返回 TickResult，包含快照和耗时数据。
   *
   * @param dtMs 本帧的时间步长（毫秒）。通常等于 1000 / tickRate
   * @returns 本帧结果（快照 + 性能指标）
   */
  tick(dtMs: number): TickResult;

  /**
   * 玩家加入时调用。
   *
   * 内部创建玩家实体（spawn "player" archetype）、分配 NetworkId，
   * 并建立 sessionId → eid 的映射，后续 submitInput 通过 sessionId 找到正确实体。
   *
   * @param sessionId Colyseus 连接标识
   * @returns 玩家实体的 networkId，传输层写入 PlayerState.entityId
   */
  addPlayer(sessionId: string): PlayerJoinResult;

  /**
   * 玩家离开时调用。
   *
   * 内部删除玩家实体、清理所有与该 sessionId 关联的缓存
   * （输入缓存、seq 去重缓存、eid 映射）。
   *
   * @param sessionId Colyseus 连接标识
   */
  removePlayer(sessionId: string): void;

  /**
   * 提交一条客户端输入。
   *
   * 输入不会立即生效，而是缓存起来，在下一次 tick() 时统一应用。
   * 内部做了 seq 去重：只有 seq > 已记录的最新 seq 的消息才会被接受。
   *
   * @param sessionId Colyseus 连接标识
   * @param input 输入数据
   */
  submitInput(sessionId: string, input: PlayerInput): void;

  /**
   * 提交一条玩家命令（离散动作，非逐帧）。
   *
   * 立即执行服务端权威变更（如背包原子），不入帧缓存、不做 seq 去重。
   * 返回是否成功执行；未知命令类型返回 false。
   *
   * @param sessionId Colyseus 连接标识
   * @param command 命令数据
   */
  submitCommand(sessionId: string, command: PlayerCommand): boolean;

  /**
   * 获取当前帧的碰撞调试快照。
   *
   * 返回类型是 unknown，因为传输层不需要理解快照结构——
   * 它只是把数据原样转发给客户端。
   *
   * @param options 控制是否包含地图碰撞体等
   * @returns 可序列化的调试数据
   */
  getDebugSnapshot(options?: DebugSnapshotOptions): unknown;
}
