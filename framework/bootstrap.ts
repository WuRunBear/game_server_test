import { createComponentRegistry } from "framework/components/componentRegistry";
import { registerBuiltinComponents } from "framework/components/registerBuiltin";
import { createSystemRegistry } from "framework/systems/systemRegistry";
import { createActionRegistry } from "framework/ai/actionRegistry";
import { registerBuiltinSystems } from "framework/systems/registerBuiltinSystems";
import { createArchetypeRegistry } from "framework/entities/archetypeRegistry";
import { registerBuiltinArchetypes } from "framework/entities/registerBuiltinArchetypes";

export interface FrameworkRegistries {
  componentRegistry: ReturnType<typeof createComponentRegistry>;
  systemRegistry: ReturnType<typeof createSystemRegistry>;
  actionRegistry: ReturnType<typeof createActionRegistry>;
  archetypeRegistry: ReturnType<typeof createArchetypeRegistry>;
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

  registries = { componentRegistry, systemRegistry, actionRegistry, archetypeRegistry };
  return registries;
}

export function getRegistries(): FrameworkRegistries {
  if (!registries) {
    throw new Error("Framework not bootstrapped. Call bootstrapFramework() first.");
  }
  return registries;
}
