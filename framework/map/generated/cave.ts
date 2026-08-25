/**
 * "cave" 内置地图生成器：元胞自动机（cellular automata）洞穴生成。
 *
 * 生成规则：
 * - 初始：内部以约 45% 概率随机置墙（xorshift32 伪随机，同种子结果可复现），边界恒墙；
 * - 平滑：经典 B=r5 / D=r4 规则迭代 5 轮——一格有 ≥5 个墙邻接（8 邻域）则成墙，
 *   ≤4 个墙邻接则成地面，每轮结束后边界强制为墙；
 * - 出生点：玩家位于最大地面连通分量（4 向 flood fill）中距质心最近的地面格（tile 中心），
 *   可选 NPC 出生点按 tile 偏移锚定到玩家出生点；
 * - 区域：1 个覆盖地图内侧的默认区域。
 *
 * 语言保持游戏无关：只描述网格/墙/地面，不引入任何游戏专属语义。
 */
import type { MapRuntime } from "map/types";

/**
 * xorshift32 伪随机数生成器：由种子构造一个可复现的随机数闭包。
 *
 * @param state 种子（整数）
 * @returns 每次调用返回一个 [0, 2^32) 的无符号整数
 */
function xorshift32(state: number): () => number {
  let x = state | 0;
  return () => {
    x ^= x << 13;
    x ^= x >> 17;
    x ^= x << 5;
    return x >>> 0;
  };
}

/** "cave" 生成器的参数（与 GeneratedMapSource 字段一一对应，另含可选 NPC 出生点）。 */
export interface CaveGeneratorOptions {
  /** 地图 id。 */
  id: string;
  /** 地图名称。 */
  name: string;
  /** 随机种子（同种子生成结果一致）。 */
  seed: number;
  /** 地图宽度（tile 数）。 */
  width: number;
  /** 地图高度（tile 数）。 */
  height: number;
  /** 单个 tile 宽度（像素）。 */
  tileWidth: number;
  /** 单个 tile 高度（像素）。 */
  tileHeight: number;
  /** 可选 NPC 出生点：按 tile 偏移锚定到玩家出生点像素坐标。 */
  npcSpawns?: Array<{ kind: string; offsetTiles: [number, number]; zoneId?: number }>;
}

const WALL = 1;
const FLOOR = 0;
/** 平滑阈值（B=r5）：8 邻域中 ≥5 个墙 → 成墙。 */
const WALL_THRESHOLD = 5;
/** 平滑轮数。 */
const SMOOTH_PASSES = 5;
/** 初始随机置墙概率（百分比）。 */
const INITIAL_WALL_PERCENT = 45;
/** 4 向邻域偏移。 */
const NEIGH4: ReadonlyArray<readonly [number, number]> = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
];

/**
 * 按 cave 规则生成 MapRuntime。
 *
 * @param options 生成参数
 * @returns 运行时地图（grid / blocked / spawns / zones）
 */
export function generateCaveMap(options: CaveGeneratorOptions): MapRuntime {
  // 伪随机源：同种子生成结果一致
  const rng = xorshift32(options.seed);
  const { width, height, tileWidth, tileHeight } = options;
  const size = width * height;
  // 阻挡网格（按行展平；0=可走，1=阻挡）
  const blocked = new Uint8Array(size);

  // 1) 初始化：边界恒墙，内部以约 45% 概率置墙
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const isBorder = x === 0 || y === 0 || x === width - 1 || y === height - 1;
      blocked[y * width + x] = isBorder ? WALL : rng() % 100 < INITIAL_WALL_PERCENT ? WALL : FLOOR;
    }
  }

  // 2) 平滑 5 轮（经典 B=r5 / D=r4 元胞规则），每轮结束强制边界为墙
  for (let pass = 0; pass < SMOOTH_PASSES; pass++) {
    const next = new Uint8Array(size);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        let walls = 0;
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            if (dx === 0 && dy === 0) continue;
            const nx = x + dx;
            const ny = y + dy;
            if (nx < 0 || ny < 0 || nx >= width || ny >= height) {
              walls++; // 越界视为墙
            } else if (blocked[ny * width + nx] === WALL) {
              walls++;
            }
          }
        }
        next[y * width + x] = walls >= WALL_THRESHOLD ? WALL : FLOOR;
      }
    }
    // 边界一圈强制为墙
    for (let x = 0; x < width; x++) {
      next[x] = WALL;
      next[(height - 1) * width + x] = WALL;
    }
    for (let y = 0; y < height; y++) {
      next[y * width] = WALL;
      next[y * width + (width - 1)] = WALL;
    }
    blocked.set(next);
  }

  // 3) 最大地面连通分量（4 向 flood fill），玩家出生在其中
  const visited = new Uint8Array(size);
  let bestCells: number[] = [];
  for (let idx = 0; idx < size; idx++) {
    if (blocked[idx] === WALL || visited[idx]) continue;
    const stack = [idx];
    visited[idx] = 1;
    const cells: number[] = [];
    while (stack.length) {
      const cur = stack.pop()!;
      cells.push(cur);
      const cx = cur % width;
      const cy = Math.floor(cur / width);
      for (const [dx, dy] of NEIGH4) {
        const nx = cx + dx;
        const ny = cy + dy;
        if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
        const ni = ny * width + nx;
        if (blocked[ni] === FLOOR && !visited[ni]) {
          visited[ni] = 1;
          stack.push(ni);
        }
      }
    }
    if (cells.length > bestCells.length) {
      bestCells = cells;
    }
  }

  // 玩家出生：最大分量内距质心最近的地面格（tile 中心像素坐标）
  let cxSum = 0;
  let cySum = 0;
  for (const cell of bestCells) {
    cxSum += cell % width;
    cySum += Math.floor(cell / width);
  }
  const cenX = cxSum / bestCells.length;
  const cenY = cySum / bestCells.length;
  let pickX = 0;
  let pickY = 0;
  let bestDist = Infinity;
  for (const cell of bestCells) {
    const tx = cell % width;
    const ty = Math.floor(cell / width);
    const d = (tx - cenX) ** 2 + (ty - cenY) ** 2;
    if (d < bestDist) {
      bestDist = d;
      pickX = tx;
      pickY = ty;
    }
  }
  const player = { x: pickX * tileWidth + tileWidth / 2, y: pickY * tileHeight + tileHeight / 2 };

  // 4) NPC 出生点：按 tile 偏移锚定到玩家出生点像素坐标（缺省为空数组）
  const npcs = (options.npcSpawns ?? []).map((n) => ({
    kind: n.kind,
    pos: { x: player.x + n.offsetTiles[0] * tileWidth, y: player.y + n.offsetTiles[1] * tileHeight },
    zoneId: n.zoneId,
  }));

  // 5) 单个默认区域：覆盖地图内侧（四周各留出边界 tile 的宽度）
  const mapPixelW = width * tileWidth;
  const mapPixelH = height * tileHeight;
  const zones = [{
    id: 1,
    name: "default",
    polygon: [
      { x: tileWidth, y: tileHeight },
      { x: mapPixelW - tileWidth, y: tileHeight },
      { x: mapPixelW - tileWidth, y: mapPixelH - tileHeight },
      { x: tileWidth, y: mapPixelH - tileHeight },
    ],
  }];

  return {
    id: options.id,
    name: options.name,
    grid: {
      width,
      height,
      tileWidth,
      tileHeight,
    },
    blocked,
    spawns: { player, npcs },
    zones,
  };
}
