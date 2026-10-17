/**
 * 确定性 A* 网格寻路（framework/ai/pathfinding/astar.ts）。
 *
 * 纯函数、零 ECS 依赖：输入地图几何 + 建造阻挡索引 + 起点/终点 (tile, level)，
 * 输出 tile 路径或 null。层号是路径状态的一部分（`(tileIndex, level)`），
 * v1 支持同层与经 slope / 连接器的相邻层过渡，跨层接口已就位。
 *
 * 通行判定复用 `walkableAtLevel`（地形 OR 建造楼板，含 cliff 单向语义）；
 * 建造墙（Structure role=wall）按层额外阻挡（与 stranded 洪泛同源）。
 *
 * 确定性保证：
 * - 邻居顺序固定（上、右、下、左），无 Math.random；
 * - 开放集用二叉堆，比较器依次按 f、h、tile index、level、入堆序号决胜；
 * - 同输入恒同路径（包括 expandedNodes 计数）。
 *
 * 成本控制：`maxNodes` 限制**闭合（实际展开）**节点数，超限返回 null，
 * 调用方回退直线移动。默认上限见 DEFAULT_MAX_NODES。
 */
import { CONNECTOR_DIR_UP } from "framework/components/structure";
import { walkableAtLevel, type BuiltFloorsByLevel } from "map/geometry/query";
import type { MapGeometry } from "map/geometry/types";

/** 默认展开节点上限（192×192 图上单次搜索的宽容值）。 */
export const DEFAULT_MAX_NODES = 16384;

/** 路径中的一格：tile 坐标 + 该步所处层号。 */
export interface PathTile {
  x: number;
  y: number;
  level: number;
}

/**
 * 寻路阻挡索引（结构兼容 map/runtime/builtStructures.BuiltStructuresIndex）。
 * `floors` 必选（walkableAtLevel 的建造侧）；`walls` / `connectors` 可选。
 */
export interface PathfindingBlockers extends BuiltFloorsByLevel {
  /** level → 墙覆盖 tile 线性索引集（按层阻挡）。 */
  walls?: Map<number, Set<number>>;
  /** tile 线性索引 → 连接器声明（low/high/dir；dir=0 上行）。 */
  connectors?: Map<number, { low: number; high: number; dir: number }>;
}

/** 寻路失败原因（path 为 null 时供调用方/测试诊断）。 */
export type PathFailureReason = "invalid" | "limit" | "unreachable";

/** A* 结果：路径（含起点与终点）或 null，以及实际展开节点数。 */
export interface AStarResult {
  path: PathTile[] | null;
  /** 闭合（实际展开）的节点数——性能上界的可断言指标。 */
  expandedNodes: number;
  reason?: PathFailureReason;
}

/** 寻路选项：仅节点上限（成本控制）。 */
export interface FindPathOptions {
  /** 展开节点上限（正整数；缺省 DEFAULT_MAX_NODES）。 */
  maxNodes?: number;
}

/** 固定邻居顺序：上、右、下、左（4-邻接，与洪泛/碰撞网格一致）。 */
const NEIGHBORS: ReadonlyArray<readonly [number, number]> = [
  [0, -1],
  [1, 0],
  [0, 1],
  [-1, 0],
];

/** 地形层号范围缓存（MapGeometry 约定不可变，按弱引用缓存）。 */
const terrainLevelRangeCache = new WeakMap<MapGeometry, { min: number; max: number }>();

/** 取地形层号范围（含所有格）；空图回退 0。 */
function terrainLevelRange(geometry: MapGeometry): { min: number; max: number } {
  const cached = terrainLevelRangeCache.get(geometry);
  if (cached) return cached;
  let min = 0;
  let max = 0;
  for (let i = 0; i < geometry.level.length; i++) {
    const level = geometry.level[i] ?? 0;
    if (level < min) min = level;
    if (level > max) max = level;
  }
  const range = { min, max };
  terrainLevelRangeCache.set(geometry, range);
  return range;
}

