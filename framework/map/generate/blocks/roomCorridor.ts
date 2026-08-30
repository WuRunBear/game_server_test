/**
 * 生成积木 room-corridor（framework/map/generate/blocks/roomCorridor.ts）。
 *
 * 地形级房间走廊雕挖：随机放置互不重叠（至少 1 格间隔）的房间
 * （planRooms），经并查集（Kruskal：全对候选边按距离升序，只雕挖
 * 合并分量的边）把全部房间用 L 形走廊连通，再把房间与走廊格雕挖为
 * floorTile + walkable=1。其余格子保持原样——墙壁就是"未被雕挖的
 * 地面"，不产出任何实体/挂点/结构（结构归演化层 template 规则）。
 *
 * 供洞穴类地图在 noise-terrain 之后叠用：上游积木先铺岩体等地貌，
 * 本积木只把房间与走廊格改写为地面语义。solidTile 仅声明岩体语义 id
 * 供配置表达与参数校验（须与 floorTile 不同），本积木不写它。
 * 确定性：全部随机性来自 ctx.rng（管道派生流），同 seed 同参数产出
 * 深相等的 tiles/walkable。
 */

import type { Rng } from "map/generate/rng";
import type { GenerationContext, GeometryDraft } from "map/generate/types";

/** room-corridor 积木参数（game 配置中该步骤的 params 切片）。 */
export interface RoomCorridorParams {
  /** 房间数量（整数 ≥ 0；0 = 不雕挖任何格子）。 */
  roomCount: number;
  /** 房间最小边长（tile 数，整数 ≥ 1）。 */
  minRoomSize: number;
  /** 房间最大边长（tile 数，整数 ≥ minRoomSize）。 */
  maxRoomSize: number;
  /** 走廊宽度（tile 数，整数 ≥ 1）。 */
  corridorWidth: number;
  /** 雕挖目标：地面语义 id（房间与走廊格写入该值，0–255）。 */
  floorTile: number;
  /** 岩体语义 id（0–255；未雕挖格保持上游输出，本积木不写该值）。 */
  solidTile: number;
}

/** 房间矩形（tile 坐标，x/y 为左上角，行主序网格内）。 */
export interface RoomRect {
  /** 左上角列（tile 坐标）。 */
  x: number;
  /** 左上角行（tile 坐标）。 */
  y: number;
  /** 房间宽度（tile 数）。 */
  width: number;
  /** 房间高度（tile 数）。 */
  height: number;
}

/** 单个房间的随机放置尝试次数（耗尽则少放一个房间，总数可少于 roomCount）。 */
const PLACEMENT_ATTEMPTS = 20;

/** 语义 id 上界：tiles 缓冲是 Uint8Array，语义 id 必须落在单字节内。 */
const MAX_SEMANTIC_ID = 255;

/** 参数错误统一出口：消息含地图 key 与具体参数名。 */
function fail(mapKey: string, message: string): never {
  throw new Error(`map "${mapKey}": room-corridor ${message}`);
}

/** 错误消息中的值展示：字符串加引号，与其余值原样字符串化。 */
function display(value: unknown): string {
  return typeof value === "string" ? JSON.stringify(value) : String(value);
}

/** 要求整数值（可选上下界），不满足即抛含参数名的错误。 */
function requireInt(mapKey: string, name: string, value: unknown, min: number, max?: number): number {
  if (typeof value !== "number" || !Number.isInteger(value)) {
    fail(mapKey, `params.${name} must be an integer, got ${display(value)}`);
  }
  if (value < min || (max !== undefined && value > max)) {
    const range = max === undefined ? `>= ${min}` : `in [${min}, ${max}]`;
    fail(mapKey, `params.${name} must be an integer ${range}, got ${display(value)}`);
  }
  return value;
}

/**
 * 把 ctx.params（unknown）收窄为 RoomCorridorParams，非法即抛含地图
 * key 与参数名的清晰错误。
 *
 * @param params 步骤自有参数切片（未声明时为空对象）
 * @param mapKey 地图 key（进错误消息）
 * @returns 收窄后的参数
 */
