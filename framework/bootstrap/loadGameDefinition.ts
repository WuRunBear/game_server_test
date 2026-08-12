/**
 * 游戏配置加载——把 game/ 目录下的 JSON 配置文件读入内存、逐文件校验并合并。
 *
 * 输入：game.json 主配置（含各资源文件的 glob 路径、netSync 字段等）。
 * 输出：LoadedGameDefinition（主配置 + 解析后的实体原型/行为/规则/刷怪/
 * 物品/对话/任务/地图来源），最后经 validateIntegrity 做跨文件引用完整性校验。
 *
 * 各资源文件按路径 glob 加载，逐文件用 zod schema 校验；规则文件按文件名
 * 找已注册 schema（getRuleSchema），未注册的保持原样透传（向后兼容）。
 */
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { resolve, dirname, basename } from "node:path";
import {
  GameDefinitionSchema,
  type LoadedGameDefinition,
  type BehaviorDefinition,
  type SpawnRule,
} from "framework/config/schema/GameDefinitionSchema";
import { ArchetypeSchema } from "framework/config/schema/ArchetypeSchema";
import { BehaviorSchema } from "framework/config/schema/BehaviorSchema";
import { SpawnRuleSchema, SpawnRegistrySchema } from "framework/config/schema/SpawnSchema";
import { ItemKindSchema, type ItemKindSpec } from "framework/config/schema/ItemKindSchema";
import { DialogueRegistrySchema, type DialogueTreeJson } from "framework/config/schema/DialogueSchema";
import { QuestRegistrySchema, type QuestDefinitionJson } from "framework/config/schema/QuestSchema";
import { MapRegistrySchema, type GeneratedMapEntryJson, type TiledMapEntryJson } from "framework/config/schema/MapRegistrySchema";
import { getRuleSchema } from "framework/config/schema/ruleSchemas";
import { hasSpawnCondition } from "framework/systems/gameplay/spawnConditions";
import { getRegistries } from "framework/bootstrap";
import type { MapSource } from "framework/map/types";
import type { ArchetypeSpec } from "framework/entities/archetypeRegistry";

export interface LoadGameDefinitionOptions {
  /** game.json 路径（相对 process.cwd()）；缺省 "game/game.json"。 */
  gameJsonPath?: string;
}

/** 主配置所在目录（其余资源文件路径相对它解析）。 */
function resolveConfigDir(gameJsonPath: string): string {
  return resolve(process.cwd(), dirname(gameJsonPath));
}

/** 读 JSON 文件并解析为 unknown（由调用方的 zod schema 校验）。 */
function readJsonFile(filePath: string): unknown {
  const text = readFileSync(filePath, "utf8");
  return JSON.parse(text) as unknown;
}

/** 按 glob 展开 JSON 文件绝对路径列表：含 `*` 时扫描目录下全部 .json，否则按单文件存在性判断。 */
function loadFilesByGlob(baseDir: string, pattern: string): string[] {
  if (pattern.includes("*")) {
    const dir = dirname(pattern);
    const scanDir = resolve(baseDir, dir);
    if (!existsSync(scanDir)) return [];
    return readdirSync(scanDir)
      .filter((f) => f.endsWith(".json"))
      .map((f) => resolve(scanDir, f));
  }
  const fullPath = resolve(baseDir, pattern);
  return existsSync(fullPath) ? [fullPath] : [];
}

/** 加载实体原型文件（每个文件一个 ArchetypeSchema，逐文件 zod 校验后拍平为原型列表）。 */
function loadArchetypesFiles(baseDir: string, entityPattern?: string): ArchetypeSpec[] {
  if (!entityPattern) return [];
  const files = loadFilesByGlob(baseDir, entityPattern);
  const results: ArchetypeSpec[] = [];
  for (const file of files) {
    const raw = readJsonFile(file);
    const parsed = ArchetypeSchema.parse(raw);
    results.push(parsed as ArchetypeSpec);
  }
  return results;
}

/** 加载行为树文件（每个文件一个 BehaviorSchema，逐文件 zod 校验）。 */
function loadBehaviorFiles(baseDir: string, behaviorPattern?: string): BehaviorDefinition[] {
  if (!behaviorPattern) return [];
  const files = loadFilesByGlob(baseDir, behaviorPattern);
  const results: BehaviorDefinition[] = [];
  for (const file of files) {
    const raw = readJsonFile(file);
    const parsed = BehaviorSchema.parse(raw);
    results.push(parsed as BehaviorDefinition);
  }
  return results;
}

