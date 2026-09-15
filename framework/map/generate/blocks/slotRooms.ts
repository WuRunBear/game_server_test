/**
 * 生成积木 "slot-rooms"（framework/map/generate/blocks/slotRooms.ts）。
 *
 * 槽位网格房间布局积木（锚点式布局，连通性由构造保证）：
 * - 整图划分为 slotsX × slotsY 个槽位（每槽 cellW × cellH tile），
 *   本积木是**管道首积木（sizing）**：设定 draft 尺寸并分配缓冲，
 *   tiles 全部初始化为 solidTile、walkable 全 0；
 * - **主路径**：从左缘随机行出发的随机游走，每步向右（权重 2）或上/下、
 *   从不向左，到达右缘结束——主路径房间数恒 = slotsX，类型依次为
 *   path-first → path-mid… → path-last（末房使用更大的固定尺寸）；
 * - **支线**：至多 branchCount 次尝试，从主路径中段房间（不含首尾）向
 *   四方向空槽挂出，类型从配置的类型序列循环取用（不配置则用结构名）；
 * - **走廊**：主路径相邻房间之间、支线房与源房之间连 L 形走廊
 *   （中心到中心，方向随机），走廊格归属出发房区域；
 * - **区域与元数据**：每房一个 region（插入序 = 主路径序 → 支线序），
 *   未雕挖格归属末尾的 "walls" 结构区域；每房 meta 写
 *   { center: [px, py], halfW, halfH, doors: [[tx, ty]...], type }——
 *   中心/半宽为像素，门为房间外环紧贴的走廊格按方向连续段取中点；
 * - 房间矩形列表（含槽位/类型/区域索引）经 aux 槽位 SLOT_ROOMS 供下游
 *   消费（仅管道执行期，冻结丢弃）。
 *
 * 全部随机性来自 ctx.rng（管道派生流），消耗顺序固定——同 seed 同 params
 * 逐位复现；房间互不重叠由槽位划分 + 房尺寸 ≤ 槽尺寸 - 1 的校验保证。
 * 结构类型名（path-first/path-mid/path-last/branch）是纯结构描述；
 * 语义命名由配置 roomTypes 传入（框架不解释字符串内容），框架自身
 * 不产生任何游戏语义。
 * 纯几何生产：不 import ECS/world，不做文件 I/O。
 */

import type { GenerationContext, GeometryDraft } from "map/generate/types";
import { defineAuxSlot, setAux } from "map/generate/types";

/** 房间矩形列表 aux 槽位常量：下游消费积木经此读取。 */
export const SLOT_ROOMS = defineAuxSlot<SlotRoomInfo[]>("slot-rooms.rooms");

/** 墙体结构区域名（未雕挖格的归属，regions 末尾）。 */
export const WALLS_REGION = "walls";

/** 语义 id 上界：tiles 缓冲是 Uint8Array，语义 id 必须落在单字节内。 */
const MAX_SEMANTIC_ID = 255;

/** branchCount 允许上界（对齐参考实现，防止配置失控）。 */
const BRANCH_COUNT_MAX = 4;

/** 槽位坐标（slot 网格内）。 */
interface Slot {
  /** 槽列（0..slotsX-1）。 */
  sx: number;
  /** 槽行（0..slotsY-1）。 */
  sy: number;
}

/** 计划中的房间：矩形 + 槽位 + 结构类型语义名（regionIndex = 数组序）。 */
interface PlannedRoom {
  /** 房间矩形（tile 坐标，x/y 为左上角）。 */
  x: number;
  /** 房间矩形左上角行。 */
  y: number;
  /** 房间宽（tile 数）。 */
  width: number;
  /** 房间高（tile 数）。 */
  height: number;
  /** 所属槽列。 */
  slotX: number;
  /** 所属槽行。 */
  slotY: number;
  /** 结构类型语义名（缺省 path-first/path-mid/path-last/branch）。 */
  type: string;
}

