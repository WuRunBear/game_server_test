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

export interface FrameworkRegistries {
  componentRegistry: ReturnType<typeof createComponentRegistry>;
  systemRegistry: ReturnType<typeof createSystemRegistry>;
  actionRegistry: ReturnType<typeof createActionRegistry>;
  archetypeRegistry: ReturnType<typeof createArchetypeRegistry>;
  generatorRegistry: ReturnType<typeof createGeneratorRegistry>;
}

let registries: FrameworkRegistries | undefined;

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

export function getRegistries(): FrameworkRegistries {
  if (!registries) {
    throw new Error("Framework not bootstrapped. Call bootstrapFramework() first.");
  }
  return registries;
}
