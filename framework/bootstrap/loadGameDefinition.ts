/**
 * 游戏配置加载——把 game/ 目录下的 JSON 配置文件读入内存、逐文件校验并合并。
 *
 * 输入：game.json 主配置（含各资源文件的 glob 路径、netSync 字段等）。
 * 输出：LoadedGameDefinition（主配置 + 解析后的实体原型/行为/规则/
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
  type WorldTile,
} from "framework/config/schema/GameDefinitionSchema";
import { normalizeTileUnits } from "framework/config/tileUnits";
import { createLogger } from "framework/utils/logger";
import { ArchetypeSchema } from "framework/config/schema/ArchetypeSchema";
import { BehaviorSchema } from "framework/config/schema/BehaviorSchema";
import { ItemKindSchema, type ItemKindSpec } from "framework/config/schema/ItemKindSchema";
import { DialogueRegistrySchema, type DialogueTreeJson } from "framework/config/schema/DialogueSchema";
import { QuestRegistrySchema, type QuestDefinitionJson } from "framework/config/schema/QuestSchema";
import { MapRegistrySchema, type MapConfig } from "framework/config/schema/MapRegistrySchema";
import {
  EcosystemsSchema,
  type EcosystemsJson,
} from "framework/config/schema/EcosystemsSchema";
import {
  EntityRulesDocumentSchema,
  ruleIdentity,
  type EntityRule,
  type EntityRulesDocument,
} from "map/evolution/schema";
import type { PlayerRule } from "framework/config/schema/PlayerRuleSchema";
import { getRuleSchema } from "framework/config/schema/ruleSchemas";
import { hasSpawnCondition } from "framework/systems/gameplay/spawnConditions";
import { WILDERNESS } from "map/generate/blocks/climateRegions";
import { WALLS_REGION } from "map/generate/blocks/slotRooms";
import { tiledRegionNames } from "map/generate/blocks/tiledSource";
import { stampTemplateRegionNames } from "map/generate/blocks/stampTemplate";
import type { MapGenerationStep } from "map/generate/types";
import { getRegistries } from "framework/bootstrap";
import type { ArchetypeSpec } from "framework/entities/archetypeRegistry";

export interface LoadGameDefinitionOptions {
  /** game.json 路径（相对 process.cwd()）；缺省 "game/game.json"。 */
  gameJsonPath?: string;
}

/** 加载期日志（tile-units sizing 不一致警告等非阻断诊断）。 */
const logger = createLogger("load-game-def");

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

/** 加载对话树文件（DialogueRegistrySchema 解包出 trees 数组）；树 id 全局唯一，重复抛错。 */
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
 * 内联管道步骤的 tiledPath 模板（stamp-template 的加载期约定，积木零
 * 文件 I/O）：读文件 → params.tiled，删除 tiledPath。路径相对地图注册表
 * 文件所在目录解析（与 kind:"tiled" 的 path 一致）。缺文件/解析失败/
 * 与 tiled 同时声明/tiledPath 非字符串 → 抛错点名地图 key、步骤与路径。
 */
