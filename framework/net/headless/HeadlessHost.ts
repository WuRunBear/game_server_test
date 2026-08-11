/**
 * 无头（headless）仿真驱动：不开网络、不连客户端，仅以固定步长
 * 在本地 for 循环中驱动仿真。与 GameRoom 同为 SimulationPort 的
 * 消费者——两者 tick 内部行为一致（都调 sim.tick(dtMs)），
 * 只是"如何驱动"不同。典型用途：单元测试、离线基准测试。
 */
import type { SimulationPort } from "simulation/SimulationPort";
import type { TickResult } from "simulation/types";

/**
 * runHeadless 的参数选项。
 *
 * Headless 的意思是"无头"——没有网络、没有客户端连接，
 * 纯粹以固定步长驱动仿真。主要用于：
 * - 单元测试（验证系统行为）
 * - 服务端离线模拟（基准测试、AI 训练等）
 */
export interface HeadlessHostOptions {
  /**
   * 要运行的 tick 次数。
   *
   * 默认 1 次。
   */
  tickCount?: number;

  /**
   * 每帧的时间步长（毫秒）。
   *
   * 默认 50ms（对应 20 tick/s）。
   * 理论值应该等于 1000 / tickRate，但对于只做逻辑验证的测试，
   * 步长值不影响结果（系统逻辑不依赖时间精度时）。
   */
  dtMs?: number;

  /**
   * 每帧完成后的回调。
   *
   * 参数从之前的 `(tick: number)` 升级为 `(result: TickResult)`，
   * 回调可以同时拿到帧号、耗时、快照数据等所有信息。
   */
  onTick?: (result: TickResult) => void;
}

/**
 * 以 headless（无网络）模式驱动仿真。
 *
 * ## 与 GameRoom 的关系
 *
 * GameRoom 和 HeadlessHost 是 SimulationPort 的两种消费者：
 * - GameRoom：Colyseus 驱动 → 每 tick 通过 WebSocket 推送快照给客户端
 * - HeadlessHost：本进程 for 循环驱动 → 返回 TickResult[] 供分析
 *
 * 两者"如何驱动 tick"不同，但"tick 内部做了什么"完全一样——
 * 都调用 sim.tick(dtMs)，都拿到 TickResult。
 *
 * ## 使用示例
 *
 * ```typescript
 * const sim = createGameSimulation(gameDef);
 * const results = runHeadless(sim, { tickCount: 5 });
 * console.log("第5帧耗时:", results[4].tickMs);
 * ```
 *
 * @param sim 仿真端口实例
 * @param options 运行选项
 * @returns 每帧的 TickResult 数组（长度为 tickCount）
 */
export function runHeadless(
  sim: SimulationPort,
  options?: HeadlessHostOptions,
): TickResult[] {
  const maxTicks = options?.tickCount ?? 1;
  const dtMs = options?.dtMs ?? 50;
  const onTick = options?.onTick;
  const results: TickResult[] = [];

  for (let i = 0; i < maxTicks; i++) {
    const result = sim.tick(dtMs);
    results.push(result);
    onTick?.(result);
  }

  return results;
}
