/**
 * 表现语义注册/查询层（framework/content/presentation.ts）。
 *
 * 职责边界（框架游戏无关）：
 * - `loadPresentation` 把一份原始 JSON 经 PresentationSchema 校验后**深度冻结**
 *   并登记为当前活动配置；音频/VFX 的事件引用（事件 type → sfx/effect id）
 *   与装饰规则的 decorId 引用在登记前校验，未知 id 直接抛错；
 * - 查询函数只做「每图覆盖 → 全局默认」的合并查找，不解释 category /
 *   autotileGroup / footstepId / visualId / sfx / effect / decorId 等不透明
 *   字符串；
 * - 实体表现（`entities`）按 kind 查询/列出，字段同样是不透明引用；
 * - 音频/VFX 按事件 type 查询要播放的 id 数组（无配置/无映射返回空数组）；
 * - 装饰（`decor` / `decorMaps`）只提供 id 表与落点规则查询；点集由地图视图
 *   层（map/clientView.ts）按确定性 hash 派生，不是实体、不写几何；
 * - `validatePresentation` 是纯函数：检查地图 registry 与表现条目的覆盖关系，
 *   检查配置中实际引用的 tile 语义 id 是否都有定义，并复核 audio/vfx 的事件
 *   引用与 decorMaps 的 mapId/region/decorId 引用（返回错误列表，不抛）。
 *
 * 生命周期：表现配置属于**游戏内容**，不是 ECS 状态；同进程只保留最近一次
 * `loadGameDefinition` 装入的配置（load 全量替换，无 presentation 的旧游戏会
 * 清空）。需要多游戏并存时由调用方在加载前切换。
 */
import type { MapConfig } from "framework/config/schema/MapRegistrySchema";
import {
  PresentationConfigSchema,
  type AudioPresentation,
  type DecorMapRules,
  type DecorRule,
  type EntityPresentation,
  type MapPresentation,
  type PresentationConfig,
  type PresentationLevelSemantics,
  type TileSemanticSpec,
  type TileSemanticsTable,
  type VfxPresentation,
} from "framework/config/schema/PresentationSchema";

