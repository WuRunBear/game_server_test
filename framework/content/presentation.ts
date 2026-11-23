/**
 * 表现语义注册/查询层（framework/content/presentation.ts）。
 *
 * 职责边界（框架游戏无关）：
 * - `loadPresentation` 把一份原始 JSON 经 PresentationSchema 校验后**深度冻结**
 *   并登记为当前活动配置；
 * - 查询函数只做「每图覆盖 → 全局默认」的合并查找，不解释 category /
 *   autotileGroup / footstepId / visualId 等不透明字符串；
 * - `validatePresentation` 是纯函数：检查地图 registry 与表现条目的覆盖关系，
 *   并检查配置中实际引用的 tile 语义 id 是否都有定义（返回错误列表，不抛）。
 *
 * 生命周期：表现配置属于**游戏内容**，不是 ECS 状态；同进程只保留最近一次
 * `loadGameDefinition` 装入的配置（load 全量替换，无 presentation 的旧游戏会
 * 清空）。需要多游戏并存时由调用方在加载前切换。
 */
import type { MapConfig } from "framework/config/schema/MapRegistrySchema";
import {
  PresentationConfigSchema,
  type MapPresentation,
  type PresentationConfig,
  type PresentationLevelSemantics,
  type TileSemanticSpec,
  type TileSemanticsTable,
} from "framework/config/schema/PresentationSchema";

/** 完整性校验所需的最小游戏定义切片（避免与 loader 互相依赖）。 */
export interface PresentationValidationContext {
  /** 已加载的表现配置（无 presentation 的旧游戏为 undefined）。 */
  resolvedPresentation?: PresentationConfig;
  /** 地图生成配置（来自 maps/registry.json）。 */
  resolvedMapConfigs?: readonly MapConfig[];
  /** 规则表（规则文件基名 → 内容；读取 environment/disasters）。 */
  resolvedRules?: Record<string, unknown>;
}

/** 校验结果（纯数据，不抛错）。 */
export interface PresentationValidationResult {
  /** 是否全部通过。 */
  ok: boolean;
  /** 人类可读错误列表（ok=true 时为空数组）。 */
  errors: string[];
}

/** 当前活动表现配置（进程内单例；load 全量替换）。 */
let activePresentation: PresentationConfig | undefined;

/** 递归冻结（配置来自 JSON，无循环引用）。 */
function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) {
      deepFreeze(child);
    }
    Object.freeze(value);
  }
  return value;
}

/**
 * 校验一份表现配置并登记为当前活动配置。
 *
 * @param raw 原始 JSON（未校验）
 * @returns 深度冻结后的配置（同时成为查询函数的当前数据源）
 * @throws ZodError 当结构/字段/tile id 键非法时
 */
export function loadPresentation(raw: unknown): PresentationConfig {
  const parsed = PresentationConfigSchema.parse(raw);
  const frozen = deepFreeze(parsed);
  activePresentation = frozen;
  return frozen;
}

/** 清空当前活动配置（无 presentation 的游戏加载时使用；测试也可用）。 */
export function clearPresentation(): void {
  activePresentation = undefined;
}

/** 当前活动配置（未加载时为 undefined）。 */
export function getPresentation(): PresentationConfig | undefined {
  return activePresentation;
}

/** 单图表现条目（未加载/未配置该图时 undefined）。 */
export function getMapPresentation(mapId: string): MapPresentation | undefined {
  return activePresentation?.maps[mapId];
}

/** 按「该图覆盖 → 全局默认」查找单个 tile 语义（未定义时 undefined）。 */
export function getTileSemantic(mapId: string, tileId: number): TileSemanticSpec | undefined {
  if (!activePresentation) return undefined;
  const key = String(tileId);
  return activePresentation.maps[mapId]?.tileSemantics?.[key] ?? activePresentation.tileSemantics[key];
}

/**
 * 单图合并后的完整 tile 语义表（全局 + 该图覆盖；供 manifest / 调试输出）。
 * 返回值是新的冻结对象，但不改变已登记配置。
 */
export function listTileSemantics(mapId: string): TileSemanticsTable {
  if (!activePresentation) return Object.freeze({});
  const override = activePresentation.maps[mapId]?.tileSemantics ?? {};
  return Object.freeze({ ...activePresentation.tileSemantics, ...override });
}

/** 单图层边界语义（未配置时 undefined）。 */
export function getLevelSemantics(mapId: string): PresentationLevelSemantics | undefined {
  return activePresentation?.maps[mapId]?.levelSemantics;
}