function inlineTemplateTiled(
  key: string,
  stepIndex: number,
  step: MapGenerationStep,
  registryDir: string,
): MapGenerationStep {
  const params = step.params;
  if (!params || params.tiledPath === undefined) return step;
  if (params.tiled !== undefined) {
    throw new Error(
      `map "${key}" pipeline step ${stepIndex} (${step.generator}): params declare both "tiled" and "tiledPath" — declare exactly one`,
    );
  }
  if (typeof params.tiledPath !== "string") {
    throw new Error(
      `map "${key}" pipeline step ${stepIndex} (${step.generator}): params.tiledPath must be a string path, got ${String(params.tiledPath)}`,
    );
  }
  let tiledJson: unknown;
  try {
    tiledJson = readJsonFile(resolve(registryDir, params.tiledPath));
  } catch (err) {
    throw new Error(
      `map "${key}" pipeline step ${stepIndex} (${step.generator}): template "${params.tiledPath}" failed to load: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
  const inlined: Record<string, unknown> = { ...params, tiled: tiledJson };
  delete inlined.tiledPath;
  return { ...step, params: inlined };
}

/**
 * 地图 sizing 注入（tile-units 机制，§3.4）：生成块参数缺 tileWidth/tileHeight
 * 时注入 world.tile 全局像寸——注入发生在配置解析层，生成积木自身的必填校验
 * 保持不变。tiled-source 步骤豁免（sizing 来自 Tiled JSON 自带的
 * tilewidth/tileheight，不读参数 sizing）。步骤显式声明且与全局基准不一致 →
 * 非阻断警告（实体 px 尺寸按全局基准换算，可能与该图几何比例失调）。
 *
 * 无参数切片的步骤不注入（sizing 积木必然自带参数对象；缺参错误由积木
 * 自身的 fail-fast 校验给出）。
 */
function applyWorldTileSizing(
  step: MapGenerationStep,
  mapKey: string,
  worldTile?: WorldTile,
): MapGenerationStep {
  if (!worldTile) return step;
  if (step.generator === "tiled-source") return step;
  const params = step.params;
  if (params === null || typeof params !== "object") return step;
  const raw = params as Record<string, unknown>;

  // 显式声明与全局基准不一致 → 非阻断警告（不修正声明值，交由积木校验把关类型）
  for (const axis of ["tileWidth", "tileHeight"] as const) {
    const declared = raw[axis];
    const expected = axis === "tileWidth" ? worldTile.width : worldTile.height;
    if (typeof declared === "number" && declared !== expected) {
      logger.warn(
        `map "${mapKey}" step "${step.generator}": params.${axis} (${declared}) differs from world.tile (${expected}) — ` +
          "entity px sizes are converted against the global tile size and may mismatch this map's geometry scale",
      );
    }
  }

  // 缺省键注入（不覆盖显式声明）
  if (raw.tileWidth !== undefined && raw.tileHeight !== undefined) return step;
  const paramsnext: Record<string, unknown> = { ...raw };
  if (paramsnext.tileWidth === undefined) paramsnext.tileWidth = worldTile.width;
  if (paramsnext.tileHeight === undefined) paramsnext.tileHeight = worldTile.height;
  return { ...step, params: paramsnext };
}

/**
 * 解析地图注册表：返回全部地图生成配置（key = 地图 registry key）。
 * Tiled 条目在此读取其 JSON 文件并内联进 tiled-source 积木参数——缺文件/
 * 解析失败在此处报错（积木本身不做文件 I/O）；管道步骤的 tiledPath 模板
 * 同样在此读文件内联为 params.tiled（stamp-template 加载期约定）；生成块
 * 参数缺 tileWidth/tileHeight 时注入 world.tile 全局像寸（§3.4）；无
 * 注册表/无地图时返回空。
 */
function resolveMapConfigs(
  baseDir: string,
  mapRegistryPath?: string,
  worldTile?: WorldTile,
): MapConfig[] {
  if (!mapRegistryPath) return [];
  const fullPath = resolve(baseDir, mapRegistryPath);
  if (!existsSync(fullPath)) return [];

  const raw = readJsonFile(fullPath);
  const registry = MapRegistrySchema.parse(raw);
  const configs: MapConfig[] = [];
  const registryDir = dirname(fullPath);

  for (const [key, entry] of Object.entries(registry.maps)) {
    if (entry.kind === "tiled") {
      const tiledPath = resolve(registryDir, entry.path);
      let tiledJson: unknown;
      try {
        tiledJson = readJsonFile(tiledPath);
      } catch (err) {
        throw new Error(
          `map "${key}": tiled source "${entry.path}" failed to load: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
      configs.push({
        key,
        seed: 0,
        initialAgeTicks: entry.initialAgeTicks,
        pipeline: [{ generator: "tiled-source", params: { tiled: tiledJson } }],
      });
    } else {
      configs.push({
        key,
        seed: entry.seed,
        initialAgeTicks: entry.initialAgeTicks,
        pipeline: entry.pipeline.map((step, stepIndex) =>
          applyWorldTileSizing(inlineTemplateTiled(key, stepIndex, step, registryDir), key, worldTile),
        ),
      });
    }
  }

  return configs;
}

