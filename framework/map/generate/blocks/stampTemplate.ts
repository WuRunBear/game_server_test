/**
 * 生成积木 "stamp-template"（模板盖印，framework/map/generate/blocks/stampTemplate.ts）。
 *
 * 把一份内联 Tiled JSON 模板盖印到已定尺寸的草稿上（管道后置积木），复用
 * tiled-source 的解析约定（parseDimensions / parseLayers / extractZones）。
 * 三种约定图层全部可选、至少其一：
 * - `ground`（tilelayer）：tile id = 地面语义 id（0~255）→ 覆盖目标矩形
 *   tiles（新约定——tiled-source 的 tiles 恒为 0，此为本积木的关键增量）；
 * - `collision`（tilelayer）：非 0 = 不可通行 → 覆盖目标矩形 walkable
 *   （与 tiled-source 同款取反映射：非 0 → 0，0 → 1）；
 * - `zones`（objectgroup）：type="zone" 且带 properties.zoneId 的对象 →
 *   区域栅格化进 regions：新区域名追加在既有 regions 末尾（Map 插入序即
 *   regionOfTile 索引序），并**只重写被覆盖格**的 regionOfTile（未覆盖格
 *   保持前序积木的区域归属）。同名 zone 对象合并指向同一 regions 键
 *   （首个声明的 zoneId 作 meta）；与既有区域重名时不新增键、不改既有
 *   meta，仅重写覆盖格归属。第一版不做改名映射。
 *
 * 覆盖权：后写覆盖先写（管道顺序即优先级）——ground/collision 整矩形覆盖，
 * zones 覆盖格重写区域归属。框架不解释模板中的其他对象/属性（objects 层
 * 不迁移，与 tiled-source 现状一致）。
 *
 * params 形状（fail-fast 收窄，错误消息点名地图 key 与具体参数）：
 * - `tiled`（内联 Tiled JSON 对象）XOR `tiledPath`——恰填其一；tiledPath 是
 *   加载期约定（loadGameDefinition 读文件内联为 params.tiled），到达本积木
 *   即为未内联，抛错（本积木零文件 I/O）；`path` 参数一律拒绝（tiled-source
 *   同款）；
 * - `at`（模板左上角 tile 坐标）XOR `region`（落点区域名）——恰填其一；
 * - `anchor`（可选）：模板内锚点 tile 坐标，缺省 {0,0}；region 模式下锚点格
 *   对齐选点格（模板原点 = 选点 - anchor），at 模式不使用（at 即左上角）。
 *
 * 落点确定性：region 模式候选 = 从目标区域 tile 池（行主序）按 ctx.rng
 * （deriveStream(seed, stepIndex) 派生流——管道位置索引派生，不连锁，增删
 * 管道步骤不影响其他步骤的流）采样的纯函数；越界候选只过滤、不改序也不
 * 回抽；候选耗尽（含目标区域不存在/零覆盖）= 配置错误 → 抛错（宁可起不来
 * 服务器，不静默跳过）。at 模式不消费 rng。
 *
 * 纯几何生产：不 import ECS/world，不做文件 I/O，不含游戏专属语义。
 */
import { pointInPolygon } from "framework/utils/geometry";
import {
  extractZones,
  parseDimensions,
  parseLayers,
  type ParsedZone,
  type TiledLayer,
  type TiledTileLayer,
} from "map/generate/blocks/tiledSource";
import type { GenerationContext, GeometryDraft } from "map/generate/types";

/** region 模式单次盖印的候选尝试硬上限（与 evolution/placement 同款上限）。 */
const STAMP_MAX_ATTEMPTS = 32;

/** tile 坐标（非负整数）。 */
interface TileCoord {
  x: number;
  y: number;
}

/** 落点声明（at XOR region，恰填其一）。 */
type Placement =
  | { mode: "at"; at: TileCoord }
  | { mode: "region"; region: string };

