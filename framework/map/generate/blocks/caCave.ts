/**
 * 生成积木 "ca-cave"（framework/map/generate/blocks/caCave.ts）。
 *
 * 元胞自动机洞穴积木（有机洞穴雕挖，与 room-corridor 的规则房间互补）：
 * 对已定尺寸草稿的墙壁位图做 CA 平滑迭代（经典 4-5 规则），再经连通域
 * 标记 + 并查集式归并保证全部洞穴地面与主连通域相连。
 *
 * 行为（三段，纯几何、无游戏语义）：
 * 1. 初始墙壁位图：默认取自当前 tiles（tiles == wallSemantics 的格为墙）；
 *   提供initialWallProbability 时改为随机填充（行主序逐格以该概率掷墙，
 *   上游语义布局被替换——上游积木的角色只是定尺寸）；
 * 2. CA 平滑迭代（4-5 规则）：每轮对每格统计 9-胞 Moore 邻域（自身 +
 *    8 邻域，越界格计为墙）中的墙数，≥ 5 → 墙，否则 → 地面。double-buffer
 *    同步更新；maxRounds 式有界迭代（iterations 轮上限，某轮零变更提前
 *    退出——输出恒为规则的不动点或恰好 iterations 轮后的状态）。迭代结束
 *    后全图二值化写回：墙 → wallSemantics + walkable=0，地面 →
 *    floorSemantics + walkable=1（CA 平滑天然二值，其他上游语义不保留）；
 * 3. 连通保证（isolation 可选，缺省 "tunnel"）：对地面做 4-邻接连通域
 *    标记，最大域为主域（并列取标记序在前者）——
 *    - "tunnel"：多源 BFS（源 = 主域全部格，墙/地面皆可通行，扩展序固定）
 *      记录各次域的首触格与父链，沿父链把链上格雕为地面——每条隧道都是
 *      最短 4-邻接路径，全部次域与主域连通由此保证；
 *    - "remove"：次域整体填回墙（孤立小洞剔除）。
 *
 * 纯几何生产：不 import ECS/world，不做文件 I/O，不含游戏专属语义。
 * 随机性仅来自 initialWallProbability 填充（ctx.rng），同 seed 同配置确定。
 */

import type { Rng } from "map/generate/rng";
import type { GenerationContext, GeometryDraft } from "map/generate/types";

/** 语义 id 上界：tiles 缓冲是 Uint8Array，语义 id 必须落在单字节内。 */
const MAX_SEMANTIC_ID = 255;
/** 迭代轮数缺省值。 */
const DEFAULT_ITERATIONS = 5;
/** 迭代轮数边界（[1, 32]）。 */
const ITERATIONS_MIN = 1;
const ITERATIONS_MAX = 32;

/** 收窄校验后的积木参数。 */
interface CaCaveParams {
  /** 墙语义 id（墙格写入该值，0–255）。 */
  wallSemantics: number;
  /** 地面语义 id（地面格写入该值，0–255；须与墙语义不同）。 */
  floorSemantics: number;
  /** CA 迭代轮数上限（[1, 32]，缺省 5）。 */
  iterations: number;
  /** 初墙概率（[0, 1]）；提供时随机填充初始墙壁位图，省略 = 取自当前 tiles。 */
  initialWallProbability: number | undefined;
  /** 孤立洞穴处理："tunnel" = 雕隧道接入主域（缺省）；"remove" = 填回墙。 */
  isolation: "tunnel" | "remove";
}

/** 参数错误统一出口：消息含地图 key 与具体原因。 */
function fail(mapKey: string, detail: string): never {
  throw new Error(`map "${mapKey}": ca-cave ${detail}`);
}

/**
 * 从 ctx.params 收窄积木参数：逐项校验，缺失/非法即抛出点名具体配置项的错误。
 *
 * @param params 管道透传的本步骤参数切片
 * @param mapKey 地图 key（错误消息定位用）
 * @returns 可信参数形状
 */
