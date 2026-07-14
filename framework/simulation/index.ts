/**
 * simulation 模块——仿真端口定义和实现。
 *
 * 本模块是传输层和 ECS 之间的隔层：
 * - types.ts        → 纯数据 DTO（传输层和仿真层共享的类型）
 * - SimulationPort  → 接口（传输层只依赖这个接口，不依赖任何 ECS 实现）
 * - GameSimulation  → 具体实现（封装 GameInstance + 所有 ECS 操作）
 *
 * 外部代码应该通过 SimulationPort 接口使用仿真，不应直接依赖 GameSimulation。
 */
export type {
  PlayerInput, PlayerJoinResult, TickSnapshot, TickResult, DebugSnapshotOptions,
} from "./types";

export type { SimulationPort } from "./SimulationPort";

export { createGameSimulation, GameSimulation } from "./GameSimulation";
