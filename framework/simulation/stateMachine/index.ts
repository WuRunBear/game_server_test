/**
 * 通用状态机模块导出面（framework/simulation/stateMachine）。
 *
 * 组件 + 配置编译（stateMachine.ts）+ tick 系统 / 即时信号 / 离线快进
 * （stateMachineSystem.ts）。游戏无关——状态/信号/条件 id 全部来自配置。
 */
export {
  StateMachine,
  FSM_SIGNAL_HARVESTED,
  FSM_SIGNAL_DEPLETED,
  compileStateMachine,
  initStateMachine,
  attachStateMachine,
  stateMachineDefOf,
  type StateMachineState,
  type CompiledStateMachine,
  type CompiledState,
  type CompiledTransition,
  type TransitionKind,
} from "framework/simulation/stateMachine/stateMachine";

export {
  stateMachineSystem,
  advanceStateMachine,
  signalStateMachine,
  fastForwardStateMachines,
} from "framework/simulation/stateMachine/stateMachineSystem";