function parseParams(params: unknown, mapKey: string): CaCaveParams {
  if (typeof params !== "object" || params === null || Array.isArray(params)) {
    fail(mapKey, "params must be an object with wallSemantics / floorSemantics");
  }
  const raw = params as Record<string, unknown>;

  const semanticIds: [string, number][] = [];
  for (const key of ["wallSemantics", "floorSemantics"] as const) {
    const value = raw[key];
    if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > MAX_SEMANTIC_ID) {
      fail(mapKey, `params.${key} must be an integer semantic id in [0, 255], got ${String(value)}`);
    }
    semanticIds.push([key, value]);
  }
  if (semanticIds[0][1] === semanticIds[1][1]) {
    fail(mapKey, "params.wallSemantics and params.floorSemantics must be distinct");
  }

  let iterations = DEFAULT_ITERATIONS;
  if (raw.iterations !== undefined) {
    const value = raw.iterations;
    if (typeof value !== "number" || !Number.isInteger(value) || value < ITERATIONS_MIN || value > ITERATIONS_MAX) {
      fail(mapKey, `params.iterations must be an integer in [${ITERATIONS_MIN}, ${ITERATIONS_MAX}], got ${String(value)}`);
    }
    iterations = value;
  }

  let initialWallProbability: number | undefined;
  if (raw.initialWallProbability !== undefined) {
    const value = raw.initialWallProbability;
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) {
      fail(mapKey, `params.initialWallProbability must be a number in [0, 1], got ${String(value)}`);
    }
    initialWallProbability = value;
  }

  let isolation: "tunnel" | "remove" = "tunnel";
  if (raw.isolation !== undefined) {
    if (raw.isolation !== "tunnel" && raw.isolation !== "remove") {
      fail(mapKey, `params.isolation must be "tunnel" or "remove", got ${String(raw.isolation)}`);
    }
    isolation = raw.isolation;
  }

  return {
    wallSemantics: semanticIds[0][1],
    floorSemantics: semanticIds[1][1],
    iterations,
    initialWallProbability,
    isolation,
  };
}

/**
 * 构建初始墙壁位图：initialWallProbability 提供时行主序逐格掷墙
 * （rng 固定顺序，确定性）；否则取自当前 tiles（tiles == wallSemantics）。
 */
function buildInitialWalls(
  draft: GeometryDraft,
  rng: Rng,
  initialWallProbability: number | undefined,
  wallSemantics: number,
): Uint8Array {
  const total = draft.width * draft.height;
  const walls = new Uint8Array(total);
  if (initialWallProbability !== undefined) {
    for (let i = 0; i < total; i++) {
      walls[i] = rng.next() < initialWallProbability ? 1 : 0;
    }
  } else {
    for (let i = 0; i < total; i++) {
      walls[i] = draft.tiles[i] === wallSemantics ? 1 : 0;
    }
  }
  return walls;
}

/** 9-胞 Moore 邻域（自身 + 8 邻域）墙计数，越界格计为墙。 */
function wallCount9(walls: Uint8Array, width: number, height: number, x: number, y: number): number {
  let count = 0;
  for (let dy = -1; dy <= 1; dy++) {
    const ny = y + dy;
    for (let dx = -1; dx <= 1; dx++) {
      const nx = x + dx;
      if (nx < 0 || nx >= width || ny < 0 || ny >= height) {
        count++; // 越界计为墙：边界趋实、洞穴不漏出地图边缘
      } else {
        count += walls[ny * width + nx];
      }
    }
  }
  return count;
}

/**
 * CA 单轮 4-5 规则（纯函数，double-buffer 同步更新）。
 *
 * @param walls 输入墙壁位图（行主序，不改写）
 * @returns [新墙壁位图（副本），本轮变更格数]
 */
function caRound(walls: Uint8Array, width: number, height: number): [Uint8Array, number] {
  const next = new Uint8Array(walls.length);
  let changed = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const index = y * width + x;
      const isWall = wallCount9(walls, width, height, x, y) >= 5 ? 1 : 0;
      next[index] = isWall;
      if (isWall !== walls[index]) changed++;
    }
  }
  return [next, changed];
}

/**
 * 对地面位图做 4-邻接连通域标记（扫描序 BFS，标签按首次出现序）。
 *
 * @returns [每格标签（-1 = 墙），各域面积（下标 = 标签）]
 */
function labelFloorComponents(
  floors: Uint8Array,
  width: number,
  height: number,
): [Int32Array, number[]] {
  const total = width * height;
  const labels = new Int32Array(total).fill(-1);
  const sizes: number[] = [];
  for (let start = 0; start < total; start++) {
    if (floors[start] !== 1 || labels[start] !== -1) continue;
    const label = sizes.length;
    labels[start] = label;
    sizes.push(0);
    const queue: number[] = [start]; // 每域独立队列（head 指针消费，不 shift）
    for (let head = 0; head < queue.length; head++) {
      const index = queue[head];
      sizes[label]++;
      const x = index % width;
      const y = (index - x) / width;
      // 4-邻接入队（越界跳过，固定序：左、右、上、下）
      if (x > 0 && floors[index - 1] === 1 && labels[index - 1] === -1) {
        labels[index - 1] = label;
        queue.push(index - 1);
      }
      if (x < width - 1 && floors[index + 1] === 1 && labels[index + 1] === -1) {
        labels[index + 1] = label;
        queue.push(index + 1);
      }
      if (y > 0 && floors[index - width] === 1 && labels[index - width] === -1) {
        labels[index - width] = label;
        queue.push(index - width);
      }
      if (y < height - 1 && floors[index + width] === 1 && labels[index + width] === -1) {
        labels[index + width] = label;
        queue.push(index + width);
      }
    }
  }
  return [labels, sizes];
}

