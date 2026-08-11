/**
 * 框架引导（游戏无关）：创建全部内置注册表并注册内置实现。
 *
 * 幂等单例：首次调用完成初始化并缓存结果，之后重复调用直接返回同一实例。
 * 必须在任何 register 系列 / list 系列 API 与 createGameInstance 之前调用。
 */
import { createComponentRegistry } from "framework/components/componentRegistry";
import { registerBuiltinComponents } from "framework/components/registerBuiltin";
import { createSystemRegistry } from "framework/systems/systemRegistry";
import { createActionRegistry } from "framework/ai/actionRegistry";
import { registerBuiltinSystems } from "framework/systems/registerBuiltinSystems";
import { createArchetypeRegistry } from "framework/entities/archetypeRegistry";
import { registerBuiltinArchetypes } from "framework/entities/registerBuiltinArchetypes";
import { createGeneratorRegistry } from "framework/map/generatorRegistry";
import { registerBuiltinGenerators } from "framework/map/registerBuiltinGenerators";
import { registerBuiltinRuleSchemas } from "framework/config/schema/ruleSchemas";
import { registerBuiltinSpawnConditions } from "framework/systems/gameplay/spawnConditions";

/** 五大注册表的聚合容器（组件/系统/动作/原型/生成器）。 */
export interface FrameworkRegistries {
  componentRegistry: ReturnType<typeof createComponentRegistry>;
  systemRegistry: ReturnType<typeof createSystemRegistry>;
  actionRegistry: ReturnType<typeof createActionRegistry>;
  archetypeRegistry: ReturnType<typeof createArchetypeRegistry>;
  generatorRegistry: ReturnType<typeof createGeneratorRegistry>;
}

/** 全局单例缓存：bootstrapFramework 首次调用后填充。 */
let registries: FrameworkRegistries | undefined;

/**
 * 初始化框架注册表（幂等）：建表 → 注册全部内置实现 → 缓存返回。
 * 游戏自定义扩展（src/register.ts）在其后追加注册。
 *
 * @returns 五大注册表聚合对象
 */
export function bootstrapFramework(): FrameworkRegistries {
  if (registries) return registries;

  const componentRegistry = createComponentRegistry();
  registerBuiltinComponents(componentRegistry);

  const actionRegistry = createActionRegistry();

  const systemRegistry = createSystemRegistry();
  registerBuiltinSystems(systemRegistry, actionRegistry);

  const archetypeRegistry = createArchetypeRegistry();
  registerBuiltinArchetypes(archetypeRegistry);

  const generatorRegistry = createGeneratorRegistry();
  registerBuiltinGenerators(generatorRegistry);

  registerBuiltinRuleSchemas();
  registerBuiltinSpawnConditions();

  registries = { componentRegistry, systemRegistry, actionRegistry, archetypeRegistry, generatorRegistry };
  return registries;
}

/**
 * 取已初始化的注册表；未引导时抛错（防止在 bootstrapFramework 之前使用注册表）。
 */
export function getRegistries(): FrameworkRegistries {
  if (!registries) {
    throw new Error("Framework not bootstrapped. Call bootstrapFramework() first.");
  }
  return registries;
}