/** 收窄校验后的积木参数。 */
interface StampTemplateParams {
  /** 内联 Tiled JSON 模板对象。 */
  tiled: Record<string, unknown>;
  /** 落点声明。 */
  placement: Placement;
  /** 模板内锚点 tile 坐标（缺省 {0,0}）。 */
  anchor: TileCoord;
}

/** 抛出点名地图 key 与具体配置项的参数错误。 */
function fail(mapKey: string, detail: string): never {
  throw new Error(`map "${mapKey}": stamp-template params ${detail}`);
}

/** 把 unknown 收窄为普通对象（排除 null 与数组）。 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 校验并取回一个 tile 坐标（非负整数 x/y）。 */
function parseTileCoord(value: unknown, name: string, mapKey: string): TileCoord {
  if (!isRecord(value)) {
    fail(mapKey, `${name} must be a tile position object {x, y}, got ${String(value)}`);
  }
  const x = value.x;
  const y = value.y;
  if (
    typeof x !== "number" ||
    !Number.isInteger(x) ||
    x < 0 ||
    typeof y !== "number" ||
    !Number.isInteger(y) ||
    y < 0
  ) {
    fail(mapKey, `${name} must have non-negative integer x/y, got {x: ${String(x)}, y: ${String(y)}}`);
  }
  return { x, y };
}

/** 校验并取回一个非空区域名。 */
function parseRegionName(value: unknown, mapKey: string): string {
  if (typeof value !== "string" || value.length === 0) {
    fail(mapKey, `region must be a non-empty string, got ${String(value)}`);
  }
  return value;
}

/**
 * 从 ctx.params 收窄积木参数：逐项校验，缺失/非法即抛出点名具体配置项的
 * 错误（消息含地图 key）。
 *
 * @param params 步骤自有参数切片（未校验的外部输入）
 * @param mapKey 地图 key（错误消息定位用）
 * @returns 可信参数形状
 */
function parseParams(params: unknown, mapKey: string): StampTemplateParams {
  if (!isRecord(params)) {
    fail(mapKey, "must be an object");
  }

  // 文件路径形式一律拒绝：内联 JSON 由 loadGameDefinition 在加载期负责读文件
  if (params.path !== undefined) {
    fail(
      mapKey,
      'does not accept a "path" param — inline the Tiled JSON object as params.tiled (the block performs no file I/O)',
    );
  }
  if (params.tiledPath !== undefined) {
    fail(
      mapKey,
      `tiledPath reached the block uninlined (${String(params.tiledPath)}) — it is a load-time convention: loadGameDefinition must inline it as params.tiled (the block performs no file I/O)`,
    );
  }
  if (typeof params.tiled === "string") {
    fail(
      mapKey,
      "tiled must be an inline Tiled JSON object, not a file path — inline the JSON via loadGameDefinition (the block performs no file I/O)",
    );
  }
  if (!isRecord(params.tiled)) {
    fail(mapKey, "tiled is required and must be an inline Tiled JSON object (exactly one of tiled / tiledPath)");
  }

  // at XOR region：恰填其一
  if ((params.at === undefined) === (params.region === undefined)) {
    fail(mapKey, "exactly one of at / region is required (got both or neither)");
  }

  return {
    tiled: params.tiled,
    placement:
      params.at !== undefined
        ? { mode: "at", at: parseTileCoord(params.at, "at", mapKey) }
        : { mode: "region", region: parseRegionName(params.region, mapKey) },
    anchor: params.anchor === undefined ? { x: 0, y: 0 } : parseTileCoord(params.anchor, "anchor", mapKey),
  };
}

/** 按名称查找 tilelayer（首个同名层生效，与 tiled-source 一致）。 */
function findTileLayer(layers: TiledLayer[], name: string): TiledTileLayer | undefined {
  return layers.find((l): l is TiledTileLayer => l.type === "tilelayer" && l.name === name);
}

/** 判断 zones 对象组层是否声明。 */
function hasZonesLayer(layers: TiledLayer[]): boolean {
  return layers.some((l) => l.type === "objectgroup" && l.name === "zones");
}

