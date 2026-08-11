/**
 * 框架级默认运行参数（framework/config/game.ts）。
 *
 * 与 game/game.json（游戏内容定义）不同，本文件是框架层的小型运行时常量：
 * 当没有外部配置覆盖时提供默认值。游戏无关。
 */
export interface GameConfig {
  /** 逻辑 tick 频率（次/秒）：决定仿真层 step(dtMs) 每次推进的时间片大小。 */
  tickRate: number;
}

/** 默认游戏运行参数（tickRate = 20，即每 tick 推进 50ms）。 */
export const gameConfig: GameConfig = {
  tickRate: 20,
};