/** 加载规则文件：文件名（去 .json 后缀）→ 规则内容；已注册 schema 走 zod，否则原样透传。 */
function loadRulesFile(baseDir: string, rulesPattern?: string): Record<string, unknown> {
  if (!rulesPattern) return {};
  const files = loadFilesByGlob(baseDir, rulesPattern);
  const allRules: Record<string, unknown> = {};
  for (const file of files) {
    const raw = readJsonFile(file);
    const name = basename(file).replace(/\.json$/, "");
    // 已注册 schema 的规则文件名走 zod 校验；未注册的保持 raw 透传（向后兼容）
    const schema = getRuleSchema(name);
    allRules[name] = schema ? schema.parse(raw) : raw;
  }
  return allRules;
}

/** 加载物品类型文件（每个文件一个 ItemKindSchema）；kind 全局唯一，重复抛错。 */
function loadItemsFile(baseDir: string, itemsPattern?: string): ItemKindSpec[] {
  if (!itemsPattern) return [];
  const files = loadFilesByGlob(baseDir, itemsPattern);
  const results: ItemKindSpec[] = [];
  const seen = new Set<string>();
  for (const file of files) {
    const raw = readJsonFile(file);
    const parsed = ItemKindSchema.parse(raw);
    if (seen.has(parsed.kind)) {
      throw new Error(`Duplicate item kind "${parsed.kind}" in ${file}`);
    }
    seen.add(parsed.kind);
    results.push(parsed);
  }
  return results;
}

/** 加载刷怪规则文件：SpawnRegistrySchema 解包出 rules 数组，逐条再校验。 */
function loadSpawnsFile(baseDir: string, spawnsPattern?: string): SpawnRule[] {
  if (!spawnsPattern) return [];
  const files = loadFilesByGlob(baseDir, spawnsPattern);
  const results: SpawnRule[] = [];
  for (const file of files) {
    const raw = readJsonFile(file);
    const parsed = SpawnRegistrySchema.parse(raw);
    for (const rule of parsed.rules) {
      results.push(SpawnRuleSchema.parse(rule) as SpawnRule);
    }
  }
  return results;
}

/** 加载对话树文件（DialogueRegistrySchema 解包出 trees，逐棵 push）；树 id 全局唯一，重复抛错。 */
function loadDialoguesFile(baseDir: string, pattern?: string): DialogueTreeJson[] {
  if (!pattern) return [];
  const files = loadFilesByGlob(baseDir, pattern);
  const results: DialogueTreeJson[] = [];
  const seen = new Set<string>();
  for (const file of files) {
    const raw = readJsonFile(file);
    const parsed = DialogueRegistrySchema.parse(raw);
    for (const tree of parsed.trees) {
      if (seen.has(tree.id)) {
        throw new Error(`Duplicate dialogue tree "${tree.id}" in ${file}`);
      }
      seen.add(tree.id);
      results.push(tree);
    }
  }
  return results;
}

/** 加载任务文件（QuestRegistrySchema）；任务 id 全局唯一，重复抛错。 */
function loadQuestsFile(baseDir: string, pattern?: string): QuestDefinitionJson[] {
  if (!pattern) return [];
  const files = loadFilesByGlob(baseDir, pattern);
  const results: QuestDefinitionJson[] = [];
  const seen = new Set<string>();
  for (const file of files) {
    const raw = readJsonFile(file);
    const parsed = QuestRegistrySchema.parse(raw);
    for (const quest of parsed.quests) {
      if (seen.has(quest.id)) {
        throw new Error(`Duplicate quest "${quest.id}" in ${file}`);
      }
      seen.add(quest.id);
      results.push(quest);
    }
  }
  return results;
}

/**
 * 解析地图注册表：返回全部地图来源（key=地图 id）与默认地图来源。
 * 单条解析逻辑与历史 resolveMapSource 一致；无注册表/无地图时返回空。
 */
