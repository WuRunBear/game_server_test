/**
 * 族群节点模块导出面（framework/simulation/population）。
 *
 * 组件 + 配置解析（population.ts）+ tick 系统 / 离线快进 / 最小生产通路
 * （populationSystem.ts）。游戏无关——物种 kind / 区域名 / 参数全部来自配置。
 */
export {
  Population,
  initPopulation,
  regionAreaOf,
  growthForSlot,
  resolveHomeRegion,
  resolveSourceKind,
  populationSourceId,
  populationGeometryOf,
  type PopulationNodeState,
} from "framework/simulation/population/population";

export {
  populationSystem,
  createPopulationSystem,
  advancePopulation,
  fastForwardPopulations,
  materializePopulation,
  populationSpawnBudget,
  populationSnapshot,
  type MaterializeOptions,
} from "framework/simulation/population/populationSystem";