/**
 * 取约定 tilelayer 的 data 数组（fail-fast：声明了图层就要求完整覆盖模板
 * 矩形的数值数组——不做截断兜底，短数据即配置错误）。
 */
function requireLayerData(
  layers: TiledLayer[],
  name: string,
  templateArea: number,
  mapKey: string,
): number[] | undefined {
  const layer = findTileLayer(layers, name);
  if (!layer) return undefined;
  if (!Array.isArray(layer.data)) {
    fail(mapKey, `params.tiled "${name}" tilelayer must declare a numeric data array`);
  }
  if (layer.data.length < templateArea) {
    fail(
      mapKey,
      `params.tiled "${name}" tilelayer data length ${layer.data.length} < template area ${templateArea} — the layer must cover the whole template rect`,
    );
  }
  return layer.data;
}

/** 校验 ground 数据值域：语义 id 必须是 [0, 255] 整数（tiles 是 Uint8Array）。 */
function validateGroundValues(data: number[], templateArea: number, mapKey: string): void {
  for (let i = 0; i < templateArea; i++) {
    const value = data[i];
    if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > 255) {
      fail(mapKey, `params.tiled ground tilelayer data[${i}] must be an integer in [0, 255], got ${String(value)}`);
    }
  }
}

/** 求区域名在 regions 插入序中的索引（即 regionOfTile 的取值）；未注册返回 -1。 */
function regionIndexOf(draft: GeometryDraft, region: string): number {
  let index = 0;
  for (const name of draft.regions.keys()) {
    if (name === region) return index;
    index += 1;
  }
  return -1;
}

/**
 * region 模式确定性选点：从目标区域 tile 池（行主序，确定性顺序）按
 * ctx.rng 采样候选，锚点格对齐选点格（模板原点 = 选点 - anchor）；越界
 * 候选只过滤（不改序、不回抽）。区域不存在/零覆盖或候选耗尽 = 配置错误
 * → 抛错。
 */
function placeInRegion(
  ctx: GenerationContext,
  region: string,
  anchor: TileCoord,
  templateWidth: number,
  templateHeight: number,
): TileCoord {
  const draft = ctx.geometry;
  const regionIndex = regionIndexOf(draft, region);
  if (regionIndex < 0) {
    throw new Error(
      `map "${ctx.key}": stamp-template target region "${region}" does not exist — regions must be built by a prior pipeline block (climate-regions / tiled-source / earlier template zones)`,
    );
  }

  // 区域 tile 池：行主序收集（确定性顺序，placement.regionTiles 同款技法）
  const pool: number[] = [];
  for (let i = 0; i < draft.regionOfTile.length; i++) {
    if (draft.regionOfTile[i] === regionIndex) pool.push(i);
  }
  if (pool.length === 0) {
    throw new Error(
      `map "${ctx.key}": stamp-template target region "${region}" covers no tiles — nothing to align the template anchor to`,
    );
  }

  for (let attempt = 0; attempt < STAMP_MAX_ATTEMPTS; attempt++) {
    const tileIndex = pool[ctx.rng.int(pool.length)];
    const x = tileIndex % draft.width;
    const y = Math.floor(tileIndex / draft.width);
    const originX = x - anchor.x;
    const originY = y - anchor.y;
    if (
      originX >= 0 &&
      originY >= 0 &&
      originX + templateWidth <= draft.width &&
      originY + templateHeight <= draft.height
    ) {
      return { x: originX, y: originY };
    }
    // 越界候选：只过滤，不改候选序
  }
  throw new Error(
    `map "${ctx.key}": stamp-template candidates exhausted after ${STAMP_MAX_ATTEMPTS} attempts — template ${templateWidth}x${templateHeight} with anchor (${anchor.x}, ${anchor.y}) never fits inside the map ${draft.width}x${draft.height} near region "${region}" tiles; enlarge the region/map or shrink the template`,
  );
}