/**
 * 解析实体规则文档中的命名模板组引用（加载器级展开，纯函数不改输入）：
 * - templateRef 规则查文档 templates 字典 → 展开为标准 inline `template`
 *   形态（条目深拷贝——多条规则共享同一组不产生别名引用）；
 * - 未知组名 → 抛错点名 ref 与规则身份（map|region|kind|mode，schema.ts
 *   ruleIdentity）与已声明的组名集合；
 * - density/exact 与 inline template 规则原样透传——输出形状与历史 loader
 *   产物完全一致（引擎与下游零感知，只认 inline 形态）。
 */
function resolveTemplateRefs(doc: EntityRulesDocument, source: string): EntityRule[] {
  const templates = doc.templates ?? {};
  return doc.rules.map((rule) => {
    if (rule.mode !== "template") return rule;
    const { templateRef, ...rest } = rule;
    if (templateRef === undefined) {
      // inline 形态：schema 层 superRefine 已保证与 templateRef 恰好声明其一，防御性兜底
      if (!rest.template) {
        throw new Error(
          `${source}: template rule on map "${rule.map}" region "${rule.region}" kind "${rule.kind}" declares neither "template" nor "templateRef"`,
        );
      }
      return { ...rest, template: rest.template };
    }
    const group = templates[templateRef];
    if (group === undefined) {
      const declared = Object.keys(templates)
        .map((name) => `"${name}"`)
        .join(", ");
      // ruleIdentity 只读 map|region|kind|mode——文档形态规则补齐 template
      // 形参即可复用同一身份函数（不复制身份格式）
      const identity = ruleIdentity({ ...rule, template: [] });
      throw new Error(
        `${source}: template rule \`${identity}\` references unknown templateRef "${templateRef}" (declared groups: ${declared || "none"})`,
      );
    }
    return { ...rest, template: group.map((entry) => ({ ...entry })) };
  });
}

/**
 * 加载实体演化规则文档（{ templates?, rules: [...] }）：整体 zod 校验
 * （template 规则的 template/templateRef 恰好声明其一在 schema 层 fail-fast）
 * 后，将 templateRef 规则解析为标准 inline template 形态。解析先于
 * validateIntegrity——模板条目的 kind 引用校验自动覆盖命名组条目。
 */
function loadEntityRules(baseDir: string, entityRulesPath?: string): EntityRule[] {
  if (!entityRulesPath) return [];
  const fullPath = resolve(baseDir, entityRulesPath);
  if (!existsSync(fullPath)) return [];

  const raw = readJsonFile(fullPath);
  const parsed = EntityRulesDocumentSchema.parse(raw);
  return resolveTemplateRefs(parsed, entityRulesPath);
}

/**
 * 加载生态声明层文件（{ ecosystems: EcosystemEntry[] }，B1 编译器模式的
 * 声明源）：整体 zod 校验（strictObject——未知字段即抛错，拼写错误在加载
 * 期 fail-fast）。展开本身归 bootMaps（density 需查区域面积，几何在开机
 * 期才生成/回填），此处只加载声明。路径缺省/文件不存在返回 undefined
 * （与 entityRules 的缺省约定一致：未声明即无生态层）。
 */
function loadEcosystemsFile(baseDir: string, ecosystemsPath?: string): EcosystemsJson | undefined {
  if (!ecosystemsPath) return undefined;
  const fullPath = resolve(baseDir, ecosystemsPath);
  if (!existsSync(fullPath)) return undefined;

  return EcosystemsSchema.parse(readJsonFile(fullPath));
}

