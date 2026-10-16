/**
 * 种群模型注册表（framework/map/evolution/populationModels.ts）。
 *
 * 把补差引擎的「每槽应产出多少」决策抽成可注册的**种群模型**：一条
 * EntityRule 的 mode 即模型注册名，引擎在每个 timeSlot 向模型查询本槽的
 * **目标数量**，再向目标补差（deficit = target − 区域内存活实体数，下限 0）
 * ——引擎恒只增不删，目标回落（节点记账下降）不删活体，死亡归 deathSystem。
 *
 * 引擎统一以 rule.max 封顶目标（target = min(model(...), rule.max)）：
 * 内置 density/exact/template 模型返回 rule.max 本身（与历史行为逐点一致，
 * 零回归）；node 模型返回族群节点记账和（见 nodePopulationModel.ts）。
 *
 * 注册表是简单 Map（与 api.ts 的 ruleModules 同一模式）：register 同名抛错、
 * get 未注册抛错（配置错误尽早暴露）。规则 schema（EntityRuleSchema）目前
 * 闭合于四种内置 mode；自定义模型注册后须经 schema 扩展联合才能被配置引用
 * （引擎侧决策点已可插拔，schema 开放留给真实需求牵引）。
 *
 * 内置模型在**模块加载时**注册（registerBuiltinPopulationModels 幂等）：
 * 演化引擎与既有测试不依赖 bootstrap 时序——bootstrapFramework 里的调用
 * 只是显式声明接线点，重复调用被幂等守卫吸收。
 */
import type { GameWorld } from "framework/world";
import type { MapGeometry } from "map/geometry/types";
import type { EntityRule } from "map/evolution/schema";
import { nodePopulationModel } from "map/evolution/nodePopulationModel";

/** 种群模型上下文（单槽决策输入；单次 evolve 调用内 world/geometry/seed 不变）。 */
export interface PopulationModelContext {
  /** 目标世界（模型按需读取组件/AoS 状态；引擎不做任何直接组件查询）。 */
  world: GameWorld;
  /** 当前图几何（mapKey = geometry.key）。 */
  geometry: MapGeometry;
  /** 本条规则（region/kind/max 等由模型自行解读）。 */
  rule: EntityRule;
  /** 区域内该 kind 存活实体数（已反映本调用此前的 spawn 产出）。 */
  count: number;
  /** 本槽绝对时刻（timeSlot，k×every 绝对对齐）。 */
  slot: number;
  /** 选点/演化流种子（地图 seed 经 deps 注入）。 */
  seed: number;
}

/**
 * 种群模型：返回本槽该规则的**目标数量**（引擎向目标补差，只增不删）。
 * 返回值会被引擎以 rule.max 封顶；模型无需自行处理 max。
 */
export type PopulationModel = (ctx: PopulationModelContext) => number;

/** 种群模型注册表（mode 名 → 模型）。 */
const populationModels = new Map<string, PopulationModel>();

/**
 * 注册一个种群模型。EntityRule 的 mode 按名引用，引擎每槽经
 * getPopulationModel 取用；同名重复注册抛错（防内置模型被意外覆盖）。
 */
export function registerPopulationModel(name: string, model: PopulationModel): void {
  if (populationModels.has(name)) {
    throw new Error(`Population model "${name}" is already registered`);
  }
  populationModels.set(name, model);
}

/** 按 mode 名取种群模型；未注册抛错（配置引用错误在首槽前暴露）。 */
export function getPopulationModel(name: string): PopulationModel {
  const model = populationModels.get(name);
  if (!model) {
    throw new Error(`Population model "${name}" is not registered`);
  }
  return model;
}

/** 列出全部已注册种群模型名（供 list-registries 等检查/调试）。 */
export function listPopulationModels(): string[] {
  return [...populationModels.keys()];
}

/** 内置 density/exact/template：目标恒 = rule.max（历史行为，逐点保持）。 */
const staticMaxModel: PopulationModel = (ctx) => ctx.rule.max;

/**
 * 注册全部内置种群模型（"density" / "exact" / "template" / "node"）。
 * 幂等：模块加载时自动调用一次，bootstrapFramework 的显式调用被守卫吸收。
 */
export function registerBuiltinPopulationModels(): void {
  if (populationModels.has("density")) return;
  populationModels.set("density", staticMaxModel);
  populationModels.set("exact", staticMaxModel);
  populationModels.set("template", staticMaxModel);
  // node 模型单独成文件：它读取族群节点 AoS 状态并按槽推进（依赖
  // simulation/population），与纯静态的内置三模型隔离。
  populationModels.set("node", nodePopulationModel);
}

// 模块加载即注册：演化引擎与既有测试不依赖 bootstrap 时序（零回归保障）。
registerBuiltinPopulationModels();