/** aux 槽位产出的房间信息（供下游消费积木/工具读取）。 */
export interface SlotRoomInfo {
  /** 房间矩形（tile 坐标）。 */
  x: number;
  /** 房间矩形左上角行。 */
  y: number;
  /** 房间宽（tile 数）。 */
  width: number;
  /** 房间高（tile 数）。 */
  height: number;
  /** 所属槽列。 */
  slotX: number;
  /** 所属槽行。 */
  slotY: number;
  /** 结构类型语义名。 */
  type: string;
  /** 区域索引（regions Map 插入序，rooms 数组序一致）。 */
  regionIndex: number;
}

/** 收窄校验后的积木参数。 */
interface SlotRoomsParams {
  /** 槽列数（≥2）。 */
  slotsX: number;
  /** 槽行数（≥2）。 */
  slotsY: number;
  /** 单槽宽（tile 数，≥2）。 */
  cellW: number;
  /** 单槽高（tile 数，≥2）。 */
  cellH: number;
  /** 普通房最小宽（≥1）。 */
  roomMinW: number;
  /** 普通房最小高（≥1）。 */
  roomMinH: number;
  /** 普通房最大宽（∈ [roomMinW, cellW - 1]，保证槽间至少 1 列墙）。 */
  roomMaxW: number;
  /** 普通房最大高（∈ [roomMinH, cellH - 1]）。 */
  roomMaxH: number;
  /** 主路径末房宽（∈ [1, cellW - 1]）。 */
  lastRoomW: number;
  /** 主路径末房高（∈ [1, cellH - 1]）。 */
  lastRoomH: number;
  /** 走廊宽（tile 数，≥1）。 */
  corridorWidth: number;
  /** 支线尝试上限（∈ [0, 4]）。 */
  branchCount: number;
  /** 结构类型 → 语义名映射（未配置的字段用结构名）。 */
  roomTypes: { pathFirst: string; pathLast: string; pathMid: string; branch: string[] };
  /** 雕挖目标：地面语义 id。 */
  floorTile: number;
  /** 墙体语义 id（初始化整图，须 ≠ floorTile）。 */
  solidTile: number;
  /** 单 tile 宽（像素）。 */
  tileWidth: number;
  /** 单 tile 高（像素）。 */
  tileHeight: number;
}

