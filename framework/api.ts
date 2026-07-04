import { getRegistries } from "framework/bootstrap";
import type { ComponentRegistry } from "framework/components/componentRegistry";
import type { SystemRegistry, SystemSpec } from "framework/systems/systemRegistry";
import type { ActionRegistry, ActionFactory } from "framework/ai/actionRegistry";
import type { ArchetypeRegistry, ArchetypeSpec } from "framework/entities/archetypeRegistry";
import type { GeneratorRegistry, MapGenerator } from "framework/map/generatorRegistry";
import type { GameDefinition } from "framework/config/schema/GameDefinitionSchema";
import { GameDefinitionSchema } from "framework/config/schema/GameDefinitionSchema";

export function registerSystem(spec: SystemSpec): void {
  getRegistries().systemRegistry.register(spec);
}

export function registerComponent(name: string, component: unknown): void {
  getRegistries().componentRegistry.register(name, component);
}

export function registerArchetype(spec: ArchetypeSpec): void {
  getRegistries().archetypeRegistry.register(spec);
}

export function registerAction(name: string, factory: ActionFactory): void {
  getRegistries().actionRegistry.register(name, factory);
}

export function registerGenerator(id: string, gen: MapGenerator): void {
  getRegistries().generatorRegistry.register(id, gen);
}

export type RuleModule = (world: unknown, ...args: unknown[]) => unknown;

const ruleModules = new Map<string, RuleModule>();

export function registerRuleModule(id: string, module: RuleModule): void {
  if (ruleModules.has(id)) {
    throw new Error(`Rule module "${id}" is already registered`);
  }
  ruleModules.set(id, module);
}

export function getRuleModule(id: string): RuleModule {
  const mod = ruleModules.get(id);
  if (!mod) {
    throw new Error(`Rule module "${id}" is not registered`);
  }
  return mod;
}

export function listRegisteredSystems(): SystemSpec[] {
  return getRegistries().systemRegistry.all();
}

export function listRegisteredArchetypes(): ArchetypeSpec[] {
  return getRegistries().archetypeRegistry.all();
}

export function listRegisteredActions(): ActionFactory[] {
  return getRegistries().actionRegistry.all();
}

export function validateGameDefinition(gameDef: unknown): gameDef is GameDefinition {
  return GameDefinitionSchema.safeParse(gameDef).success;
}

export { buildMapRuntime } from "framework/map/buildRuntime";
export { exportGeneratedMapArtifacts as exportMapRuntime } from "framework/map/exportGenerated";