/**
 * 计算状态键的层号跨度：地形层范围 ∪ 起点/终点层 ∪ 建造楼板/墙/连接器层。
 * 楼板可悬空于地形层之上（flat 图 L1 楼板），不能只用地形范围。
 */
function levelSpan(
  geometry: MapGeometry,
  built: PathfindingBlockers | undefined,
  start: PathTile,
  goal: PathTile,
): { min: number; max: number; span: number } {
  const terrain = terrainLevelRange(geometry);
  let min = Math.min(terrain.min, start.level, goal.level);
  let max = Math.max(terrain.max, start.level, goal.level);

  const include = (level: number): void => {
    if (level < min) min = level;
    if (level > max) max = level;
  };
  if (built) {
    for (const level of built.floors.keys()) include(level);
    for (const level of built.walls?.keys() ?? []) include(level);
    for (const connector of built.connectors?.values() ?? []) {
      include(connector.low);
      include(connector.high);
    }
  }

  return { min, max, span: max - min + 1 };
}

/** 输入校验：tile 坐标整数、层号为整数、maxNodes 正整数。 */
function assertPathInput(start: PathTile, goal: PathTile, maxNodes: number): void {
  for (const [name, point] of [["start", start], ["goal", goal]] as const) {
    if (!Number.isInteger(point.x) || !Number.isInteger(point.y)) {
      throw new Error(`findPath: ${name} tile coordinates must be integers`);
    }
    if (!Number.isInteger(point.level)) {
      throw new Error(`findPath: ${name}.level must be an integer`);
    }
  }
  if (!Number.isInteger(maxNodes) || maxNodes < 1) {
    throw new Error("findPath: maxNodes must be a positive integer");
  }
}

/**
 * 进入某格后应处的层号（与 entityLevelSystem.resolveEntityLevel 的转移语义
 * 同源，纯网格版）：
 * - 连接器优先：上行连接器把 low 抬到 high，下行把 high 压到 low；
 * - 同层地形不变；
 * - ±1 层差必须经 slope 语义格（否则保持原层，低→高非法）；
 * - 向下跨 ≥2 层（cliff）允许（跳下单向）。
 *
 * `walkable=1` 的格在任意层可走是既有碰撞语义；返回原层即表达「不改层」。
 */
function transitionLevel(
  geometry: MapGeometry,
  built: PathfindingBlockers | undefined,
  tileIndex: number,
  fromLevel: number,
): number {
  const connector = built?.connectors?.get(tileIndex);
  if (connector) {
    if (connector.dir === CONNECTOR_DIR_UP && fromLevel === connector.low) {
      return connector.high;
    }
    if (connector.dir !== CONNECTOR_DIR_UP && fromLevel === connector.high) {
      return connector.low;
    }
  }

  const terrainLevel = geometry.level[tileIndex] ?? 0;
  if (terrainLevel === fromLevel) return fromLevel;

  const delta = terrainLevel - fromLevel;
  if (Math.abs(delta) === 1) {
    const semantics = geometry.levelSemantics;
    if (semantics && geometry.tiles[tileIndex] === semantics.slope) {
      return terrainLevel;
    }
    return fromLevel;
  }
  // 自上而下跨崖（跳下）允许；低→高跨崖保持原层（非法过渡，等于不可达）。
  if (delta <= -2) return terrainLevel;
  return fromLevel;
}

/** 开放集节点（A* 搜索状态）。 */
interface SearchNode {
  index: number;
  level: number;
  x: number;
  y: number;
  g: number;
  h: number;
  f: number;
  seq: number;
  parent: SearchNode | null;
}

/** 节点比较：f → h → tile index → level → 入堆序号（确定性 tie-break）。 */
function nodeLess(a: SearchNode, b: SearchNode): boolean {
  if (a.f !== b.f) return a.f < b.f;
  if (a.h !== b.h) return a.h < b.h;
  if (a.index !== b.index) return a.index < b.index;
  if (a.level !== b.level) return a.level < b.level;
  return a.seq < b.seq;
}