/**
 * 收集一张地图生成后将存在的全部区域名（实体演化规则 region 引用的合法集合）：
 * - climate-regions 步骤的 params.names（命名区域）；
 * - tiled-source 步骤 zones 层产出的区域名（与积木同源解析）；
 * - stamp-template 步骤模板 zones 层产出的区域名（与积木同源解析）；
 * - slot-rooms 步骤的房间区域（"<类型>#<房序>"）与 walls 结构区；
 * - 隐式兜底区 wilderness（未被命名区域认领的格子归属，恒合法）。
 *
 * 只做名字收集，不校验各积木参数形状——参数错误由积木在生成期自行抛错。
 */
function collectMapRegionNames(config: MapConfig): Set<string> {
  const names = new Set<string>([WILDERNESS]);
  for (const step of config.pipeline) {
    if (step.generator === "climate-regions") {
      const declared = step.params?.names;
      if (Array.isArray(declared)) {
        for (const name of declared) {
          if (typeof name === "string") names.add(name);
        }
      }
    } else if (step.generator === "tiled-source" && step.params?.tiled !== undefined) {
      for (const name of tiledRegionNames(step.params.tiled, config.key)) {
        names.add(name);
      }
    } else if (step.generator === "stamp-template" && step.params?.tiled !== undefined) {
      for (const name of stampTemplateRegionNames(step.params.tiled, config.key)) {
        names.add(name);
      }
    } else if (step.generator === "slot-rooms") {
      collectSlotRoomsRegionNames(step.params, names);
    }
  }
  return names;
}

/**
 * slot-rooms 步骤的区域名收集（加载期超集近似，积木参数形状不在此校验）：
 * 实际区域键 = 每房一个 `"<类型>#<房序>"`（插入序 = 主路径序 → 支线序）+
 * 末尾 walls 结构区（WALLS_REGION，未雕挖格归属）。房序上界 = 主路径房数
 * （恒 = slotsX）+ 支线尝试上限（branchCount，实际可能更少）——加载期无法
 * 知道实际房数，收集上界内全部 `"<类型>#<i>"` 名字作为合法集合（超集，
 * 不存在的序号由开机 U5 对真实几何的校验兜底）。同时收集裸类型名（诊断
 * 友好；实际 region 键恒带 # 序号）。类型名来源 = roomTypes 映射（未配置
 * 的字段用结构名 path-first/path-mid/path-last/branch）。
 */
function collectSlotRoomsRegionNames(params: unknown, names: Set<string>): void {
  const raw = (typeof params === "object" && params !== null ? params : {}) as Record<string, unknown>;
  const slotsX =
    typeof raw.slotsX === "number" && Number.isInteger(raw.slotsX) && raw.slotsX >= 2 ? raw.slotsX : 5;
  const branchCount =
    typeof raw.branchCount === "number" && Number.isInteger(raw.branchCount) && raw.branchCount >= 0
      ? raw.branchCount
      : 3;
  const types = new Set<string>(["path-first", "path-mid", "path-last", "branch"]);
  const roomTypes = raw.roomTypes;
  if (typeof roomTypes === "object" && roomTypes !== null && !Array.isArray(roomTypes)) {
    const rt = roomTypes as Record<string, unknown>;
    for (const key of ["pathFirst", "pathMid", "pathLast"] as const) {
      if (typeof rt[key] === "string" && (rt[key] as string).length > 0) types.add(rt[key] as string);
    }
    if (Array.isArray(rt.branch)) {
      for (const name of rt.branch) {
        if (typeof name === "string" && name.length > 0) types.add(name);
      }
    }
  }
  const roomCountMax = slotsX + branchCount;
  for (const type of types) {
    names.add(type);
    for (let i = 0; i < roomCountMax; i++) {
      names.add(`${type}#${i}`);
    }
  }
  names.add(WALLS_REGION);
}