/** 参数错误统一出口：消息含地图 key 与具体原因。 */
function fail(mapKey: string, detail: string): never {
  throw new Error(`map "${mapKey}": slot-rooms ${detail}`);
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

/** 要求可选非空字符串，未提供返回缺省结构名。 */
function optionalName(mapKey: string, value: unknown, fallback: string): string {
  if (value === undefined) return fallback;
  if (typeof value !== "string" || value.length === 0) {
    fail(mapKey, `params.roomTypes entries must be non-empty strings, got ${display(value)}`);
  }
  return value;
}

/**
 * 从 ctx.params 收窄积木参数：逐项校验（fail-fast），缺省值对齐参考实现
 * （5×4 槽位、15×12 槽尺寸、9–11×7–9 房、11×9 末房、3 格走廊、3 支线）。
 */
function parseParams(params: unknown, mapKey: string): SlotRoomsParams {
  if (typeof params !== "object" || params === null) {
    fail(mapKey, "params must be an object");
  }
  const raw = params as Record<string, unknown>;

  const slotsX = raw.slotsX === undefined ? 5 : requireInt(mapKey, "slotsX", raw.slotsX, 2);
  const slotsY = raw.slotsY === undefined ? 4 : requireInt(mapKey, "slotsY", raw.slotsY, 2);
  const cellW = raw.cellW === undefined ? 15 : requireInt(mapKey, "cellW", raw.cellW, 2);
  const cellH = raw.cellH === undefined ? 12 : requireInt(mapKey, "cellH", raw.cellH, 2);
  const roomMinW = raw.roomMinW === undefined ? 9 : requireInt(mapKey, "roomMinW", raw.roomMinW, 1);
  const roomMinH = raw.roomMinH === undefined ? 7 : requireInt(mapKey, "roomMinH", raw.roomMinH, 1);
  const roomMaxW =
    raw.roomMaxW === undefined
      ? Math.min(11, cellW - 1)
      : requireInt(mapKey, "roomMaxW", raw.roomMaxW, roomMinW, cellW - 1);
  const roomMaxH =
    raw.roomMaxH === undefined
      ? Math.min(9, cellH - 1)
      : requireInt(mapKey, "roomMaxH", raw.roomMaxH, roomMinH, cellH - 1);
  const lastRoomW = raw.lastRoomW === undefined ? 11 : requireInt(mapKey, "lastRoomW", raw.lastRoomW, 1, cellW - 1);
  const lastRoomH = raw.lastRoomH === undefined ? 9 : requireInt(mapKey, "lastRoomH", raw.lastRoomH, 1, cellH - 1);
  const corridorWidth =
    raw.corridorWidth === undefined ? 3 : requireInt(mapKey, "corridorWidth", raw.corridorWidth, 1);
  const branchCount = raw.branchCount === undefined ? 3 : requireInt(mapKey, "branchCount", raw.branchCount, 0, BRANCH_COUNT_MAX);

  // roomTypes：可选对象，pathFirst/pathLast/pathMid 为可选非空字符串，
  // branch 为可选非空字符串数组（语义名映射，框架不解释内容）
  const roomTypes = { pathFirst: "path-first", pathLast: "path-last", pathMid: "path-mid", branch: ["branch"] };
  if (raw.roomTypes !== undefined) {
    if (typeof raw.roomTypes !== "object" || raw.roomTypes === null || Array.isArray(raw.roomTypes)) {
      fail(mapKey, "params.roomTypes must be an object with optional pathFirst/pathLast/pathMid/branch");
    }
    const types = raw.roomTypes as Record<string, unknown>;
    roomTypes.pathFirst = optionalName(mapKey, types.pathFirst, roomTypes.pathFirst);
    roomTypes.pathLast = optionalName(mapKey, types.pathLast, roomTypes.pathLast);
    roomTypes.pathMid = optionalName(mapKey, types.pathMid, roomTypes.pathMid);
    if (types.branch !== undefined) {
      if (!Array.isArray(types.branch) || types.branch.length === 0) {
        fail(mapKey, "params.roomTypes.branch must be a non-empty array of strings");
      }
      roomTypes.branch = types.branch.map((entry) => optionalName(mapKey, entry, ""));
    }
  }

  const floorTile = requireInt(mapKey, "floorTile", raw.floorTile, 0, MAX_SEMANTIC_ID);
  const solidTile = requireInt(mapKey, "solidTile", raw.solidTile, 0, MAX_SEMANTIC_ID);
  if (floorTile === solidTile) {
    fail(mapKey, `params.floorTile and params.solidTile must be different semantic ids, both are ${floorTile}`);
  }
  if (typeof raw.tileWidth !== "number" || !Number.isFinite(raw.tileWidth) || raw.tileWidth <= 0) {
    fail(mapKey, `params.tileWidth must be a positive number, got ${display(raw.tileWidth)}`);
  }
  if (typeof raw.tileHeight !== "number" || !Number.isFinite(raw.tileHeight) || raw.tileHeight <= 0) {
    fail(mapKey, `params.tileHeight must be a positive number, got ${display(raw.tileHeight)}`);
  }

  return {
    slotsX,
    slotsY,
    cellW,
    cellH,
    roomMinW,
    roomMinH,
    roomMaxW,
    roomMaxH,
    lastRoomW,
    lastRoomH,
    corridorWidth,
    branchCount,
    roomTypes,
    floorTile,
    solidTile,
    tileWidth: raw.tileWidth as number,
    tileHeight: raw.tileHeight as number,
  };
}

/**
 * 主路径随机游走：从左缘随机行出发，每步从候选方向池（右 × 2、上、下，
 * 越界方向剔除）按 rng 选取，列号严格递增直到右缘。
 *
 * @returns 主路径槽位序列（长度 = slotsX，声明序即房间序）
 */
function planMainPath(slotsX: number, slotsY: number, rng: GenerationContext["rng"]): Slot[] {
  const path: Slot[] = [];
  let sx = 0;
  let sy = rng.int(slotsY);
  path.push({ sx, sy });
  while (sx < slotsX - 1) {
    // 候选方向池：右权重 2，构建顺序固定保证 rng 消耗序列确定
    const pool: Slot[] = [{ sx: sx + 1, sy }, { sx: sx + 1, sy }];
    if (sy > 0) pool.push({ sx: sx + 1, sy: sy - 1 });
    if (sy < slotsY - 1) pool.push({ sx: sx + 1, sy: sy + 1 });
    const next = pool[rng.int(pool.length)];
    sx = next.sx;
    sy = next.sy;
    path.push({ sx, sy });
  }
  return path;
}

/** 槽位占用键（"sx,sy"）。 */
function slotKey(sx: number, sy: number): string {
  return `${sx},${sy}`;
}

/**
 * 雕挖矩形区域（钳到地图边界内）：未雕格写 tiles=floorTile/walkable=1/
 * regionOfTile=regionIndex；已是 floorTile 的格（走廊穿越其他房间）保持
 * 原区域归属，不改写。
 */
function carveRect(
  draft: GeometryDraft,
  x: number,
  y: number,
  w: number,
  h: number,
  floorTile: number,
  regionIndex: number,
): void {
  const x0 = Math.max(0, x);
  const y0 = Math.max(0, y);
  const x1 = Math.min(draft.width - 1, x + w - 1);
  const y1 = Math.min(draft.height - 1, y + h - 1);
  for (let ty = y0; ty <= y1; ty++) {
    for (let tx = x0; tx <= x1; tx++) {
      const index = ty * draft.width + tx;
      if (draft.tiles[index] !== floorTile) {
        draft.tiles[index] = floorTile;
        draft.walkable[index] = 1;
        draft.regionOfTile[index] = regionIndex;
      }
    }
  }
}

/**
 * 雕挖 L 形走廊（中心到中心，先横后竖或先竖后横）：每段为以路径线为
 * 基准、corridorWidth 厚（向左/上偏移 floor((w-1)/2) 居中）的矩形；
 * 两段共享拐角格，路径全雕 → 走廊连通两端房间内部（中心在房间内）。
 */
function carveCorridor(
  draft: GeometryDraft,
  from: { x: number; y: number },
  to: { x: number; y: number },
  corridorWidth: number,
  floorTile: number,
  regionIndex: number,
  horizontalFirst: boolean,
): void {
  const off = (corridorWidth - 1) >> 1;
  if (horizontalFirst) {
    // 先横（沿 from.y）后竖（沿 to.x），共享拐角格 (to.x, from.y)
    carveRect(draft, Math.min(from.x, to.x), from.y - off, Math.abs(from.x - to.x) + 1, corridorWidth, floorTile, regionIndex);
    carveRect(draft, to.x - off, Math.min(from.y, to.y), corridorWidth, Math.abs(from.y - to.y) + 1, floorTile, regionIndex);
  } else {
    // 先竖（沿 from.x）后横（沿 to.y），共享拐角格 (from.x, to.y)
    carveRect(draft, from.x - off, Math.min(from.y, to.y), corridorWidth, Math.abs(from.y - to.y) + 1, floorTile, regionIndex);
    carveRect(draft, Math.min(from.x, to.x), to.y - off, Math.abs(from.x - to.x) + 1, corridorWidth, floorTile, regionIndex);
  }
}

/**
 * 采集房间外环一 ring 的门格：四正方向（上/下/左/右各扫房间的对边投影）
 * 各收集 walkable=1 的连续段，每段取中位格作为该段门。每房至少有一条
 * 走廊连接（构造保证）→ 门外环扫描非空。
 *
 * @returns 门格列表 [[tx, ty], ...]
 */
function collectDoors(draft: GeometryDraft, room: PlannedRoom): number[][] {
  const { x, y, width, height } = room;
  const doors: number[][] = [];
  // 每方向 = 一组候选格坐标序列（沿墙投影，不含斜角）
  const lines: Array<Array<[number, number]>> = [];
  if (y > 0) {
    lines.push(Array.from({ length: width }, (_, i) => [x + i, y - 1] as [number, number]));
  }
  if (y + height < draft.height) {
    lines.push(Array.from({ length: width }, (_, i) => [x + i, y + height] as [number, number]));
  }
  if (x > 0) {
    lines.push(Array.from({ length: height }, (_, i) => [x - 1, y + i] as [number, number]));
  }
  if (x + width < draft.width) {
    lines.push(Array.from({ length: height }, (_, i) => [x + width, y + i] as [number, number]));
  }
  for (const line of lines) {
    // 连续 walkable 段取中位格
    let run: Array<[number, number]> = [];
    const flush = (): void => {
      if (run.length > 0) {
        doors.push(run[Math.floor(run.length / 2)]);
        run = [];
      }
    };
    for (const [tx, ty] of line) {
      if (draft.walkable[ty * draft.width + tx] === 1) {
        run.push([tx, ty]);
      } else {
        flush();
      }
    }
    flush();
  }
  return doors;
}

/**
 * slot-rooms 生成积木：槽位网格 + 随机游走主路径 + 支线 + L 形走廊的
 * 锚点式房间布局（sizing 首积木）。
 *
 * @param ctx 生成上下文（params 由本积木收窄校验）
 * @throws Error 当 params 非法，或草稿已被初始化（本积木必须是管道首积木）时
 */
export function slotRooms(ctx: GenerationContext): void {
  const params = parseParams(ctx.params, ctx.key);
  const draft = ctx.geometry;
  if (draft.width !== 0 || draft.height !== 0 || draft.tiles.length !== 0) {
    throw new Error(
      `map "${ctx.key}": geometry draft already initialized; slot-rooms must be the first pipeline block`,
    );
  }

  const { slotsX, slotsY, cellW, cellH } = params;
  const width = slotsX * cellW;
  const height = slotsY * cellH;
  const total = width * height;
  draft.width = width;
  draft.height = height;
  draft.tileWidth = params.tileWidth;
  draft.tileHeight = params.tileHeight;
  draft.tiles = new Uint8Array(total).fill(params.solidTile);
  draft.walkable = new Uint8Array(total);
  draft.regionOfTile = new Uint16Array(total);

  // ── 阶段 1：主路径随机游走 ──────────────────────────────────────────
  const mainPath = planMainPath(slotsX, slotsY, ctx.rng);
  const occupied = new Set<string>(mainPath.map((slot) => slotKey(slot.sx, slot.sy)));

  // ── 阶段 2：支线尝试（主路径中段四方向空槽挂出）────────────────────
  // branchPlan[i] = { source(主路径房索引), slot }
  const branchPlan: Array<{ source: number; slot: Slot }> = [];
  if (slotsX >= 3 && params.branchCount > 0) {
    for (let attempt = 0; attempt < params.branchCount; attempt++) {
      // 源 = 主路径中段随机房（不含首尾）：index ∈ [1, len-2]
      const source = 1 + ctx.rng.int(mainPath.length - 2);
      const origin = mainPath[source];
      // 候选方向：上/下/左/右固定顺序构建、过滤越界与占用
      const candidates: Slot[] = [];
      if (origin.sy > 0) candidates.push({ sx: origin.sx, sy: origin.sy - 1 });
      if (origin.sy < slotsY - 1) candidates.push({ sx: origin.sx, sy: origin.sy + 1 });
      if (origin.sx > 0) candidates.push({ sx: origin.sx - 1, sy: origin.sy });
      if (origin.sx < slotsX - 1) candidates.push({ sx: origin.sx + 1, sy: origin.sy });
      const free = candidates.filter((slot) => !occupied.has(slotKey(slot.sx, slot.sy)));
      if (free.length === 0) continue;
      const slot = free[ctx.rng.int(free.length)];
      occupied.add(slotKey(slot.sx, slot.sy));
      branchPlan.push({ source, slot });
    }
  }

  // ── 阶段 3：房间计划（主路径序 → 支线序），尺寸随机、槽内居中 ──────
  const rooms: PlannedRoom[] = [];
  const planRoom = (slot: Slot, type: string, w: number, h: number): void => {
    rooms.push({
      x: slot.sx * cellW + ((cellW - w) >> 1),
      y: slot.sy * cellH + ((cellH - h) >> 1),
      width: w,
      height: h,
      slotX: slot.sx,
      slotY: slot.sy,
      type,
    });
  };
  const spanW = params.roomMaxW - params.roomMinW;
  const spanH = params.roomMaxH - params.roomMinH;
  mainPath.forEach((slot, index) => {
    if (index === 0) {
      planRoom(slot, params.roomTypes.pathFirst, params.roomMinW + ctx.rng.int(spanW + 1), params.roomMinH + ctx.rng.int(spanH + 1));
    } else if (index === mainPath.length - 1) {
      planRoom(slot, params.roomTypes.pathLast, params.lastRoomW, params.lastRoomH);
    } else {
      planRoom(slot, params.roomTypes.pathMid, params.roomMinW + ctx.rng.int(spanW + 1), params.roomMinH + ctx.rng.int(spanH + 1));
    }
  });
  branchPlan.forEach((branch, index) => {
    const type = params.roomTypes.branch[index % params.roomTypes.branch.length];
    planRoom(branch.slot, type, params.roomMinW + ctx.rng.int(spanW + 1), params.roomMinH + ctx.rng.int(spanH + 1));
  });

  // ── 阶段 4：区域表（房区域按 rooms 序 → walls 兜底）────────────────
  // 区域名 = "<语义类型>#<房序>"，唯一且自描述；meta.type 记录纯类型
  rooms.forEach((room, index) => {
    draft.regions.set(`${room.type}#${index}`, {
      name: `${room.type}#${index}`,
      meta: {
        center: [(room.x + room.width / 2) * params.tileWidth, (room.y + room.height / 2) * params.tileHeight],
        halfW: (room.width * params.tileWidth) / 2,
        halfH: (room.height * params.tileHeight) / 2,
        doors: [] as number[][],
        type: room.type,
      },
    });
  });
  const wallsIndex = rooms.length;
  draft.regions.set(WALLS_REGION, { name: WALLS_REGION, meta: {} });
  draft.regionOfTile.fill(wallsIndex);

  // ── 阶段 5：雕挖房间 → 走廊 ────────────────────────────────────────
  rooms.forEach((room, index) => {
    carveRect(draft, room.x, room.y, room.width, room.height, params.floorTile, index);
  });
  // 主路径相邻房走廊（i → i+1，出发房归属 i）
  for (let i = 0; i + 1 < mainPath.length; i++) {
    const from = rooms[i];
    const to = rooms[i + 1];
    const horizontalFirst = ctx.rng.int(2) === 0;
    carveCorridor(
      draft,
      { x: from.x + (from.width >> 1), y: from.y + (from.height >> 1) },
      { x: to.x + (to.width >> 1), y: to.y + (to.height >> 1) },
      params.corridorWidth,
      params.floorTile,
      i,
      horizontalFirst,
    );
  }
  // 支线房 → 源房走廊（出发房归属支线房）
  branchPlan.forEach((branch, planIndex) => {
    const branchIndex = mainPath.length + planIndex;
    const from = rooms[branchIndex];
    const to = rooms[branch.source];
    const horizontalFirst = ctx.rng.int(2) === 0;
    carveCorridor(
      draft,
      { x: from.x + (from.width >> 1), y: from.y + (from.height >> 1) },
      { x: to.x + (to.width >> 1), y: to.y + (to.height >> 1) },
      params.corridorWidth,
      params.floorTile,
      branchIndex,
      horizontalFirst,
    );
  });

  // ── 阶段 6：门（走廊进入处）写入房间 meta ──────────────────────────
  rooms.forEach((room, index) => {
    const meta = draft.regions.get(`${room.type}#${index}`)?.meta;
    if (meta) {
      meta.doors = collectDoors(draft, room);
    }
  });

  // ── 阶段 7：房间矩形列表写 aux（仅管道执行期，冻结丢弃）────────────
  const roomInfos: SlotRoomInfo[] = rooms.map((room, index) => ({
    x: room.x,
    y: room.y,
    width: room.width,
    height: room.height,
    slotX: room.slotX,
    slotY: room.slotY,
    type: room.type,
    regionIndex: index,
  }));
  setAux(draft, SLOT_ROOMS, roomInfos);
}