/** 把 unknown 收窄为普通对象（排除 null 与数组）。 */
function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** 规范 0..255 整数 tile id 判断。 */
function isTileId(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 255;
}

/** 语义引用收集表：id → 引用来源（用于错误消息定位）。 */
type SemanticReferences = Map<number, Set<string>>;

/** 记录一条语义 id 引用（非法值忽略——由生成积木自身的参数校验兜底）。 */
function addReference(refs: SemanticReferences, value: unknown, source: string): void {
  if (!isTileId(value)) return;
  let sources = refs.get(value);
  if (!sources) {
    sources = new Set<string>();
    refs.set(value, sources);
  }
  sources.add(source);
}

/** 记录一组语义 id 引用。 */
function addReferences(refs: SemanticReferences, values: unknown, source: string): void {
  if (!Array.isArray(values)) return;
  for (const value of values) addReference(refs, value, source);
}

/** 记录 ground 图层数据里出现的全部语义 id。 */
function addGroundLayerReferences(refs: SemanticReferences, tiled: unknown, source: string): void {
  const layers = asRecord(tiled)?.layers;
  if (!Array.isArray(layers)) return;
  for (const layer of layers) {
    const entry = asRecord(layer);
    if (!entry || entry.type !== "tilelayer" || entry.name !== "ground") continue;
    if (!Array.isArray(entry.data)) continue;
    for (const value of entry.data) addReference(refs, value, source);
  }
}

/**
 * 收集一张地图生成管道中实际会写入/比较的语义 id（按生成积木参数名）。
 *
 * 覆盖：noise-terrain groundPalette / nonWalkableSemantics、smooth-terrain
 * nonWalkableSemantics、quantize-terrain slope/cliff、room-corridor 与
 * slot-rooms floor/solid、river waterSemantics、ca-cave wall/floor、
 * stamp-template 模板 ground 层、tiled-source 的默认 0。
 */
function collectMapSemanticReferences(config: MapConfig): SemanticReferences {
  const refs: SemanticReferences = new Map();

  for (const step of config.pipeline) {
    const params = asRecord(step.params) ?? {};
    switch (step.generator) {
      case "noise-terrain": {
        const palette = asRecord(params.groundPalette);
        if (palette) {
          for (const key of Object.keys(palette)) {
            const id = Number(key);
            if (isTileId(id) && String(id) === key) {
              addReference(refs, id, "noise-terrain groundPalette");
            }
          }
        }
        addReferences(refs, params.nonWalkableSemantics, "noise-terrain nonWalkableSemantics");
        break;
      }
      case "smooth-terrain":
        addReferences(refs, params.nonWalkableSemantics, "smooth-terrain nonWalkableSemantics");
        break;
      case "quantize-terrain":
        addReference(refs, params.slopeSemantics, "quantize-terrain slopeSemantics");
        addReference(refs, params.cliffSemantics, "quantize-terrain cliffSemantics");
        break;
      case "room-corridor":
        addReference(refs, params.floorTile, "room-corridor floorTile");
        addReference(refs, params.solidTile, "room-corridor solidTile");
        break;
      case "slot-rooms":
        addReference(refs, params.floorTile, "slot-rooms floorTile");
        addReference(refs, params.solidTile, "slot-rooms solidTile");
        break;
      case "river":
        addReference(refs, params.waterSemantics, "river waterSemantics");
        break;
      case "ca-cave":
        addReference(refs, params.wallSemantics, "ca-cave wallSemantics");
        addReference(refs, params.floorSemantics, "ca-cave floorSemantics");
        break;
      case "stamp-template":
        addGroundLayerReferences(refs, params.tiled, "stamp-template ground layer");
        break;
      case "tiled-source":
        // tiled-source 不读取 ground 层：tiles 恒为 0（默认地面语义）
        addReference(refs, 0, "tiled-source default ground");
        break;
      default:
        break;
    }
  }

  return refs;
}

/** 收集全局规则（environment / disasters）引用的语义 id。 */
function collectGlobalSemanticReferences(rules: Record<string, unknown>): SemanticReferences {
  const refs: SemanticReferences = new Map();

  const environment = asRecord(rules["environment"]);
  const overrides = environment?.groundOverrides;
  if (Array.isArray(overrides)) {
    for (const entry of overrides) {
      const override = asRecord(entry);
      if (!override) continue;
      addReference(refs, override.fromSemantic, "environment.groundOverrides.fromSemantic");
      addReference(refs, override.toSemantic, "environment.groundOverrides.toSemantic");
    }
  }

  const wildfire = asRecord(asRecord(rules["disasters"])?.wildfire);
  if (wildfire) {
    addReference(refs, wildfire.scorchGround, "disasters.wildfire.scorchGround");
    addReferences(refs, wildfire.flammableGrounds, "disasters.wildfire.flammableGrounds");
  }

  return refs;
}

