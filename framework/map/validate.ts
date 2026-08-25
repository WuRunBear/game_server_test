/**
 * 统一地图校验器（framework/map/validate.ts）。
 *
 * 对 MapRuntime 做「内容制作就绪」性校验（纯函数，无副作用、无日志）：
 * - 硬错误（errors）：出生点不可用——player 出生点落在阻挡格 / 越界 / 缺失（null），
 *   以及任一 NPC 出生点落在阻挡格 / 越界。这类缺失意味着地图无法游玩，属「必坏图」；
 * - 软告警（warnings）：最大 4 向连通的可走域占比低于阈值——洞穴/洞窟类地图天然存在
 *   封闭空腔，不可达 ≠ 坏图（D1），因此只告警不阻断。
 *
 * 校验器本身不抛错、不记日志，返回 { errors, warnings } 报告；由 buildMapRuntime
 * 在出口处依据 errors 抛错、并对 warnings 逐条 logger.warn（保证可单独测试）。
 *
 * 坐标约定：网格按 width*height 展平、行主序（blocked[y*width+x]，x=列，y=行），
 * 0=可走、1=阻挡。出生点为世界（像素）坐标，校验时换算为 tile 坐标。
 */
import type { MapRuntime } from "framework/map/types";

/** 可走域最大连通域占全部可走 tile 的比例阈值（低于此值触发软告警，不阻断）。 */
export const MIN_WALKABLE_COMPONENT_FRACTION = 0.4;

/** 校验报告：errors 为构建时需抛错的硬错误，warnings 为仅记日志的软告警。 */
export interface ValidationReport {
  /** 硬错误列表（非空时调用方应拒绝构建该地图）。 */
  errors: string[];
  /** 软告警列表（仅用于日志，阻断与否由调用方决定）。 */
  warnings: string[];
}

/**
 * 计算 4 向连通的可走域最大连通域大小（格数）。
 *
 * 采用 BFS 洪泛填充：visited 标记已访问，queue 复用同一 Int32Array，
 * 每个可走格只入队一次。确定性、纯函数。
 *
 * @param blocked 展平阻挡网格（行主序，0=可走，1=阻挡）
 * @param width 网格宽（列数）
 * @param height 网格高（行数）
 * @returns 最大连通域的格数；无可走格时返回 0
 */
function largestWalkableComponent(blocked: Uint8Array, width: number, height: number): number {
  const total = width * height;
  const visited = new Uint8Array(total);
  const queue = new Int32Array(total);
  let largest = 0;

  for (let start = 0; start < total; start++) {
    if (blocked[start] !== 0 || visited[start] !== 0) continue; // 墙或已访问：跳过

    let head = 0;
    let tail = 0;
    queue[tail] = start;
    tail++;
    visited[start] = 1;
    let count = 0;

    while (head < tail) {
      const idx = queue[head];
      head++;
      count++;

      const y = (idx / width) | 0;
      const x = idx - y * width;

      // 上
      if (y > 0) {
        const n = idx - width;
        if (visited[n] === 0 && blocked[n] === 0) {
          visited[n] = 1;
          queue[tail] = n;
          tail++;
        }
      }
      // 下
      if (y < height - 1) {
        const n = idx + width;
        if (visited[n] === 0 && blocked[n] === 0) {
          visited[n] = 1;
          queue[tail] = n;
          tail++;
        }
      }
      // 左
      if (x > 0) {
        const n = idx - 1;
        if (visited[n] === 0 && blocked[n] === 0) {
          visited[n] = 1;
          queue[tail] = n;
          tail++;
        }
      }
      // 右
      if (x < width - 1) {
        const n = idx + 1;
        if (visited[n] === 0 && blocked[n] === 0) {
          visited[n] = 1;
          queue[tail] = n;
          tail++;
        }
      }
    }

    if (count > largest) largest = count;
  }

  return largest;
}

/**
 * 校验 MapRuntime：返回 { errors, warnings }。
 *
 * 出生点由世界（像素）坐标换算为 tile 坐标后校验：
 * - 越界 → 硬错误；落在阻挡格 → 硬错误；player 为 null → 硬错误；
 * - 反之，最大 4 向连通域占比低于 MIN_WALKABLE_COMPONENT_FRACTION → 软告警。
 *
 * @param runtime 地图运行时数据
 * @returns 校验报告（errors 非空 = 地图不可用；warnings 非空 = 需关注的连通性）
 */
export function validateMapRuntime(runtime: MapRuntime): ValidationReport {
  const errors: string[] = [];
  const warnings: string[] = [];

  const { grid, blocked, spawns } = runtime;
  const { width, height, tileWidth, tileHeight } = grid;

  const inBounds = (x: number, y: number): boolean =>
    x >= 0 && y >= 0 && x < width && y < height;
  const isBlocked = (x: number, y: number): boolean => blocked[y * width + x] === 1;

  // player 出生点
  if (spawns.player === null) {
    errors.push("player spawn is missing");
  } else {
    const tx = Math.floor(spawns.player.x / tileWidth);
    const ty = Math.floor(spawns.player.y / tileHeight);
    if (!inBounds(tx, ty)) {
      errors.push(`player spawn at (${tx}, ${ty}) is out of grid bounds`);
    } else if (isBlocked(tx, ty)) {
      errors.push(`player spawn at (${tx}, ${ty}) is blocked`);
    }
  }

  // NPC 出生点
  for (const npc of spawns.npcs) {
    const tx = Math.floor(npc.pos.x / tileWidth);
    const ty = Math.floor(npc.pos.y / tileHeight);
    if (!inBounds(tx, ty)) {
      errors.push(`npc spawn "${npc.kind}" at (${tx}, ${ty}) is out of grid bounds`);
    } else if (isBlocked(tx, ty)) {
      errors.push(`npc spawn "${npc.kind}" at (${tx}, ${ty}) is blocked`);
    }
  }

  // 连通性软告警：最大可走连通域占比低于阈值
  let floorTiles = 0;
  for (let i = 0; i < blocked.length; i++) {
    if (blocked[i] === 0) floorTiles++;
  }
  if (floorTiles > 0) {
    const largest = largestWalkableComponent(blocked, width, height);
    const fraction = largest / floorTiles;
    if (fraction < MIN_WALKABLE_COMPONENT_FRACTION) {
      const pct = Math.round(fraction * 100);
      const thresholdPct = Math.round(MIN_WALKABLE_COMPONENT_FRACTION * 100);
      warnings.push(`largest walkable component covers ${pct}% of floor (threshold ${thresholdPct}%)`);
    }
  }

  return { errors, warnings };
}