/**
 * zones 栅格化：新区域名追加在既有 regions 末尾（Map 插入序即索引序），
 * 同名 zone 合并同键（首个声明 zoneId 作 meta；与既有区域重名则沿用既有
 * 键与 meta）；逐模板 tile 以中心点（模板像素空间）做多边形命中判定，
 * 首个命中（声明序）赢，仅重写被覆盖格的 regionOfTile。
 */
function stampZones(
  draft: GeometryDraft,
  zones: ParsedZone[],
  origin: TileCoord,
  templateWidth: number,
  templateHeight: number,
  tileWidth: number,
  tileHeight: number,
): void {
  if (zones.length === 0) return;

  // 区域名 → regions 插入序索引：既有键保持原索引，新键追加在末尾
  const indexByName = new Map<string, number>();
  for (const name of draft.regions.keys()) {
    indexByName.set(name, indexByName.size);
  }
  let nextIndex = draft.regions.size;
  for (const zone of zones) {
    if (indexByName.has(zone.name)) continue;
    draft.regions.set(zone.name, { name: zone.name, meta: { zoneId: zone.zoneId } });
    indexByName.set(zone.name, nextIndex);
    nextIndex += 1;
  }

  // 栅格化：tile 中心点落在多边形内 → 该区域（首个命中优先，声明序）；
  // 未命中格保持前序区域归属不动
  for (let ty = 0; ty < templateHeight; ty++) {
    for (let tx = 0; tx < templateWidth; tx++) {
      const cx = (tx + 0.5) * tileWidth;
      const cy = (ty + 0.5) * tileHeight;
      for (const zone of zones) {
        if (!pointInPolygon(cx, cy, zone.polygon)) continue;
        draft.regionOfTile[(origin.y + ty) * draft.width + origin.x + tx] = indexByName.get(zone.name)!;
        break;
      }
    }
  }
}

/**
 * 生成积木 "stamp-template"：把内联 Tiled 模板盖印到已定尺寸的草稿上。
 *
 * 四层防线中的本积木侧（防线 1 入口自校验 + 防线 2 管道顺序前置）：
 * - 管道顺序：必须在 sizing 积木之后（room-corridor 同款前置检查）；
 *   region 模式额外要求前序积木已建 regions；
 * - 入口自校验：模板矩形不越界、ground 值 ∈ [0,255]、at/region 互斥、
 *   anchor 落在模板内、约定图层至少其一。
 * 防线 3（出口校验：零覆盖/连通性告警）由 validateMapGeometry 兜底，
 * 防线 4（规则 region 引用开机闭环）由 boot 引用校验负责，均不在本积木。
 *
 * @param ctx 生成上下文（params 经 parseParams 收窄校验）
 * @throws Error 当 params 非法、草稿未定尺寸、region 模式前置不满足
 *   （无 regions / 目标区域缺失或零覆盖 / 候选耗尽）、模板矩形越界、
 *   或模板形状畸形（缺 layers、缺约定图层、数据越界等）时——消息均含地图 key
 */