function resolveMapSources(
  baseDir: string,
  mapRegistryPath?: string,
): { sources: Record<string, MapSource>; defaultSource?: MapSource } {
  if (!mapRegistryPath) return { sources: {} };
  const fullPath = resolve(baseDir, mapRegistryPath);
  if (!existsSync(fullPath)) return { sources: {} };

  const raw = readJsonFile(fullPath);
  const registry = MapRegistrySchema.parse(raw);
  const sources: Record<string, MapSource> = {};
  let defaultSource: MapSource | undefined;

  for (const [key, entry] of Object.entries(registry.maps)) {
    let source: MapSource;
    if (entry.kind === "tiled") {
      const tiledEntry = entry as TiledMapEntryJson;
      const tiledPath = resolve(dirname(fullPath), tiledEntry.path);
      source = {
        kind: "tiled" as const,
        id: tiledEntry.id ?? key,
        name: tiledEntry.name ?? key,
        json: readJsonFile(tiledPath),
      };
    } else {
      const genEntry = entry as GeneratedMapEntryJson;
      source = {
        kind: "generated" as const,
        generatorId: genEntry.generatorId ?? "simple",
        id: genEntry.id ?? key,
        name: genEntry.name ?? key,
        seed: genEntry.seed ?? 1,
        width: genEntry.width ?? 64,
        height: genEntry.height ?? 64,
        tileWidth: genEntry.tileWidth ?? 16,
        tileHeight: genEntry.tileHeight ?? 16,
      };
    }
    sources[key] = source;
    if (key === (registry.default ?? Object.keys(registry.maps)[0])) {
      defaultSource = source;
    }
  }

  return { sources, defaultSource };
}

/**
 * 跨文件引用完整性校验——配置里引用的任何东西都必须真实存在。
 *
 * 校验对象：system/action/component/archetype 注册表存在性、behavior 引用、
 * 刷怪条件的 kind/condition/mapId、netSync 的组件与标签、合成配方的物品 kind、
 * 放置物品的原型、对话树的 treeId 与跳转目标/任务效果、任务引用的 itemKind/victimKind/奖励。
 *
 * 若框架尚未 bootstrap（注册表不可用，如纯类型测试场景）则静默跳过校验。
 */