/**
 * ca-cave 生成积木：CA 平滑雕挖有机洞穴并保证全部地面与主连通域相连。
 *
 * @param ctx 生成上下文（params 由本积木收窄校验）
 * @throws Error 当 params 非法，或草稿未定尺寸/缓冲未分配时（消息含地图 key）
 */
export function caCave(ctx: GenerationContext): void {
  const params = parseParams(ctx.params, ctx.key);
  const draft: GeometryDraft = ctx.geometry;
  const total = draft.width * draft.height;
  if (draft.width <= 0 || draft.height <= 0 || draft.tiles.length !== total || draft.walkable.length !== total || total === 0) {
    throw new Error(
      `map "${ctx.key}": ca-cave requires a sized draft (width=${draft.width}, height=${draft.height}, tiles.length=${draft.tiles.length}) — a sizing block must run first`,
    );
  }

  // 1. 初始墙壁位图 + CA 平滑迭代（有界，零变更提前退出）
  let walls = buildInitialWalls(draft, ctx.rng, params.initialWallProbability, params.wallSemantics);
  for (let round = 0; round < params.iterations; round++) {
    const [next, changed] = caRound(walls, draft.width, draft.height);
    walls = next;
    if (changed === 0) {
      break;
    }
  }

  // 2. 二值化写回：墙 → wallSemantics + 不可走；地面 → floorSemantics + 可走
  const { tiles, walkable } = draft;
  const floors = new Uint8Array(total);
  for (let i = 0; i < total; i++) {
    tiles[i] = walls[i] === 1 ? params.wallSemantics : params.floorSemantics;
    walkable[i] = walls[i] === 1 ? 0 : 1;
    floors[i] = walls[i] === 1 ? 0 : 1;
  }

  // 3. 连通保证：主域 = 最大地面连通域；无地面（全墙）或单域则无事可做
  const [labels, sizes] = labelFloorComponents(floors, draft.width, draft.height);
  if (sizes.length <= 1) {
    return;
  }
  let main = 0;
  for (let label = 1; label < sizes.length; label++) {
    if (sizes[label] > sizes[main]) main = label; // 并列取标记序在前者（严格大于）
  }

  if (params.isolation === "remove") {
    // 次域整体填回墙（孤立小洞剔除）
    for (let i = 0; i < total; i++) {
      if (labels[i] >= 0 && labels[i] !== main) {
        tiles[i] = params.wallSemantics;
        walkable[i] = 0;
      }
    }
    return;
  }

  // "tunnel"：多源 BFS（源 = 主域全部格），墙/地面皆可通行；首触各次域格
  // 的父链即最短 4-邻接隧道，沿链雕为地面 → 全部次域与主域连通
  const dist = new Int32Array(total).fill(-1);
  const parent = new Int32Array(total).fill(-1);
  const firstTouch = new Int32Array(sizes.length).fill(-1);
  const queue: number[] = [];
  for (let i = 0; i < total; i++) {
    if (labels[i] === main) {
      dist[i] = 0;
      queue.push(i);
    }
  }
  for (let head = 0; head < queue.length; head++) {
    const index = queue[head];
    const x = index % draft.width;
    const y = (index - x) / draft.width;
    // 固定扩展序（左、右、上、下）→ 首触与父链完全确定
    for (const neighbor of [
      x > 0 ? index - 1 : -1,
      x < draft.width - 1 ? index + 1 : -1,
      y > 0 ? index - draft.width : -1,
      y < draft.height - 1 ? index + draft.width : -1,
    ]) {
      if (neighbor < 0 || dist[neighbor] !== -1) continue;
      dist[neighbor] = dist[index] + 1;
      parent[neighbor] = index;
      const label = labels[neighbor];
      if (label >= 0 && label !== main && firstTouch[label] === -1) {
        firstTouch[label] = neighbor;
      }
      queue.push(neighbor);
    }
  }

  // 沿父链雕隧道：链上 dist ≥ 1 的格（dist 0 = 主域格，已是地面）
  for (let label = 0; label < sizes.length; label++) {
    if (label === main || firstTouch[label] === -1) continue;
    let cell = firstTouch[label];
    while (cell >= 0 && dist[cell] >= 1) {
      tiles[cell] = params.floorSemantics;
      walkable[cell] = 1;
      cell = parent[cell];
    }
  }
}