/**
 * 跨文件引用完整性校验——配置里引用的任何东西都必须真实存在。
 *
 * 校验对象：system/action/component/archetype 注册表存在性、behavior 引用、
 * 实体演化规则的 kind/condition/region、netSync 的组件与标签、合成配方的
 * 物品 kind、放置物品的原型、对话树的 treeId 与跳转目标/任务效果、任务引用的
 * itemKind/victimKind/奖励。
 *
 * region 校验针对「生成后将存在的完整区域集合」（climate 命名区 ∪ 隐式
 * wilderness ∪ tiled zones ∪ stamp-template 模板 zones ∪ slot-rooms 房间区
 * 与 walls 结构区），任一来源合法即可；exact 落点是否合法依赖生成后
 * 的几何，由开机全局校验负责，此处不查。
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

    // 实体演化规则引用校验：kind（含 template 条目）∈ 原型、condition ∈
    // spawnConditions 注册表、region ∈ 生成后将存在的区域集合
    for (const rule of data.resolvedEntityRules) {
      const ruleKinds = rule.mode === "template"
        ? [rule.kind, ...rule.template.map((t) => t.kind)]
        : [rule.kind];
      for (const kind of ruleKinds) {
        const kindExists = data.resolvedEntities.some((e) => e.kind === kind) ||
          archetypeRegistry.has(kind);
        if (!kindExists) {
          throw new Error(`Entity rule on map "${rule.map}" references unknown kind "${kind}"`);
        }
      }
      if (rule.condition && !hasSpawnCondition(rule.condition)) {
        throw new Error(
          `Entity rule for "${rule.kind}" on map "${rule.map}" references unknown condition "${rule.condition}"`,
        );
      }
      const mapConfig = data.resolvedMapConfigs.find((c) => c.key === rule.map);
      const legalRegions = mapConfig ? collectMapRegionNames(mapConfig) : new Set([WILDERNESS]);
      if (!legalRegions.has(rule.region)) {
        throw new Error(
          `Entity rule for "${rule.kind}" on map "${rule.map}" references unknown region "${rule.region}" (not produced by any generation source)`,
        );
      }
    }

    // 生态声明层（B1）引用校验：biome 须至少落在**一张**配置图的区域集合内
    // （同 biome 跨图声明合法——展开器按图各自展开，不要求全部图都有）；
    // kind ∈ 原型（density 条目为普通 kind，无 template 子条目）；
    // condition ∈ spawnConditions 注册表。错误消息点名 biome/kind 与文件路径。
    const ecosystemsPath = data.map?.ecosystems;
    for (const eco of data.resolvedEcosystems?.ecosystems ?? []) {
      const biomeExists = data.resolvedMapConfigs.some((config) =>
        collectMapRegionNames(config).has(eco.biome),
      );
      if (!biomeExists) {
        throw new Error(
          `Ecosystem biome "${eco.biome}" (${ecosystemsPath}) does not match any configured map's regions`,
        );
      }
      for (const entry of eco.spawnTable) {
        const kindExists = data.resolvedEntities.some((e) => e.kind === entry.kind) ||
          archetypeRegistry.has(entry.kind);
        if (!kindExists) {
          throw new Error(
            `Ecosystem entry for biome "${eco.biome}" (${ecosystemsPath}) references unknown kind "${entry.kind}"`,
          );
        }
        if ("condition" in entry && entry.condition && !hasSpawnCondition(entry.condition)) {
          throw new Error(
            `Ecosystem entry for biome "${eco.biome}" (${ecosystemsPath}) references unknown condition "${entry.condition}"`,
          );
        }
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
 * 加载期 tile 单位归一化接线（tile-units 机制）：对四类配置结构各调一次
 * normalizeTileUnits——
 * 1. 每个 archetype 的 components 块；
 * 2. 每个 resolvedRules[basename]（含 resolvedPlayerRule 等同引用别名）；
 * 3. 每个 behaviors 文件树（覆盖 BT args）；
 * 4. game.json 的 systems[].config。
 *
 * 调用时机：全部解析且 schema 校验通过后、注册表构建之前。§8.7 引用共享：
 * 原地转换，同一根对象只转换一次（重复调用会二次换算）——除 rules 别名
 * 天然同引用外，此处再以根对象去重兜底跨结构的意外共享。
 */