export function stampTemplate(ctx: GenerationContext): void {
  const params = parseParams(ctx.params, ctx.key);
  const draft = ctx.geometry;

  // 防线 2：管道顺序——必须在 sizing 积木之后（room-corridor 同款前置检查）
  const total = draft.width * draft.height;
  if (
    draft.width <= 0 ||
    draft.height <= 0 ||
    draft.tiles.length !== total ||
    draft.walkable.length !== total ||
    draft.regionOfTile.length !== total
  ) {
    throw new Error(
      `map "${ctx.key}": stamp-template requires a sized draft (width*height buffers), got ${draft.width}x${draft.height} with tiles.length ${draft.tiles.length} — a sizing block must run first`,
    );
  }

  // 模板解析：复用 tiled-source 解析约定（尺寸/图层/zone 提取）
  const { width: templateWidth, height: templateHeight, tileWidth: ttWidth, tileHeight: ttHeight } = parseDimensions(
    params.tiled,
    ctx.key,
  );
  const layers = parseLayers(params.tiled, ctx.key);
  const templateArea = templateWidth * templateHeight;

  // 约定图层：全部可选、至少其一（声明即要求 data 完整覆盖模板矩形）
  const groundData = requireLayerData(layers, "ground", templateArea, ctx.key);
  const collisionData = requireLayerData(layers, "collision", templateArea, ctx.key);
  if (!groundData && !collisionData && !hasZonesLayer(layers)) {
    fail(
      ctx.key,
      'params.tiled must declare at least one of the "ground" / "collision" tilelayers or the "zones" objectgroup',
    );
  }
  if (groundData) {
    validateGroundValues(groundData, templateArea, ctx.key);
  }

  // anchor 是模板内 tile 坐标：必须落在模板矩形内
  if (params.anchor.x >= templateWidth || params.anchor.y >= templateHeight) {
    fail(
      ctx.key,
      `anchor (${params.anchor.x}, ${params.anchor.y}) must be inside the template rect ${templateWidth}x${templateHeight}`,
    );
  }

  // 落点：at 模式精确放置（不消费 rng）；region 模式确定性选点
  let origin: TileCoord;
  if (params.placement.mode === "at") {
    origin = params.placement.at;
    // 防线 1：模板矩形不越界
    if (origin.x + templateWidth > draft.width || origin.y + templateHeight > draft.height) {
      fail(
        ctx.key,
        `template rect ${templateWidth}x${templateHeight} at (${origin.x}, ${origin.y}) exceeds map bounds ${draft.width}x${draft.height}`,
      );
    }
  } else {
    // 防线 1：region 模式要求前序积木已建 regions
    if (draft.regions.size === 0) {
      throw new Error(
        `map "${ctx.key}": stamp-template region mode requires regions built by a prior pipeline block (climate-regions / tiled-source), but regions is empty`,
      );
    }
    origin = placeInRegion(ctx, params.placement.region, params.anchor, templateWidth, templateHeight);
  }

  // 盖印：ground / collision 整矩形覆盖（后写覆盖先写），zones 追加 + 重写覆盖格
  if (groundData) {
    for (let ty = 0; ty < templateHeight; ty++) {
      for (let tx = 0; tx < templateWidth; tx++) {
        draft.tiles[(origin.y + ty) * draft.width + origin.x + tx] = groundData[ty * templateWidth + tx];
      }
    }
  }
  if (collisionData) {
    for (let ty = 0; ty < templateHeight; ty++) {
      for (let tx = 0; tx < templateWidth; tx++) {
        draft.walkable[(origin.y + ty) * draft.width + origin.x + tx] = collisionData[ty * templateWidth + tx] ? 0 : 1;
      }
    }
  }
  stampZones(draft, extractZones(layers), origin, templateWidth, templateHeight, ttWidth, ttHeight);
}

/**
 * 收集内联 Tiled 模板 zones 层产出的区域名（与积木生成期同源解析，供
 * 加载期引用完整性校验复用——校验侧不重复实现 zone → 区域名推导）。
 * 同名 zone 只计一次（首声明序，与积木的同键合并语义一致）。
 *
 * @param tiled 内联 Tiled JSON 对象（未校验的外部输入）
 * @param key 地图 key（错误消息点名）
 * @returns 按首声明顺序去重后的区域名列表
 * @throws Error 当 Tiled JSON 形状畸形时（与积木生成期抛出同一错误）
 */
export function stampTemplateRegionNames(tiled: unknown, key: string): string[] {
  if (!isRecord(tiled)) {
    fail(key, "tiled is required and must be an inline Tiled JSON object");
  }
  const names: string[] = [];
  const seen = new Set<string>();
  for (const zone of extractZones(parseLayers(tiled, key))) {
    if (!seen.has(zone.name)) {
      seen.add(zone.name);
      names.push(zone.name);
    }
  }
  return names;
}
