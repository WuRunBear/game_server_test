/**
 * "tiled-source" 生成积木：把内联的 Tiled（2D 地图编辑器）导出 JSON 解析为
 * 生成层几何草稿（GeometryDraft）。
 *
 * 能力迁移自 framework/map/tiled.ts（mapRuntimeFromTiled 的纯解析部分，D12：
 * Tiled 导入降级为普通生成积木，**不增强**——解析的图层/对象类型与旧实现
 * 完全一致，不新增任何 Tiled 功能）。对应关系：
 * - `collision`（tilelayer）：非 0 tile → 不可通行（walkable=0），0 → 可通行
 *   （旧实现产出 blocked=1/0，此处取反为 walkable 位图，语义等价）；
 * - `zones`（objectgroup）：type="zone" 且带 properties.zoneId 的对象 → 命名
 *   区域（有 polygon 用多边形顶点，否则退回矩形兜底，与旧实现一致），按
 *   **声明顺序**写入 regions（插入顺序即 regionOfTile 索引序），并按
 *   「tile 中心点落在多边形内」栅格化进 regionOfTile（首个命中的区域优先）；
 * - `objects`（objectgroup）：旧实现解析出生点（spawn_player/spawn_npc）——
 *   出生点属实体层语义，新几何模型（GeometryDraft）不承载，故**不迁移**
 *   （出生点由演化层/实体规则负责）。
 *
 * 输入约定：params.tiled 必须是**内联的 Tiled JSON 对象**（由
 * loadGameDefinition 在加载期读文件内联进配置）——本积木不做任何文件 I/O，
 * 拒绝 path 形式的参数。Tiled 导入完全由其 JSON 决定，不使用 ctx.rng。
 *
 * 区域兜底：不被任何 zone 覆盖的格子指向隐式兜底区 "wilderness"（追加在
 * 全部 zone 之后；若某 zone 已占用该名字，则该 zone 即兜底区）——几何模型
 * 要求每格区域索引可解析。
 *
 * 语言保持游戏无关：只描述网格/图层/区域，不引入任何游戏专属语义。
 */
import { pointInPolygon } from "framework/utils/geometry";
import { WILDERNESS } from "map/generate/blocks/climateRegions";
import type { GenerationContext } from "map/generate/types";

/** Tiled 对象的自定义属性（名称 / 类型 / 值）。 */
type TiledProperty = { name: string; type: string; value: unknown };

/** Tiled 对象层中的一个对象（区域、出生点、装饰等）。 */
type TiledObject = {
  /** 对象自增 id（本模块不直接使用）。 */
  id: number;
  /** 对象名称（可作区域名称的兜底）。 */
  name?: string;
  /** 对象类型（如 "zone"）。 */
  type?: string;
  /** 左上角 X 坐标（像素）。 */
  x: number;
  /** 左上角 Y 坐标（像素）。 */
  y: number;
  /** 宽度（像素，矩形对象）。 */
  width?: number;
  /** 高度（像素，矩形对象）。 */
  height?: number;
  /** 多边形顶点（相对对象原点的偏移列表）。 */
  polygon?: Array<{ x: number; y: number }>;
  /** 自定义属性列表。 */
  properties?: TiledProperty[];
};

/** Tiled 网格图层（data 为按行展平的 tile id 数组，0 表示空 tile）。 */
type TiledTileLayer = {
  type: "tilelayer";
  name: string;
  width: number;
  height: number;
  data?: number[];
};

/** Tiled 对象组图层（objects 为对象列表）。 */
type TiledObjectGroupLayer = {
  type: "objectgroup";
  name: string;
  objects?: TiledObject[];
};

/** 图层联合类型（tile 网格 或 对象组）。 */
type TiledLayer = TiledTileLayer | TiledObjectGroupLayer;

/** Tiled 导出 JSON 的顶层结构（只取本模块关心的字段）。 */
type TiledMap = {
  width: number;
  height: number;
  tilewidth: number;
  tileheight: number;
  layers: TiledLayer[];
};

/** 解析后的区域（写入 regions 前的中间形态）。 */
type ParsedZone = {
  /** 区域名（regions Map 的键）。 */
  name: string;
  /** Tiled zoneId（保留进 RegionMeta.meta，供下游引用）。 */
  zoneId: number;
  /** 区域多边形顶点（世界像素坐标）。 */
  polygon: Array<{ x: number; y: number }>;
};

/**
 * 把 unknown 收窄为普通对象（排除 null 与数组）。
 *
 * @param value 任意值
 * @returns 是否为普通对象
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * 把 unknown 转为 number（有限数）或返回 null。
 *
 * @param value 任意值
 * @returns number 或 null
 */
function asNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/**
 * 把 unknown 转为 string 或返回 null。
 *
 * @param value 任意值
 * @returns string 或 null
 */
function asString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

/**
 * 从 Tiled 对象属性列表中读取指定名称的属性值。
 *
 * @param props 属性数组
 * @param name 属性名
 * @returns 属性值；不存在时返回 undefined
 */
