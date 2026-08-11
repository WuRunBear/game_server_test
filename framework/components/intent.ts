/**
 * Intent 组件：玩家交互意图（AoS 结构）。
 *
 * 由 GameSimulation.applyInputs 把输入里的 interact / attack 信号写入
 * `Intent[eid]`，interactionSystem 消费并清空。单槽位语义：同帧至多一个意图
 * （后写覆盖，无堆积）。
 *
 * 值域：`"interact"`（采集）/ `"attack"`（攻击）；后续切片若有更多意图类型
 * 再扩为带 payload 的结构（即需即补，不提前造枚举）。游戏无关。
 */
/** AoS 存储：普通 JS 数组按 eid 索引（非 bitecs 组件，不能 addComponent/query）。 */
export const Intent = [] as (string | null | undefined)[];