export function parseRoomCorridorParams(params: unknown, mapKey: string): RoomCorridorParams {
  if (typeof params !== "object" || params === null) {
    fail(mapKey, `params must be an object with roomCount/minRoomSize/maxRoomSize/corridorWidth/floorTile/solidTile, got ${display(params)}`);
  }
  const raw = params as Record<string, unknown>;
  const roomCount = requireInt(mapKey, "roomCount", raw.roomCount, 0);
  const minRoomSize = requireInt(mapKey, "minRoomSize", raw.minRoomSize, 1);
  const maxRoomSize = requireInt(mapKey, "maxRoomSize", raw.maxRoomSize, minRoomSize);
  const corridorWidth = requireInt(mapKey, "corridorWidth", raw.corridorWidth, 1);
  const floorTile = requireInt(mapKey, "floorTile", raw.floorTile, 0, MAX_SEMANTIC_ID);
  const solidTile = requireInt(mapKey, "solidTile", raw.solidTile, 0, MAX_SEMANTIC_ID);
  if (floorTile === solidTile) {
    fail(mapKey, `params.floorTile and params.solidTile must be different semantic ids, both are ${floorTile}`);
  }
  return { roomCount, minRoomSize, maxRoomSize, corridorWidth, floorTile, solidTile };
}

/** 两房间（各自外扩 1 格后）相交 = 间距不足 1 格岩墙。 */
function tooClose(a: RoomRect, b: RoomRect): boolean {
  return a.x <= b.x + b.width && b.x <= a.x + a.width
    && a.y <= b.y + b.height && b.y <= a.y + a.height;
}

/**
 * 纯函数：随机放置房间矩形（不雕挖）。
 *
 * 每房间最多 PLACEMENT_ATTEMPTS 次尝试：尺寸在 [minRoomSize, maxRoomSize]
 * 内随机（超出地图尺寸时钳到地图边，保证可放置），位置均匀随机，与已有
 * 房间间距不足 1 格则重试，耗尽则放弃该房间（放置总数可少于 roomCount）。
 * 地图尺寸 ≥ minRoomSize 时首房间必放置，故 rooms 为空 ⟺ 地图放不下
 * 最小房间（由积木抛错）。同 rng 同参数序列确定。
 *
 * @param rng 随机流（管道派生流）
 * @param params 收窄后的积木参数
 * @param width 地图宽度（tile 数）
 * @param height 地图高度（tile 数）
 * @returns 放置的房间矩形（按放置顺序）
 */
export function planRooms(rng: Rng, params: RoomCorridorParams, width: number, height: number): RoomRect[] {
  const rooms: RoomRect[] = [];
  const sizeSpan = params.maxRoomSize - params.minRoomSize;
  for (let i = 0; i < params.roomCount; i++) {
    for (let attempt = 0; attempt < PLACEMENT_ATTEMPTS; attempt++) {
      const w = Math.min(params.minRoomSize + rng.int(sizeSpan + 1), width);
      const h = Math.min(params.minRoomSize + rng.int(sizeSpan + 1), height);
      if (w < params.minRoomSize || h < params.minRoomSize) {
        continue; // 地图放不下最小房间（宽或高 < minRoomSize）
      }
      const candidate: RoomRect = {
        x: rng.int(width - w + 1),
        y: rng.int(height - h + 1),
        width: w,
        height: h,
      };
      if (!rooms.some((room) => tooClose(room, candidate))) {
        rooms.push(candidate);
        break;
      }
    }
  }
  return rooms;
}

/** 并查集（路径减半）：Kruskal 选边时合并房间分量。 */
function makeUnionFind(size: number): { union(a: number, b: number): boolean } {
  const parent: number[] = Array.from({ length: size }, (_, i) => i);
  const find = (a: number): number => {
    while (parent[a] !== a) {
      parent[a] = parent[parent[a]];
      a = parent[a];
    }
    return a;
  };
  return {
    union: (a, b) => {
      const rootA = find(a);
      const rootB = find(b);
      if (rootA === rootB) {
        return false;
      }
      parent[rootA] = rootB;
      return true;
    },
  };
}

/** 候选走廊边：房间对 + 中心距离平方（排序键，避免开方）。 */
interface CorridorEdge {
  a: number;
  b: number;
  distSq: number;
}

/** 全对候选边按（距离, 序号对）升序——完全图必有生成树，Kruskal 终态全连通。 */
function buildCorridorEdges(rooms: RoomRect[]): CorridorEdge[] {
  const edges: CorridorEdge[] = [];
  for (let i = 0; i < rooms.length; i++) {
    for (let j = i + 1; j < rooms.length; j++) {
      const dx = rooms[i].x - rooms[j].x;
      const dy = rooms[i].y - rooms[j].y;
      edges.push({ a: i, b: j, distSq: dx * dx + dy * dy });
    }
  }
  edges.sort((e1, e2) => e1.distSq - e2.distSq || e1.a - e2.a || e1.b - e2.b);
  return edges;
}