function getProp(props: TiledProperty[] | undefined, name: string): unknown {
  if (!props) return undefined;
  return props.find((p) => p.name === name)?.value;
}

/**
 * 校验并归一化 Tiled 顶层尺寸字段（迁移自 mapRuntimeFromTiled 的尺寸读取，
 * 由「静默兜底」改为「畸形即抛错」）。
 *
 * @param map 内联 Tiled JSON 对象
 * @param key 地图 key（错误消息用）
 * @returns 归一化后的 width/height（≥1 的整数）与 tileWidth/tileHeight
 */
function parseDimensions(
  map: Record<string, unknown>,
  key: string,
): { width: number; height: number; tileWidth: number; tileHeight: number } {
  const width = asNumber(map.width);
  const height = asNumber(map.height);
  // 旧实现对缺失/非法尺寸静默钳到 1；积木侧为配置边界，畸形即抛错
  if (width === null || height === null || Math.floor(width) < 1 || Math.floor(height) < 1) {
    throw new Error(
      `map "${key}": params.tiled has invalid map dimensions (width=${String(map.width)}, height=${String(map.height)}; expected finite numbers >= 1)`,
    );
  }

  // tile 像素尺寸：缺省回退 1（与旧实现一致）；显式给出但非法则抛错
  const tileWidth = map.tilewidth === undefined ? 1 : asNumber(map.tilewidth);
  const tileHeight = map.tileheight === undefined ? 1 : asNumber(map.tileheight);
  if (tileWidth === null || tileHeight === null || tileWidth <= 0 || tileHeight <= 0) {
    throw new Error(
      `map "${key}": params.tiled has invalid tile size (tilewidth=${String(map.tilewidth)}, tileheight=${String(map.tileheight)}; expected finite numbers > 0)`,
    );
  }

  return {
    width: Math.floor(width),
    height: Math.floor(height),
    tileWidth,
    tileHeight,
  };
}

/**
 * 校验并取出 layers 数组（旧实现缺省视为空数组；积木侧按畸形输入抛错）。
 *
 * @param map 内联 Tiled JSON 对象
 * @param key 地图 key（错误消息用）
 * @returns 校验后的图层数组
 */
function parseLayers(map: Record<string, unknown>, key: string): TiledLayer[] {
  const layers = map.layers;
  if (!Array.isArray(layers)) {
    throw new Error(`map "${key}": params.tiled is missing a "layers" array`);
  }
  for (const layer of layers) {
    if (!isRecord(layer)) {
      throw new Error(`map "${key}": params.tiled.layers contains a non-object entry`);
    }
  }
  return layers as TiledLayer[];
}

/**
 * 从 Tiled 地图中解析 zones 对象层（迁移自 tiled.ts parseZones，逻辑一致）。
 *
 * @param layers 图层数组
 * @param key 地图 key（错误消息用）
 * @returns 按声明顺序排列的区域列表
 * @throws Error 当两个 zone 对象解析出相同区域名时（新模型以名字为区域键，
 *   重名无法表达，按畸形输入拒绝）
 */
function parseZones(layers: TiledLayer[], key: string): ParsedZone[] {
  const zones: ParsedZone[] = [];
  const zoneLayer = layers.find((l): l is TiledObjectGroupLayer => {
    return l.type === "objectgroup" && l.name === "zones";
  });
  if (!zoneLayer?.objects) return zones;

  for (const obj of zoneLayer.objects) {
    const type = obj.type ?? "";
    if (type !== "zone") continue;

    const zoneId = asNumber(getProp(obj.properties, "zoneId"));
    if (zoneId === null) continue;

    const name = asString(getProp(obj.properties, "name")) ?? obj.name ?? `zone_${zoneId}`;
    if (zones.some((z) => z.name === name)) {
      throw new Error(`map "${key}": params.tiled zones layer has duplicate zone name "${name}"`);
    }

    const polygon: Array<{ x: number; y: number }> = [];
    if (obj.polygon && obj.polygon.length > 0) {
      for (const p of obj.polygon) polygon.push({ x: obj.x + p.x, y: obj.y + p.y });
    } else {
      const w = obj.width ?? 0;
      const h = obj.height ?? 0;
      polygon.push({ x: obj.x, y: obj.y });
      polygon.push({ x: obj.x + w, y: obj.y });
      polygon.push({ x: obj.x + w, y: obj.y + h });
      polygon.push({ x: obj.x, y: obj.y + h });
    }

    zones.push({ name, zoneId, polygon });
  }

  return zones;
}

/**
 * 收集内联 Tiled JSON 的 zones 层产出的区域名（与积木生成期同源解析，供
 * 加载期引用完整性校验复用——校验侧不重复实现 zone → 区域名推导）。
 *
 * @param tiled 内联 Tiled JSON 对象（未校验的外部输入）
 * @param key 地图 key（错误消息点名）
 * @returns 按声明顺序排列的区域名列表
 * @throws Error 当 Tiled JSON 形状畸形时（与积木生成期抛出同一错误）
 */