/** 最小二叉堆（仅本模块使用；相等时按 nodeLess 决胜）。 */
class MinHeap {
  private readonly items: SearchNode[] = [];

  get size(): number {
    return this.items.length;
  }

  push(node: SearchNode): void {
    const items = this.items;
    items.push(node);
    let i = items.length - 1;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (!nodeLess(items[i]!, items[parent]!)) break;
      [items[i], items[parent]] = [items[parent]!, items[i]!];
      i = parent;
    }
  }

  pop(): SearchNode | undefined {
    const items = this.items;
    if (items.length === 0) return undefined;
    const top = items[0]!;
    const last = items.pop()!;
    if (items.length === 0) return top;
    items[0] = last;
    let i = 0;
    for (;;) {
      const left = i * 2 + 1;
      const right = left + 1;
      let smallest = i;
      if (left < items.length && nodeLess(items[left]!, items[smallest]!)) smallest = left;
      if (right < items.length && nodeLess(items[right]!, items[smallest]!)) smallest = right;
      if (smallest === i) break;
      [items[i], items[smallest]] = [items[smallest]!, items[i]!];
      i = smallest;
    }
    return top;
  }
}

/**
 * A* 寻路（含统计）。路径首元素为起点、末元素为终点；不可达/超限返回 null。
 *
 * @param geometry 地图几何数据
 * @param built 建造阻挡索引（缺省仅地形判定）
 * @param start 起点 tile + 层号（起点格本身不要求可走，允许从贴墙/非走格脱困）
 * @param goal 终点 tile + 层号（必须在该层可走，否则直接 null）
 * @param options 节点上限
 */
export function findPathWithStats(
  geometry: MapGeometry,
  built: PathfindingBlockers | undefined,
  start: PathTile,
  goal: PathTile,
  options: FindPathOptions = {},
): AStarResult {
  const maxNodes = options.maxNodes ?? DEFAULT_MAX_NODES;
  assertPathInput(start, goal, maxNodes);

  const { width, height } = geometry.grid;
  const inBounds = (x: number, y: number): boolean => x >= 0 && y >= 0 && x < width && y < height;
  if (!inBounds(start.x, start.y) || !inBounds(goal.x, goal.y)) {
    return { path: null, expandedNodes: 0, reason: "invalid" };
  }

  const { min: minLevel, span } = levelSpan(geometry, built, start, goal);
  const keyOf = (index: number, level: number): number => index * span + (level - minLevel);

  const startIndex = start.y * width + start.x;
  const goalIndex = goal.y * width + goal.x;

  const walkable = (index: number, level: number): boolean => {
    if (built?.walls?.get(level)?.has(index)) return false;
    const x = index % width;
    const y = Math.floor(index / width);
    return walkableAtLevel(geometry, x, y, level, built);
  };

  if (!walkable(goalIndex, goal.level)) {
    return { path: null, expandedNodes: 0, reason: "invalid" };
  }

  if (startIndex === goalIndex && start.level === goal.level) {
    return { path: [{ ...start }], expandedNodes: 1 };
  }

  const startKey = keyOf(startIndex, start.level);
  const heap = new MinHeap();
  const bestG = new Map<number, number>();
  const closed = new Set<number>();
  let seq = 0;

  const heuristic = (x: number, y: number): number =>
    Math.abs(x - goal.x) + Math.abs(y - goal.y);

  const startNode: SearchNode = {
    index: startIndex,
    level: start.level,
    x: start.x,
    y: start.y,
    g: 0,
    h: heuristic(start.x, start.y),
    f: heuristic(start.x, start.y),
    seq: seq++,
    parent: null,
  };
  bestG.set(startKey, 0);
  heap.push(startNode);

  let expandedNodes = 0;

  while (heap.size > 0) {
    const current = heap.pop()!;
    const currentKey = keyOf(current.index, current.level);
    if (closed.has(currentKey)) continue;
    if ((bestG.get(currentKey) ?? Number.POSITIVE_INFINITY) < current.g) continue;

    closed.add(currentKey);
    expandedNodes += 1;

    if (current.index === goalIndex && current.level === goal.level) {
      const path: PathTile[] = [];
      let node: SearchNode | null = current;
      while (node) {
        path.push({ x: node.x, y: node.y, level: node.level });
        node = node.parent;
      }
      path.reverse();
      return { path, expandedNodes };
    }

    // 已达上限：不再展开新节点（已展开的当前节点仍可能恰好是终点，已在上方返回）。
    if (expandedNodes >= maxNodes) {
      return { path: null, expandedNodes, reason: "limit" };
    }

    for (const [dx, dy] of NEIGHBORS) {
      const nx = current.x + dx;
      const ny = current.y + dy;
      if (!inBounds(nx, ny)) continue;
      const nIndex = ny * width + nx;
      const nextLevel = transitionLevel(geometry, built, nIndex, current.level);

      // 进入判定：当前层视角可走，或跨层后目标层视角可走（楼板/坡道）。
      const enterable =
        walkable(nIndex, current.level) ||
        (nextLevel !== current.level && walkable(nIndex, nextLevel));
      if (!enterable) continue;

      const nKey = keyOf(nIndex, nextLevel);
      if (closed.has(nKey)) continue;

      const g = current.g + 1;
      if (g >= (bestG.get(nKey) ?? Number.POSITIVE_INFINITY)) continue;

      const h = heuristic(nx, ny);
      const node: SearchNode = {
        index: nIndex,
        level: nextLevel,
        x: nx,
        y: ny,
        g,
        h,
        f: g + h,
        seq: seq++,
        parent: current,
      };
      bestG.set(nKey, g);
      heap.push(node);
    }
  }

  return { path: null, expandedNodes, reason: "unreachable" };
}