function normalizeLoadedTileUnits(loaded: LoadedGameDefinition, tilePx: number): void {
  const roots: Array<{ label: string; root: unknown }> = [];
  for (const entity of loaded.resolvedEntities) {
    roots.push({ label: `archetype "${entity.kind}" components`, root: entity.components });
  }
  for (const [name, rule] of Object.entries(loaded.resolvedRules)) {
    roots.push({ label: `rule "${name}"`, root: rule });
  }
  for (const behavior of loaded.resolvedBehaviors) {
    roots.push({ label: `behavior "${behavior.id}"`, root: behavior.definition });
  }
  for (const entry of loaded.systems ?? []) {
    roots.push({ label: `system config "${entry.id}"`, root: entry.config });
  }

  const seen = new Set<object>();
  for (const { label, root } of roots) {
    if (root === null || typeof root !== "object") continue;
    if (seen.has(root)) continue;
    seen.add(root);
    try {
      normalizeTileUnits(root, tilePx);
    } catch (err) {
      throw new Error(
        `tile-units normalization failed for ${label}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}

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
  const resolvedItems = loadItemsFile(baseDir, gameDef.items);
  const resolvedDialogues = loadDialoguesFile(baseDir, gameDef.dialogues);
  const resolvedQuests = loadQuestsFile(baseDir, gameDef.quests);
  const resolvedMapConfigs = resolveMapConfigs(baseDir, gameDef.map?.registry, gameDef.world?.tile);
  const resolvedEntityRules = loadEntityRules(baseDir, gameDef.map?.entityRules);
  const resolvedEcosystems = loadEcosystemsFile(baseDir, gameDef.map?.ecosystems);
  const resolvedPlayerRule = resolvedRules["player"] as PlayerRule | undefined;

  // 合并为最终定义：主配置字段 + 各 resolved* 资源数据 + 地图生成配置。
  // 规则双列表：resolvedStaticEntityRules 保持 entity-rules.json 原样（pristine），
  // resolvedEntityRules 为合并/活列表——boot 期由静态列表 + 生态展开产物重算。
  const loaded: LoadedGameDefinition = {
    ...gameDef,
    resolvedEntities,
    resolvedBehaviors,
    resolvedRules,
    resolvedItems,
    resolvedDialogues,
    resolvedQuests,
    resolvedMapConfigs,
    resolvedEntityRules,
    resolvedStaticEntityRules: resolvedEntityRules,
    resolvedEcosystems,
    resolvedPlayerRule,
  };

  // tile-units 归一化：全部配置解析且 schema 校验通过后、注册表构建之前，
  // 一次性把 `*Tiles` 量纲键换算为 px（运行时系统只见 px，零改动）
  normalizeLoadedTileUnits(loaded, gameDef.world.tile.width);

  validateIntegrity(loaded);

  return loaded;
}

export function createDefaultGameDefinition(): LoadedGameDefinition {
  return {
    id: "default",
    name: "默认游戏",
    tickRate: 20,
    world: { tile: { width: 16, height: 16 } },
    systems: [
      { id: "ai" },
      { id: "physics" },
      { id: "movement" },
      { id: "collision" },
      { id: "combat" },
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
    resolvedItems: [],
    resolvedDialogues: [],
    resolvedQuests: [],
    resolvedMapConfigs: [],
    resolvedEntityRules: [],
    // 注意：此处故意不赋 resolvedStaticEntityRules（可选字段）——手工构造的
    // def（含本缺省定义）通常只填 resolvedEntityRules，bootMaps 首次开机把
    // 它固化为静态基准；若此处赋空数组会把"静态为空"误当成 pristine 基准，
    // 开机时清掉调用方写入 resolvedEntityRules 的规则。
  };
}