/** 查找语义定义：该图覆盖 → 全局默认。 */
function lookupSemantic(
  config: PresentationConfig,
  mapId: string,
  id: number,
): TileSemanticSpec | undefined {
  const key = String(id);
  return config.maps[mapId]?.tileSemantics?.[key] ?? config.tileSemantics[key];
}

/** 格式化引用来源集合（稳定顺序，便于测试断言）。 */
function formatSources(sources: Set<string>): string {
  return [...sources].sort().join(", ");
}

/**
 * 表现语义完整性校验（纯函数，不抛错）。
 *
 * 检查项：
 * - registry 中每张图都有 `maps[mapId]` 条目；`maps` 里不得出现 registry 之外的 key；
 * - 每张图管道/模板实际引用的语义 id 在该图可解析（该图覆盖 → 全局）；
 * - 有 quantize-terrain 的图必须声明一致的 `levelSemantics`；
 * - 全局规则（environment.groundOverrides / disasters.wildfire）引用的 id 在
 *   全局 `tileSemantics` 中有定义；
 * - `connections[].to` 指向 registry 中的地图。
 *
 * 无 `resolvedPresentation` 时返回 ok（旧游戏/测试不受影响）。
 */
export function validatePresentation(gameDef: PresentationValidationContext): PresentationValidationResult {
  const config = gameDef.resolvedPresentation;
  if (!config) return { ok: true, errors: [] };

  const errors: string[] = [];
  const mapConfigs = gameDef.resolvedMapConfigs ?? [];
  const registryKeys = new Set(mapConfigs.map((map) => map.key));

  for (const key of Object.keys(config.maps)) {
    if (!registryKeys.has(key)) {
      errors.push(`presentation: map "${key}" is not declared in the map registry`);
    }
  }

  for (const map of mapConfigs) {
    const presentation = config.maps[map.key];
    if (!presentation) {
      errors.push(`presentation: map "${map.key}" has no presentation entry`);
      continue;
    }

    const refs = collectMapSemanticReferences(map);

    const levelSemantics = presentation.levelSemantics;
    if (levelSemantics) {
      addReference(refs, levelSemantics.slope, "levelSemantics slope");
      addReference(refs, levelSemantics.cliff, "levelSemantics cliff");
    }

    for (const [id, sources] of refs) {
      if (!lookupSemantic(config, map.key, id)) {
        errors.push(
          `presentation: map "${map.key}" references undefined tile semantic ${id} (${formatSources(sources)})`,
        );
      }
    }

    const quantizeStep = map.pipeline.find((step) => step.generator === "quantize-terrain");
    if (quantizeStep) {
      const params = asRecord(quantizeStep.params) ?? {};
      const slope = params.slopeSemantics;
      const cliff = params.cliffSemantics;
      if (isTileId(slope) && isTileId(cliff)) {
        if (!levelSemantics) {
          errors.push(
            `presentation: map "${map.key}" has a quantize-terrain step but no levelSemantics (expected slope ${slope}, cliff ${cliff})`,
          );
        } else if (levelSemantics.slope !== slope || levelSemantics.cliff !== cliff) {
          errors.push(
            `presentation: map "${map.key}" levelSemantics (slope ${levelSemantics.slope}, cliff ${levelSemantics.cliff}) do not match quantize-terrain (slope ${slope}, cliff ${cliff})`,
          );
        }
      }
    }

    for (const connection of presentation.connections ?? []) {
      if (!registryKeys.has(connection.to)) {
        errors.push(
          `presentation: map "${map.key}" connection target "${connection.to}" is not declared in the map registry`,
        );
      }
    }
  }

  const globalRefs = collectGlobalSemanticReferences(gameDef.resolvedRules ?? {});
  for (const [id, sources] of globalRefs) {
    if (!config.tileSemantics[String(id)]) {
      errors.push(
        `presentation: global tile semantic ${id} referenced by ${formatSources(sources)} has no definition in tileSemantics`,
      );
    }
  }

  return { ok: errors.length === 0, errors };
}