/** 完整性校验所需的最小游戏定义切片（避免与 loader 互相依赖）。 */
export interface PresentationValidationContext {
  /** 已加载的表现配置（无 presentation 的旧游戏为 undefined）。 */
  resolvedPresentation?: PresentationConfig;
  /** 地图生成配置（来自 maps/registry.json）。 */
  resolvedMapConfigs?: readonly MapConfig[];
  /** 规则表（规则文件基名 → 内容；读取 environment/disasters）。 */
  resolvedRules?: Record<string, unknown>;
  /**
   * 地图 key → 该图生成后将存在的区域名集合（可选；装饰规则 region 校验用）。
   *
   * loader 用生成管道参数收集（climate-regions names / tiled & stamp zones /
   * slot-rooms 房间名 / walls / wilderness）后传入；调用方未提供时跳过
   * region 存在性检查（只保留 mapId / decorId 检查），避免纯类型测试因缺少
   * 生成上下文误报。
   */
  resolvedMapRegionNames?: ReadonlyMap<string, ReadonlySet<string>>;
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

/**
 * 表现配置修订号：每次 load/clear 递增。
 *
 * 客户端视图缓存（如 `/maps/decor` 点集）以 `{version, revision}` 为键——
 * 同一几何对象在写回后 version 变化、或配置被重新加载后 revision 变化，
 * 都会自动失效；缓存不持有旧配置/旧点集。
 */
let presentationRevision = 0;

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
 * 校验音频/VFX 事件映射的 id 引用（纯函数，返回人类可读错误列表）。
 *
 * 规则：`audio.events[type]` 的每个 id 必须是 `audio.sfx` 中已登记的 key；
 * `vfx.events[type]` 的每个 id 必须是 `vfx.effects` 中已登记的 key。事件 type
 * 本身不校验（由玩法系统决定，配置可先行）。无 audio/vfx 段时返回空数组。
 */
export function validateAudioVfxReferences(config: PresentationConfig): string[] {
  const errors: string[] = [];

  const audio = config.audio;
  if (audio) {
    for (const [eventType, ids] of Object.entries(audio.events)) {
      for (const id of ids) {
        if (!Object.hasOwn(audio.sfx, id)) {
          errors.push(`presentation: audio event "${eventType}" references unknown sfx "${id}"`);
        }
      }
    }
  }

  const vfx = config.vfx;
  if (vfx) {
    for (const [eventType, ids] of Object.entries(vfx.events)) {
      for (const id of ids) {
        if (!Object.hasOwn(vfx.effects, id)) {
          errors.push(`presentation: vfx event "${eventType}" references unknown effect "${id}"`);
        }
      }
    }
  }

  return errors;
}

/**
 * 校验装饰规则的 decorId 引用（纯函数，返回人类可读错误列表）。
 *
 * 规则：`decorMaps[mapId].regions[region][i].decorId` 必须是 `decor` 表中
 * 已登记的 key。mapId / region 的合法性依赖地图 registry 与生成产物，由
 * `validatePresentation`（可拿到 region 集合时）检查。
 */
export function validateDecorReferences(config: PresentationConfig): string[] {
  const errors: string[] = [];
  const decor = config.decor ?? {};
  for (const [mapId, mapRules] of Object.entries(config.decorMaps ?? {})) {
    for (const [region, rules] of Object.entries(mapRules.regions)) {
      rules.forEach((rule, index) => {
        if (!Object.hasOwn(decor, rule.decorId)) {
          errors.push(
            `presentation: decor map "${mapId}" region "${region}" rule ${index} references unknown decor "${rule.decorId}"`,
          );
        }
      });
    }
  }
  return errors;
}

/**
 * 校验一份表现配置并登记为当前活动配置。
 *
 * 音频/VFX 的事件引用与装饰规则的 decorId 引用不完整 → 抛错，不登记半成品
 * 配置（mapId/region 的存在性需要地图 registry/生成上下文，见
 * `validatePresentation`）。
 *
 * @param raw 原始 JSON（未校验）
 * @returns 深度冻结后的配置（同时成为查询函数的当前数据源）
 * @throws ZodError 当结构/字段/tile id 键非法时
 * @throws Error 当 audio/vfx 事件引用或 decorId 引用未知 id 时
 */
export function loadPresentation(raw: unknown): PresentationConfig {
  const parsed = PresentationConfigSchema.parse(raw);
  const referenceErrors = [
    ...validateAudioVfxReferences(parsed),
    ...validateDecorReferences(parsed),
  ];
  if (referenceErrors.length > 0) {
    throw new Error(referenceErrors.join("; "));
  }
  const frozen = deepFreeze(parsed);
  activePresentation = frozen;
  presentationRevision += 1;
  return frozen;
}

/** 清空当前活动配置（无 presentation 的游戏加载时使用；测试也可用）。 */
export function clearPresentation(): void {
  activePresentation = undefined;
  presentationRevision += 1;
}

/** 当前活动配置（未加载时为 undefined）。 */
export function getPresentation(): PresentationConfig | undefined {
  return activePresentation;
}

/**
 * 表现配置修订号（load/clear 递增；缓存失效键）。
 *
 * 点集缓存用它区分「同一 geometry 对象、重新加载了配置」的场景。
 */
export function getPresentationRevision(): number {
  return presentationRevision;
}

/** 全部装饰 id（字典序稳定；无配置为空数组）。 */
export function listDecorIds(): string[] {
  return Object.keys(activePresentation?.decor ?? {}).sort();
}

/** 单图装饰规则（未加载/该图未配置时 undefined）。 */
export function getDecorMapRules(mapId: string): DecorMapRules | undefined {
  return activePresentation?.decorMaps?.[mapId];
}

/**
 * 某图某区域的命中规则（具体 region 规则在前，`"*"` 兜底规则在后）。
 *
 * 只做配置查找，不做掷点；同一条规则可能在结果中出现一次。无配置/该图无
 * 规则时返回空数组。tile 的实际区域由 `regionOf` 决定，调用方传入。
 */
export function getDecorRulesForRegion(mapId: string, region: string): DecorRule[] {
  const mapRules = activePresentation?.decorMaps?.[mapId];
  if (!mapRules) return [];
  const rules: DecorRule[] = [...(mapRules.regions[region] ?? [])];
  if (region !== "*") rules.push(...(mapRules.regions["*"] ?? []));
  return rules;
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

/** 单个实体 kind 的表现条目（未加载/未配置该 kind 时 undefined）。 */
export function getEntityPresentation(kind: string): EntityPresentation | undefined {
  return activePresentation?.entities?.[kind];
}

/**
 * 全部实体表现条目（未加载时为冻结空对象；供 manifest / 调试输出）。
 *
 * 返回已登记配置中的实体表现表（未配置时为空对象），不复制、不解释字段。
 */
export function listEntityPresentations(): Readonly<Record<string, EntityPresentation>> {
  return activePresentation?.entities ?? Object.freeze({});
}

/**
 * 音频表现（未加载/未配置时为 undefined）。
 *
 * 只返回不透明 id 表与事件映射；服务端不持有资源。
 */
export function getAudioPresentation(): AudioPresentation | undefined {
  return activePresentation?.audio;
}

/** VFX 表现（未加载/未配置时为 undefined）。 */
export function getVfxPresentation(): VfxPresentation | undefined {
  return activePresentation?.vfx;
}

/**
 * 某客户端事件 type 要播放的音效 id 列表（保持配置顺序）。
 *
 * 无配置/无该事件映射时返回空数组（调用方无需判空）。
 */
export function audioIdsForEvent(type: string): string[] {
  const ids = activePresentation?.audio?.events[type];
  return ids ? [...ids] : [];
}

/** 某客户端事件 type 要播放的特效 id 列表（无配置/无映射返回空数组）。 */
export function vfxIdsForEvent(type: string): string[] {
  const ids = activePresentation?.vfx?.events[type];
  return ids ? [...ids] : [];
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
 * - 有地图表现内容（`maps` 或全局 `tileSemantics` 非空）时：registry 中每张图
 *   都有 `maps[mapId]` 条目，且 `maps` 里不得出现 registry 之外的 key；
 * - 每张图管道/模板实际引用的语义 id 在该图可解析（该图覆盖 → 全局）；
 * - 有 quantize-terrain 的图必须声明一致的 `levelSemantics`；
 * - 全局规则（environment.groundOverrides / disasters.wildfire）引用的 id 在
 *   全局 `tileSemantics` 中有定义；
 * - `connections[].to` 指向 registry 中的地图；
 * - 装饰规则 `decorMaps` 的 mapId 在 registry 中、decorId 在 `decor` 表中、
 *   region（除 `"*"` 外）由该图生成产出（调用方提供区域名集合时检查）。
 *
 * 无 `resolvedPresentation` 时返回 ok（旧游戏/测试不受影响）。只有装饰/实体/
 * 音频段、没有地图表现内容的配置（如纯 decor.json）不做地图覆盖检查。
 */
export function validatePresentation(gameDef: PresentationValidationContext): PresentationValidationResult {
  const config = gameDef.resolvedPresentation;
  if (!config) return { ok: true, errors: [] };

  // 音频/VFX 事件引用（防御性复核：loadPresentation 已在加载期拦截；手工
  // 构造的 resolvedPresentation 也走同一规则）
  const errors: string[] = [
    ...validateAudioVfxReferences(config),
    ...validateDecorReferences(config),
  ];
  const mapConfigs = gameDef.resolvedMapConfigs ?? [];
  const registryKeys = new Set(mapConfigs.map((map) => map.key));

  for (const key of Object.keys(config.maps)) {
    if (!registryKeys.has(key)) {
      errors.push(`presentation: map "${key}" is not declared in the map registry`);
    }
  }

  // 装饰规则：mapId 必须在 registry；region（除 "*" 外）必须由该图生成产出。
  // 生成区域集合由 loader 提供（未提供时跳过 region 检查）。
  for (const [mapId, mapRules] of Object.entries(config.decorMaps ?? {})) {
    if (!registryKeys.has(mapId)) {
      errors.push(`presentation: decor map "${mapId}" is not declared in the map registry`);
      continue;
    }
    const knownRegions = gameDef.resolvedMapRegionNames?.get(mapId);
    if (!knownRegions) continue;
    for (const region of Object.keys(mapRules.regions)) {
      if (region === "*") continue;
      if (!knownRegions.has(region)) {
        errors.push(`presentation: decor map "${mapId}" references unknown region "${region}"`);
      }
    }
  }

  // 只有装饰/实体/音频段、没有地图表现内容的配置不做地图覆盖检查
  // （纯 decor.json 可独立加载）。
  const hasMapContract =
    Object.keys(config.maps).length > 0 || Object.keys(config.tileSemantics).length > 0;

  for (const map of hasMapContract ? mapConfigs : []) {
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
  for (const [id, sources] of hasMapContract ? globalRefs : []) {
    if (!config.tileSemantics[String(id)]) {
      errors.push(
        `presentation: global tile semantic ${id} referenced by ${formatSources(sources)} has no definition in tileSemantics`,
      );
    }
  }

  return { ok: errors.length === 0, errors };
}