/** A* 寻路的简写：只取路径（null = 不可达/超限）。 */
export function findPath(
  geometry: MapGeometry,
  built: PathfindingBlockers | undefined,
  start: PathTile,
  goal: PathTile,
  options: FindPathOptions = {},
): PathTile[] | null {
  return findPathWithStats(geometry, built, start, goal, options).path;
}

/**
 * 直线视线检查（像素坐标）：沿途按 1/4 tile 步长采样，任一采样格在指定层
 * 不可走 / 有建造墙 → false。终点格额外校验（短距离采样可能跳过端点）。
 *
 * 用途：Chase/Flee 在「无墙阻挡」时直接沿用旧直线移动，只有被挡才跑 A*。
 * 起点格不检查（实体已在其中，允许贴墙脱困）。
 */
export function lineOfSightClear(
  geometry: MapGeometry,
  built: PathfindingBlockers | undefined,
  ax: number,
  ay: number,
  bx: number,
  by: number,
  level: number,
): boolean {
  const { width, height, tileWidth, tileHeight } = geometry.grid;
  const dx = bx - ax;
  const dy = by - ay;
  const dist = Math.hypot(dx, dy);
  if (!Number.isFinite(dist)) return false;
  if (dist <= 1e-6) return true;

  const tileSize = Math.min(tileWidth, tileHeight);
  if (!(tileSize > 0)) return false;
  const steps = Math.max(1, Math.ceil(dist / (tileSize / 4)));

  const blocked = (px: number, py: number): boolean => {
    const tx = Math.floor(px / tileWidth);
    const ty = Math.floor(py / tileHeight);
    if (tx < 0 || ty < 0 || tx >= width || ty >= height) return true;
    const index = ty * width + tx;
    if (built?.walls?.get(level)?.has(index)) return true;
    return !walkableAtLevel(geometry, tx, ty, level, built);
  };

  let previous = -1;
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    const px = ax + dx * t;
    const py = ay + dy * t;
    const tx = Math.floor(px / tileWidth);
    const ty = Math.floor(py / tileHeight);
    if (tx < 0 || ty < 0 || tx >= width || ty >= height) return false;
    const index = ty * width + tx;
    if (index === previous) continue;
    previous = index;
    if (blocked(px, py)) return false;
  }

  return !blocked(bx, by);
}
