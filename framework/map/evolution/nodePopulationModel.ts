/**
 * node 种群模型（framework/map/evolution/nodePopulationModel.ts）。
 *
 * 规则声明 mode: "node" 后，其每槽目标数量 = **该图该区域该 species 的
 * Population 族群节点 count 之和**（引擎再以 rule.max 封顶）——实体生产由
 * 族群节点记账驱动（巢穴/兽群增长 → 引擎向目标补差），取代静态 density
 * 的「补到 max」。匹配条件（三者同时成立才计入）：
 * - 节点 species === rule.kind（节点产出的物种 = 规则计数的 kind）；
 * - 节点归属图 = 规则图（来源实体 EntityMap === geometry.key）；
 * - 节点归属区域 = rule.region（homeRegion，空串时按来源实体所在 tile
 *   惰性解析——与族群系统同一语义）。
 *
 * ## 槽推进（离线 ≡ 逐 tick 的根基）
 *
 * 引擎不推进节点数值时，离线单次 evolve 会用**存档时刻的陈旧记账**补差
 * 整个跨度，与在线逐 tick 的渐进增长不一致。因此模型对每个匹配节点先调
 * advancePopulation(world, eid, slot) 把节点**确定性推进到本槽**再取 count：
 * - advancePopulation 是 (tick, 节点状态, seed, 区域数据) 的纯迁移步进，
 *   幂等且可结合（population 模块文档化断言）——引擎推进只是把快进提前，
 *   populationSystem / fastForwardPopulations 的后续推进自然衔接，节点最终
 *   状态与不推进时完全一致；
 * - 逐 tick 路径：tick T 的引擎先于系统推进节点到槽 T（若对齐），随后的
 *   populationSystem 推进为幂等空操作；
 * - 离线路径：单次 evolve 内逐槽推进（槽序升序），fastForwardPopulations
 *   收尾补到演化边界——与逐 tick 的每槽可见状态逐一相同。
 *
 * 槽对齐、(from,to] 区间、确定性选点等引擎不变式不受影响：模型只读节点
 * 记账并做幂等推进，绝不删减实体或节点（节点随来源实体存亡，捣毁巢穴 =
 * 节点消失 = 目标回落，引擎 deficit ≤ 0 时空转，绝不下删）。
 */
import { entityMapOf } from "framework/components";
import {
  Population,
  resolveHomeRegion,
} from "framework/simulation/population/population";
import { advancePopulation } from "framework/simulation/population/populationSystem";
import type { PopulationModelContext } from "map/evolution/populationModels";

/**
 * node 模型：汇总匹配节点的记账 count（先把每个匹配节点确定性推进到本槽）。
 * 无匹配节点（图/区域/物种无巢）→ 目标 0（零产出，不抛错）。
 */
export function nodePopulationModel(ctx: PopulationModelContext): number {
  const { world, geometry, rule, slot } = ctx;
  const mapKey = geometry.key;
  let total = 0;
  for (let eid = 0; eid < Population.length; eid++) {
    const node = Population[eid];
    if (!node || node.species !== rule.kind) continue;
    if (entityMapOf(world, eid) !== mapKey) continue;
    if (resolveHomeRegion(world, eid, geometry) !== rule.region) continue;
    // 确定性槽推进（幂等可结合）：把节点记账带到本槽时刻再读 count——
    // 离线补差与逐 tick 推进在本槽看到同一记账值（见文件头）。
    advancePopulation(world, eid, slot);
    total += node.count;
  }
  return total;
}
