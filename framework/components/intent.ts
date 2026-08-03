/**
 * Intent 组件：玩家交互意图（AoS 结构）。
 *
 * 由 GameSimulation.applyInputs 把输入里的 interact 信号写入 `Intent[eid]`，
 * interactionSystem 消费并清空。
 *
 * S1 值仅为字符串 `"interact"`；后续切片若有更多意图类型再扩为带 payload 的
 * 结构（即需即补，不提前造枚举）。游戏无关。
 */
export const Intent = [] as (string | null | undefined)[];