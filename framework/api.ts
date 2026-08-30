/**
 * 框架公共 API 门面（游戏无关）。
 *
 * 把各注册表的 register/get/list 能力收拢为顶层函数，供游戏代码
 * （src/register.ts）与工具代码（tools/）调用。每个 register 函数
 * 对应的「配置引用位置」以注释标明——配置驱动、注册表执行：
 *
 * - registerSystem     → game.json 的 systems[].id
 * - registerComponent  → entities/*.json 的 components 块（组件名）
 * - registerArchetype  → entities/*.json 的 kind（spawns/放置/恢复按 kind 引用）
 * - registerAction     → behaviors/*.json 的 action.name / condition.call
 * - registerGenerator  → maps/registry.json 的 generatorId
 * - registerRuleModule → rules/*.json 的 xxxRef 字段
 *
 * 注意：bootstrapFramework() 必须先于这些函数调用（getRegistries 依赖其完成）。
 */
import { getRegistries } from "framework/bootstrap";
import type { ComponentRegistry } from "framework/components/componentRegistry";
import type { SystemRegistry, SystemSpec } from "framework/systems/systemRegistry";
import type { ActionRegistry, ActionFactory, ActionEntry } from "framework/ai/actionRegistry";
import type { ArchetypeRegistry, ArchetypeSpec } from "framework/entities/archetypeRegistry";
import type { GeneratorRegistry, MapGenerator, GeneratorEntry } from "framework/map/generatorRegistry";
import type { GeneratorEntry as MapBlockEntry } from "map/generate/generatorRegistry";
import type { GameDefinition } from "framework/config/schema/GameDefinitionSchema";
import { GameDefinitionSchema } from "framework/config/schema/GameDefinitionSchema";

/**
 * 注册一个系统。game.json 的 `systems[].id` 引用该 id 决定是否启用及执行顺序
 * （after/before 声明依赖）。替换内置系统：注册同名替代并在 game.json 停用旧系统。
 */
export function registerSystem(spec: SystemSpec): void {
  getRegistries().systemRegistry.register(spec);
}

/**
 * 注册一个组件。entities/*.json 的 components 块按组件名引用；
 * 组件实现由框架或扩展方提供（SoA 数值数组或 AoS 普通数组）。
 */
export function registerComponent(name: string, component: unknown): void {
  getRegistries().componentRegistry.register(name, component);
}

/**
 * 注册一个实体原型（archetype）。entities/*.json 按 kind 声明，
 * 刷怪/放置/存档恢复等按 kind 查找原型来实例化实体。
 */
export function registerArchetype(spec: ArchetypeSpec): void {
  getRegistries().archetypeRegistry.register(spec);
}

/**
 * 注册一个行为树动作/条件工厂。behaviors/*.json 中 `action.name`、
 * `condition.call` 按此注册名查找（行为树由 btFactory 据此绑定到 agent）。
 */
export function registerAction(name: string, factory: ActionFactory): void {
  getRegistries().actionRegistry.register(name, factory);
}

/**
 * 注册一个地图生成器。maps/registry.json 的 `generatorId` 引用其 id，
 * 加载/生成地图时按 id 调用。
 */
export function registerGenerator(id: string, gen: MapGenerator): void {
  getRegistries().generatorRegistry.register(id, gen);
}

/** 规则模块签名：以 world 为参数的计算/判定函数（游戏无关约束）。 */
export type RuleModule = (world: unknown, ...args: unknown[]) => unknown;

/** 规则模块注册表（独立于五大注册表的简单 Map，id → 模块）。 */
const ruleModules = new Map<string, RuleModule>();

/**
 * 注册一个规则模块。rules/*.json 的 xxxRef 字段按 id 引用，
 * 由各规则系统在求值/应用时通过 getRuleModule 取用。
 */
export function registerRuleModule(id: string, module: RuleModule): void {
  if (ruleModules.has(id)) {
    throw new Error(`Rule module "${id}" is already registered`);
  }
  ruleModules.set(id, module);
}

/** 按 id 取规则模块；未注册抛错（配置引用错误会在运行期暴露）。 */
export function getRuleModule(id: string): RuleModule {
  const mod = ruleModules.get(id);
  if (!mod) {
    throw new Error(`Rule module "${id}" is not registered`);
  }
  return mod;
}

/** 列出全部已注册系统（供 tools list-registries 等检查/调试）。 */
export function listRegisteredSystems(): SystemSpec[] {
  return getRegistries().systemRegistry.all();
}

/** 列出全部已注册原型。 */
export function listRegisteredArchetypes(): ArchetypeSpec[] {
  return getRegistries().archetypeRegistry.all();
}

/** 列出全部已注册动作/条件。 */
export function listRegisteredActions(): ActionEntry[] {
  return getRegistries().actionRegistry.all();
}

/** 列出全部已注册组件（名 → 组件对象）。 */
export function listRegisteredComponents(): Readonly<Record<string, unknown>> {
  return getRegistries().componentRegistry.all();
}

/** 列出全部已注册地图生成器。 */
export function listRegisteredGenerators(): GeneratorEntry[] {
  return getRegistries().generatorRegistry.all();
}

/** 列出全部已注册生成积木（map/generate 层注册表；地图管道的 generator 名在此查找）。 */
export function listRegisteredMapGenerators(): MapBlockEntry[] {
  return getRegistries().mapGeneratorRegistry.all();
}

/**
 * 校验一份游戏配置是否符合 GameDefinitionSchema（类型守卫）。
 * 用于 tools validate 与加载前置检查：合法返回 true 且收窄类型。
 */
export function validateGameDefinition(gameDef: unknown): gameDef is GameDefinition {
  return GameDefinitionSchema.safeParse(gameDef).success;
}

export { buildMapRuntime } from "framework/map/buildRuntime";