function validateIntegrity(data: LoadedGameDefinition): void {
  try {
    const { systemRegistry, actionRegistry, componentRegistry, archetypeRegistry } = getRegistries();

    for (const entry of data.systems ?? []) {
      if (!systemRegistry.has(entry.id)) {
        throw new Error(`System "${entry.id}" referenced in game config is not registered`);
      }
    }

    for (const entity of data.resolvedEntities) {
      if (entity.behavior) {
        const behaviorExists = data.resolvedBehaviors.some((b) => b.id === entity.behavior);
        if (!behaviorExists) {
          throw new Error(`Behavior "${entity.behavior}" referenced by archetype "${entity.kind}" not found in behaviors config`);
        }
      }
      for (const compName of Object.keys(entity.components)) {
        if (!componentRegistry.has(compName)) {
          throw new Error(`Component "${compName}" referenced by archetype "${entity.kind}" is not registered`);
        }
      }
    }

    for (const behavior of data.resolvedBehaviors) {
      const actionNames = new Set<string>();
      collectActionNames(behavior.definition, actionNames);
      for (const name of actionNames) {
        if (!actionRegistry.has(name)) {
          throw new Error(`Action "${name}" referenced by behavior "${behavior.id}" is not registered`);
        }
      }
    }

    for (const spawn of data.resolvedSpawns) {
      const entityExists = data.resolvedEntities.some((e) => e.kind === spawn.kind) ||
        archetypeRegistry.has(spawn.kind);
      if (!entityExists) {
        throw new Error(`Entity kind "${spawn.kind}" referenced in spawns is not defined`);
      }
      if (spawn.condition && !hasSpawnCondition(spawn.condition)) {
        throw new Error(
          `Spawn rule for "${spawn.kind}" references unknown condition "${spawn.condition}"`,
        );
      }
      if (spawn.mapId && !data.resolvedMapSources?.[spawn.mapId]) {
        throw new Error(
          `Spawn rule for "${spawn.kind}" references unknown map "${spawn.mapId}"`,
        );
      }
    }

    for (const field of data.netSync?.fields ?? []) {
      if (!componentRegistry.has(field.component)) {
        throw new Error(`Component "${field.component}" referenced in netSync is not registered`);
      }
      for (const tag of field.tags ?? []) {
        if (!componentRegistry.has(tag)) {
          throw new Error(`Tag "${tag}" referenced in netSync (${field.component}) is not registered`);
        }
      }
    }

    const crafting = data.resolvedRules["crafting"] as
      | { recipes?: { id: string; inputs: { kind: string }[]; outputs: { kind: string }[] }[] }
      | undefined;
    if (crafting?.recipes) {
      const knownKinds = new Set(data.resolvedItems.map((i) => i.kind));
      for (const recipe of crafting.recipes) {
        for (const io of [...recipe.inputs, ...recipe.outputs]) {
          if (!knownKinds.has(io.kind)) {
            throw new Error(`Recipe "${recipe.id}" references unknown item kind "${io.kind}"`);
          }
        }
      }
    }

    for (const item of data.resolvedItems) {
      if (!item.place) continue;
      const archetypeExists = data.resolvedEntities.some((e) => e.kind === item.place!.archetype) ||
        archetypeRegistry.has(item.place!.archetype);
      if (!archetypeExists) {
        throw new Error(`Item "${item.kind}" places unknown archetype "${item.place!.archetype}"`);
      }
    }

    // 对话树引用校验：DialogueSource 组件 treeId → 树存在；树效果 questId → 任务存在
    const dialogueIds = new Set(data.resolvedDialogues.map((t) => t.id));
    for (const entity of data.resolvedEntities) {
      const source = entity.components["DialogueSource"] as { treeId?: string } | undefined;
      if (source?.treeId && !dialogueIds.has(source.treeId)) {
        throw new Error(`Archetype "${entity.kind}" references unknown dialogue tree "${source.treeId}"`);
      }
    }
    const questIds = new Set(data.resolvedQuests.map((q) => q.id));
    for (const tree of data.resolvedDialogues) {
      if (!tree.nodes[tree.start]) {
        throw new Error(`Dialogue tree "${tree.id}" start node "${tree.start}" not found`);
      }
      for (const [nodeId, node] of Object.entries(tree.nodes)) {
        for (const option of node.options) {
          // 跳转目标引用校验：缺省/__end__（结束标记，dialogueSystem.END_DIALOGUE）或必须指向树内节点
          const to = option.to;
          if (to && to !== "__end__" && !tree.nodes[to]) {
            throw new Error(
              `Dialogue "${tree.id}" node "${nodeId}" option "${option.label}" references unknown node "${to}"`,
            );
          }
          const effect = option.effect;
          if (!effect) continue;
          const questEffect = effect.type === "quest_accept" || effect.type === "quest_submit";
          if (questEffect && !questIds.has(effect.questId)) {
            throw new Error(
              `Dialogue "${tree.id}" node "${nodeId}" option "${option.label}" effect references unknown quest "${effect.questId}"`,
            );
          }
        }
      }
    }

    // 任务引用校验：itemKind/rewards → item 目录；victimKind → 实体原型
    const itemKinds = new Set(data.resolvedItems.map((i) => i.kind));
    for (const quest of data.resolvedQuests) {
      if (quest.type === "collect" && !itemKinds.has(quest.itemKind ?? "")) {
        throw new Error(`Quest "${quest.id}" references unknown item kind "${quest.itemKind}"`);
      }
      if (quest.type === "kill") {
        const victimExists = data.resolvedEntities.some((e) => e.kind === quest.victimKind) ||
          archetypeRegistry.has(quest.victimKind ?? "");
        if (!victimExists) {
          throw new Error(`Quest "${quest.id}" references unknown entity kind "${quest.victimKind}"`);
        }
      }
      for (const reward of quest.submit.rewards) {
        if (!itemKinds.has(reward.kind)) {
          throw new Error(`Quest "${quest.id}" reward references unknown item kind "${reward.kind}"`);
        }
      }
    }
  } catch (err) {
    if (err instanceof Error && err.message.includes("not bootstrapped")) {
      return;
    }
    throw err;
  }
}

/**
 * 收集行为树中引用的全部动作/条件名（供 validateIntegrity 校验注册表存在性）。
 * 与 btFactory 的收集器对齐：递归 children + child、认 name 与 call 两种形态、
 * 收集 while/until guard 里的条件名（guard 是单个 `{call}` 对象，无 type 字段）。
 */
