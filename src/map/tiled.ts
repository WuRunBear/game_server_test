import type { MapRuntime, MapZone, Vec2 } from "map/types";

type TiledLayer =
  | {
      type: "tilelayer";
      name: string;
      width: number;
      height: number;
      data?: number[];
    }
  | {
      type: "objectgroup";
      name: string;
      objects?: Array<{
        id: number;
        name?: string;
        type?: string;
        x: number;
        y: number;
        width?: number;
        height?: number;
        polygon?: Array<{ x: number; y: number }>;
        properties?: Array<{ name: string; type: string; value: unknown }>;
      }>;
    };

type TiledMap = {
  width: number;
  height: number;
  tilewidth: number;
  tileheight: number;
  layers?: TiledLayer[];
};

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
function getProp(
  props: Array<{ name: string; type: string; value: unknown }> | undefined,
  name: string,
): unknown {
  if (!props) return undefined;
  return props.find((p) => p.name === name)?.value;
}

/**
 * 创建一个全空的阻挡网格（0=可走，1=阻挡）。
 *
 * @param width 网格宽度
 * @param height 网格高度
 * @returns Uint8Array 阻挡数据
 */
function emptyBlocked(width: number, height: number): Uint8Array {
  return new Uint8Array(width * height);
}

/**
 * 从 Tiled 地图中解析 collision 图层，生成阻挡网格。
 *
 * @param map Tiled 地图
 * @returns Uint8Array 阻挡数据（0=可走，1=阻挡）
 */
function parseCollision(map: TiledMap): Uint8Array {
  const layers = map.layers ?? [];
  const collision = layers.find((l): l is Extract<TiledLayer, { type: "tilelayer" }> => {
    return l.type === "tilelayer" && l.name === "collision";
  });

  if (!collision || !collision.data) return emptyBlocked(map.width, map.height);

  const out = new Uint8Array(map.width * map.height);
  const len = Math.min(out.length, collision.data.length);
  for (let i = 0; i < len; i++) out[i] = collision.data[i] ? 1 : 0;
  return out;
}

/**
 * 从 Tiled 地图中解析 zones 对象层，生成区域多边形列表。
 *
 * @param map Tiled 地图
 * @returns MapZone 列表
 */
function parseZones(map: TiledMap): MapZone[] {
  const zones: MapZone[] = [];
  const layers = map.layers ?? [];
  const zoneLayer = layers.find((l): l is Extract<TiledLayer, { type: "objectgroup" }> => {
    return l.type === "objectgroup" && l.name === "zones";
  });
  if (!zoneLayer?.objects) return zones;

  for (const obj of zoneLayer.objects) {
    const type = obj.type ?? "";
    if (type !== "zone") continue;

    const zoneId = asNumber(getProp(obj.properties, "zoneId"));
    if (zoneId === null) continue;

    const name = asString(getProp(obj.properties, "name")) ?? obj.name ?? `zone_${zoneId}`;
    const polygon: Vec2[] = [];

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

    zones.push({ id: zoneId, name, polygon });
  }

  return zones;
}

/**
 * 从 Tiled 地图中解析 objects 对象层，生成玩家/NPC 的出生点信息。
 *
 * @param map Tiled 地图
 * @returns MapRuntime.spawns
 */
function parseSpawns(map: TiledMap): MapRuntime["spawns"] {
  const layers = map.layers ?? [];
  const objectsLayer = layers.find((l): l is Extract<TiledLayer, { type: "objectgroup" }> => {
    return l.type === "objectgroup" && l.name === "objects";
  });

  let player: Vec2 | null = null;
  const npcs: Array<{ kind: string; pos: Vec2; zoneId?: number }> = [];

  for (const obj of objectsLayer?.objects ?? []) {
    const type = obj.type ?? "";

    if (type === "spawn_player") {
      player = { x: obj.x, y: obj.y };
      continue;
    }

    if (type === "spawn_npc") {
      const kind = asString(getProp(obj.properties, "npcKind")) ?? "npc";
      const zoneId = asNumber(getProp(obj.properties, "zoneId")) ?? undefined;
      npcs.push({ kind, pos: { x: obj.x, y: obj.y }, zoneId });
    }
  }

  return { player, npcs };
}

/**
 * 将 Tiled JSON 转换为运行时 MapRuntime。
 *
 * @param id 地图 id
 * @param name 地图名称
 * @param json Tiled 导出的 JSON（unknown）
 * @returns MapRuntime
 */
export function mapRuntimeFromTiled(id: string, name: string, json: unknown): MapRuntime {
  const map = json as Partial<TiledMap>;
  const width = asNumber(map.width) ?? 0;
  const height = asNumber(map.height) ?? 0;
  const tileWidth = asNumber(map.tilewidth) ?? 1;
  const tileHeight = asNumber(map.tileheight) ?? 1;

  const safeWidth = Math.max(1, Math.floor(width));
  const safeHeight = Math.max(1, Math.floor(height));

  const tiled: TiledMap = {
    width: safeWidth,
    height: safeHeight,
    tilewidth: tileWidth,
    tileheight: tileHeight,
    layers: (map.layers ?? []) as TiledLayer[],
  };

  return {
    id,
    name,
    grid: {
      width: tiled.width,
      height: tiled.height,
      tileWidth: tiled.tilewidth,
      tileHeight: tiled.tileheight,
    },
    blocked: parseCollision(tiled),
    spawns: parseSpawns(tiled),
    zones: parseZones(tiled),
  };
}