export function tiledRegionNames(tiled: unknown, key: string): string[] {
  if (!isRecord(tiled)) {
    throw new Error(`map "${key}": params.tiled is required and must be an inline Tiled JSON object`);
  }
  return parseZones(parseLayers(tiled, key), key).map((z) => z.name);
}

/**
 * "tiled-source" 生成积木：内联 Tiled JSON → 几何草稿。
 *
 * 无条件设定 draft 尺寸并重新分配 tiles/walkable/regionOfTile 缓冲（Tiled
 * JSON 完全决定地图，作为管道首个/唯一来源积木使用）；不使用 ctx.rng。
 *
 * params 形状：
 * - `tiled`（必填）：内联的 Tiled 导出 JSON 对象；
 * - `path`：**不允许**——本积木不做文件 I/O，给出即抛错。
 *
 * @param ctx 生成积木执行上下文
 * @throws Error 当 params 缺失/为 path 形式，或 Tiled JSON 形状畸形
 *   （缺 layers、尺寸越界、zone 重名等）时——消息含地图 key
 */
export function tiledSource(ctx: GenerationContext): void {
  const params = isRecord(ctx.params) ? ctx.params : {};

  // 文件路径形式一律拒绝：内联 JSON 由 loadGameDefinition 在加载期负责读文件
  if (params.path !== undefined) {
    throw new Error(
      `map "${ctx.key}": tiled-source block does not accept a "path" param — inline the Tiled JSON object as params.tiled (the block performs no file I/O)`,
    );
  }
  if (typeof params.tiled === "string") {
    throw new Error(
      `map "${ctx.key}": params.tiled must be an inline Tiled JSON object, not a file path — inline the JSON via loadGameDefinition (the block performs no file I/O)`,
    );
  }
  if (!isRecord(params.tiled)) {
    throw new Error(
      `map "${ctx.key}": params.tiled is required and must be an inline Tiled JSON object`,
    );
  }

  const tiled = params.tiled;
  const { width, height, tileWidth, tileHeight } = parseDimensions(tiled, ctx.key);
  const layers = parseLayers(tiled, ctx.key);

  // 尺寸与缓冲：行主序，长度 = width × height
  const total = width * height;
  const geometry = ctx.geometry;
  geometry.width = width;
  geometry.height = height;
  geometry.tileWidth = tileWidth;
  geometry.tileHeight = tileHeight;
  geometry.tiles = new Uint8Array(total);
  geometry.walkable = new Uint8Array(total).fill(1);
  geometry.regionOfTile = new Uint16Array(total);

  // collision tilelayer → walkable 位图（旧实现产出 blocked，此处取反，语义等价：
  // blocked=1 ⟺ walkable=0）。缺失 collision 层或 data → 全可走；数据短于网格时
  // 剩余格保持可走（Math.min 截断语义与旧实现一致）。
  const collision = layers.find((l): l is TiledTileLayer => {
    return l.type === "tilelayer" && l.name === "collision";
  });
  if (collision?.data) {
    const len = Math.min(total, collision.data.length);
    for (let i = 0; i < len; i++) geometry.walkable[i] = collision.data[i] ? 0 : 1;
  }

  // Tiled 导入不携带地面语义信息（旧解析只从 collision 层读布尔阻挡），
  // tiles 恒为 0（默认地面语义；语义 id 含义映射在 game 配置）。

  // zones objectgroup → 命名区域：声明顺序写入 regions（插入顺序即索引序）
  const zones = parseZones(layers, ctx.key);
  for (const zone of zones) {
    geometry.regions.set(zone.name, { name: zone.name, meta: { zoneId: zone.zoneId } });
  }

  // 兜底区：不被任何 zone 覆盖的格子必须指向可解析的区域索引——追加隐式
  // "wilderness"（若某 zone 已占用该名字，则该 zone 即兜底区）
  let fallbackIndex = zones.findIndex((z) => z.name === WILDERNESS);
  if (fallbackIndex < 0) {
    fallbackIndex = zones.length;
    geometry.regions.set(WILDERNESS, { name: WILDERNESS, meta: {} });
  }

  // 栅格化：tile 中心点（像素）落在多边形内 → 该区域；首个命中优先（声明序），
  // 无命中 → 兜底区
  for (let ty = 0; ty < height; ty++) {
    for (let tx = 0; tx < width; tx++) {
      const cx = (tx + 0.5) * tileWidth;
      const cy = (ty + 0.5) * tileHeight;
      let regionIndex = fallbackIndex;
      for (let zi = 0; zi < zones.length; zi++) {
        if (pointInPolygon(cx, cy, zones[zi].polygon)) {
          regionIndex = zi;
          break;
        }
      }
      geometry.regionOfTile[ty * width + tx] = regionIndex;
    }
  }
}