function collectActionNames(node: unknown, names: Set<string>): void {
  if (typeof node === "string") {
    for (const match of node.matchAll(/action\s*\[([^\]]+)\]/g)) {
      if (match[1]) names.add(match[1]);
    }
    return;
  }
  if (!node || typeof node !== "object") return;
  const obj = node as Record<string, unknown>;
  const name = typeof obj.name === "string" ? obj.name : typeof obj.call === "string" ? obj.call : undefined;
  if (typeof name === "string") {
    names.add(name);
  }
  for (const key of ["while", "until"]) {
    const guard = obj[key];
    if (guard && typeof guard === "object" && typeof (guard as Record<string, unknown>).call === "string") {
      names.add((guard as Record<string, unknown>).call as string);
    }
  }
  if (Array.isArray(obj.children)) {
    for (const child of obj.children) {
      collectActionNames(child, names);
    }
  }
  if (obj.child) {
    collectActionNames(obj.child, names);
  }
}

/**
 * 加载完整游戏定义——配置文件加载管线的入口。
 *
 * 流程：解析 game.json 路径 → 不存在则返回内置默认定义（便于无配置启动/测试）→
 * 读主配置并用 GameDefinitionSchema 校验（失败即抛错）→ 按各资源字段的 glob
 * 逐个加载实体/行为/规则/刷怪/物品/对话/任务/地图 → 合并为 LoadedGameDefinition
 * → validateIntegrity 做跨文件引用完整性校验。
 * @param options gameJsonPath 指定主配置路径（相对 process.cwd()），缺省 "game/game.json"
 */
export function loadGameDefinition(options?: LoadGameDefinitionOptions): LoadedGameDefinition {
  const jsonPath = resolve(
    process.cwd(),
    options?.gameJsonPath ?? "game/game.json",
  );

  if (!existsSync(jsonPath)) {
    return createDefaultGameDefinition();
  }

  const baseDir = resolveConfigDir(jsonPath);
  const raw = readJsonFile(jsonPath);
  const result = GameDefinitionSchema.safeParse(raw);

  if (!result.success) {
    throw new Error(
      `Invalid game definition at ${jsonPath}: ${result.error.message}`,
    );
  }

  const gameDef = result.data;
  // 逐个加载资源文件（路径来自 game.json 的对应字段，均为可选 glob）
  const resolvedEntities = loadArchetypesFiles(baseDir, gameDef.entities);
  const resolvedBehaviors = loadBehaviorFiles(baseDir, gameDef.behaviors);
  const resolvedRules = loadRulesFile(baseDir, gameDef.rules);
  const resolvedSpawns = loadSpawnsFile(baseDir, gameDef.spawns);
  const resolvedItems = loadItemsFile(baseDir, gameDef.items);
  const resolvedDialogues = loadDialoguesFile(baseDir, gameDef.dialogues);
  const resolvedQuests = loadQuestsFile(baseDir, gameDef.quests);
  const mapResult = resolveMapSources(baseDir, gameDef.map?.registry);

  // 合并为最终定义：主配置字段 + 各 resolved* 资源数据 + 地图来源（默认/全量）
  const loaded: LoadedGameDefinition = {
    ...gameDef,
    resolvedEntities,
    resolvedBehaviors,
    resolvedRules,
    resolvedSpawns,
    resolvedItems,
    resolvedDialogues,
    resolvedQuests,
    resolvedMapSource: mapResult.defaultSource,
    resolvedMapSources: mapResult.sources,
  };

  validateIntegrity(loaded);

  return loaded;
}

/**
 * 内置默认游戏定义：不依赖任何 game/*.json 的最小可用配置。
 *
 * 用于 loadGameDefinition 找不到主配置时的兜底（如测试或空工程起步），
 * 启用一套最基础的系统链与 netSync 字段，资源数据全部为空数组/空对象。
 */
export function createDefaultGameDefinition(): LoadedGameDefinition {
  return {
    id: "default",
    name: "默认游戏",
    tickRate: 20,
    systems: [
      { id: "ai" },
      { id: "physics" },
      { id: "movement" },
      { id: "collision" },
      { id: "combat" },
      { id: "spawning" },
      { id: "inventory" },
      { id: "interaction" },
    ],
    netSync: {
      fields: [
        { component: "Transform", fields: ["x", "y"] },
        { component: "Health", fields: ["current"] },
        { component: "Collider", fields: ["shape", "radius"] },
        { component: "Size", fields: ["w", "h"] },
      ],
    },
    resolvedEntities: [],
    resolvedBehaviors: [],
    resolvedRules: {},
    resolvedSpawns: [],
    resolvedItems: [],
    resolvedDialogues: [],
    resolvedQuests: [],
    resolvedMapSource: undefined,
    resolvedMapSources: {},
  };
}