/** 房间中心（tile 坐标，取整保持走廊落在格线上）。 */
function centerOf(room: RoomRect): { x: number; y: number } {
  return { x: room.x + (room.width >> 1), y: room.y + (room.height >> 1) };
}

/** 雕挖矩形区域（钳到地图边界内）：tiles=floorTile、walkable=1。 */
function carveRect(draft: GeometryDraft, x: number, y: number, w: number, h: number, floorTile: number): void {
  const x0 = Math.max(0, x);
  const y0 = Math.max(0, y);
  const x1 = Math.min(draft.width - 1, x + w - 1);
  const y1 = Math.min(draft.height - 1, y + h - 1);
  for (let ty = y0; ty <= y1; ty++) {
    for (let tx = x0; tx <= x1; tx++) {
      const index = ty * draft.width + tx;
      draft.tiles[index] = floorTile;
      draft.walkable[index] = 1;
    }
  }
}

/**
 * 雕挖 L 形走廊（中心到中心，先横后竖或先竖后横）：每段为以路径线为
 * 基准、corridorWidth 厚（向左/上偏移 floor((w-1)/2) 居中）的矩形。
 * 两段共享拐角格，路径全雕 → 走廊连通两端房间内部（中心在房间内）。
 */
function carveCorridor(
  draft: GeometryDraft,
  from: { x: number; y: number },
  to: { x: number; y: number },
  corridorWidth: number,
  floorTile: number,
  horizontalFirst: boolean,
): void {
  const off = (corridorWidth - 1) >> 1;
  if (horizontalFirst) {
    // 先横（沿 from.y）后竖（沿 to.x），共享拐角格 (to.x, from.y)
    carveRect(draft, Math.min(from.x, to.x), from.y - off, Math.abs(from.x - to.x) + 1, corridorWidth, floorTile);
    carveRect(draft, to.x - off, Math.min(from.y, to.y), corridorWidth, Math.abs(from.y - to.y) + 1, floorTile);
  } else {
    // 先竖（沿 from.x）后横（沿 to.y），共享拐角格 (from.x, to.y)
    carveRect(draft, from.x - off, Math.min(from.y, to.y), corridorWidth, Math.abs(from.y - to.y) + 1, floorTile);
    carveRect(draft, Math.min(from.x, to.x), to.y - off, Math.abs(from.x - to.x) + 1, corridorWidth, floorTile);
  }
}

/**
 * room-corridor 生成积木：在已定尺寸的草稿上雕挖互相连通的房间与走廊。
 *
 * @param ctx 生成上下文（params 经 parseRoomCorridorParams 收窄）
 * @throws Error 当 params 非法、草稿未定尺寸（含缓冲长度不符）、或地图
 *   尺寸小于 minRoomSize 导致无法放置任何房间时——消息均含地图 key
 */
export function roomCorridor(ctx: GenerationContext): void {
  const params = parseRoomCorridorParams(ctx.params, ctx.key);
  const draft = ctx.geometry;
  const total = draft.width * draft.height;
  if (draft.width <= 0 || draft.height <= 0 || draft.tiles.length !== total || draft.walkable.length !== total) {
    throw new Error(
      `map "${ctx.key}": room-corridor requires a sized draft (width*height buffers), got ${draft.width}x${draft.height} with tiles.length ${draft.tiles.length} — a sizing block must run first`,
    );
  }

  const rooms = planRooms(ctx.rng, params, draft.width, draft.height);
  if (params.roomCount > 0 && rooms.length === 0) {
    throw new Error(
      `map "${ctx.key}": room-corridor cannot place any room: grid ${draft.width}x${draft.height} is smaller than minRoomSize ${params.minRoomSize}`,
    );
  }

  for (const room of rooms) {
    carveRect(draft, room.x, room.y, room.width, room.height, params.floorTile);
  }

  // 走廊连通：全对候选边按距离升序 + 并查集（Kruskal）——只雕挖合并
  // 分量的边，终态全部房间同分量，房间互相连通由此保证
  const unionFind = makeUnionFind(rooms.length);
  for (const edge of buildCorridorEdges(rooms)) {
    if (!unionFind.union(edge.a, edge.b)) {
      continue;
    }
    const horizontalFirst = ctx.rng.int(2) === 0;
    carveCorridor(draft, centerOf(rooms[edge.a]), centerOf(rooms[edge.b]), params.corridorWidth, params.floorTile, horizontalFirst);
  }
}
