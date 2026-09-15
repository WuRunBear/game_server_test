/**
 * 生成层出口结构校验（framework/map/generate/validate.ts）。
 *
 * 对 GeometryDraft / MapGeometry 做**纯结构**校验（无语义上下文）：
 * - 硬错误（抛错）：网格非空、tiles/walkable/regionOfTile 长度与
 *   width × height 一致、regions 非空、regionOfTile 索引落在 regions
 *   数量范围内（即每格区域索引可解析）；
 * - 软告警（logger.warn）：已声明但零覆盖的区域——结构合法但可疑，
 *   不阻断；
 * - 软告警（logger.warn）：可通行连通性——对 walkable=1 格做 4-邻接
 *   BFS 连通域标记，统计连通域数量与最大域占比；无可通行格，或存在
 *   多个连通域且最大域占比低于阈值（可配置，缺省
 *   DEFAULT_MIN_MAIN_DOMAIN_SHARE）时告警，不阻断。连通性是纯结构
 *   属性、不依赖游戏语义，符合「软告警不阻断」定位。
 *
 * 「地面语义 → 通行位图」一致性**不在此校验**：本层没有语义上下文，
 * 该一致性由各积木自行保证并以积木单测覆盖。
 *
 * 风格对齐 framework/map/buildRuntime.ts：校验器发现硬错误即抛错
 * （消息含地图 key 与具体问题），软告警逐条 logger.warn。
 */
import type { MapGeometry } from "map/geometry/types";
import type { GeometryDraft } from "map/generate/types";
import { createLogger } from "framework/utils/logger";

/** 校验日志器（游戏无关 scope），与 buildRuntime.ts 同 scope。 */
const logger = createLogger("build-map");

/** 连通性软告警缺省阈值：最大可通行域占全部可通行格的最低占比。 */
export const DEFAULT_MIN_MAIN_DOMAIN_SHARE = 0.9;

/** 连通性校验可选项（全部可省，缺省 = 缺省阈值）。 */
export interface ConnectivityCheckOptions {
  /**
   * 最大可通行域占比的告警下界（[0, 1]）：存在多个连通域且最大域占比
   * 低于该值时告警。缺省 DEFAULT_MIN_MAIN_DOMAIN_SHARE。
   */
  minMainDomainShare?: number;
}

/** 校验输入：生成期草稿或冻结后的几何（结构字段同形）。 */
export type GeometryValidationInput = GeometryDraft | MapGeometry;

/**
 * 对可通行位图做 4-邻接 BFS 连通域标记（只读，不改输入）。
 *
 * @param walkable 通行位图（行主序）
 * @param width 网格宽度
 * @param height 网格高度
 * @returns [连通域数量, 最大域格数]
 */
function walkableDomains(walkable: Uint8Array, width: number, height: number): [number, number] {
  const seen = new Uint8Array(walkable.length);
  const stack: number[] = [];
  let domains = 0;
  let largest = 0;
  for (let start = 0; start < walkable.length; start++) {
    if (walkable[start] !== 1 || seen[start] === 1) continue;
    domains++;
    let size = 0;
    seen[start] = 1;
    stack.push(start);
    while (stack.length > 0) {
      const index = stack.pop() as number;
      size++;
      const x = index % width;
      const y = (index - x) / width;
      // 4-邻接压栈（越界跳过）
      if (x > 0 && walkable[index - 1] === 1 && seen[index - 1] === 0) {
        seen[index - 1] = 1;
        stack.push(index - 1);
      }
      if (x < width - 1 && walkable[index + 1] === 1 && seen[index + 1] === 0) {
        seen[index + 1] = 1;
        stack.push(index + 1);
      }
      if (y > 0 && walkable[index - width] === 1 && seen[index - width] === 0) {
        seen[index - width] = 1;
        stack.push(index - width);
      }
      if (y < height - 1 && walkable[index + width] === 1 && seen[index + width] === 0) {
        seen[index + width] = 1;
        stack.push(index + width);
      }
    }
    if (size > largest) largest = size;
  }
  return [domains, largest];
}

/**
 * 结构校验地图几何（原地校验，不修改输入）。
 *
 * 硬错误存在时抛错（消息含地图 key 与全部问题，问题消息点名具体
 * 缓冲/字段与数值）；无硬错误时对软告警逐条 logger.warn 后返回。
 *
 * @param input 几何草稿或冻结几何
 * @param options 连通性软告警可选项（可省）
 * @returns 全部软告警消息（供调用方测试/上报；日志照常逐条输出）
 * @throws Error 当结构校验发现硬错误时
 */
export function validateMapGeometry(
  input: GeometryValidationInput,
  options?: ConnectivityCheckOptions,
): string[] {
  const errors: string[] = [];
  const warnings: string[] = [];

  // 草稿把 grid 摊平为四个标量，冻结几何为嵌套 grid——统一取值
  const { width, height } = "grid" in input ? input.grid : input;
  const { tiles, walkable, regions, regionOfTile } = input;
  const total = width * height;

  // 网格非空
  if (width <= 0 || height <= 0) {
    errors.push(`grid is empty (width=${width}, height=${height})`);
  }

  // 缓冲长度与 width × height 一致
  if (tiles.length !== total) {
    errors.push(`tiles length ${tiles.length} != width*height ${total}`);
  }
  if (walkable.length !== total) {
    errors.push(`walkable length ${walkable.length} != width*height ${total}`);
  }
  if (regionOfTile.length !== total) {
    errors.push(`regionOfTile length ${regionOfTile.length} != width*height ${total}`);
  }

  // regions 非空
  if (regions.size === 0) {
    errors.push("regions is empty (no region declared)");
  }

  // regionOfTile 索引合法（落在 regions 数量内，即每格区域可解析）。
  // 前置条件（长度一致且 regions 非空）不成立时跳过——主错误已足以拒绝构建。
  if (regionOfTile.length === total && regions.size > 0) {
    for (let i = 0; i < regionOfTile.length; i++) {
      const regionIndex = regionOfTile[i];
      if (regionIndex >= regions.size) {
        errors.push(
          `regionOfTile[${i}]=${regionIndex} out of range (regions count ${regions.size})`,
        );
        break;
      }
    }
  }

  // 软告警：已声明但零覆盖的区域（结构合法但可疑，不阻断）
  if (regionOfTile.length === total && regions.size > 0) {
    const covered = new Uint8Array(regions.size);
    for (let i = 0; i < regionOfTile.length; i++) {
      covered[regionOfTile[i]] = 1;
    }
    let index = 0;
    for (const [name] of regions) {
      if (covered[index] === 0) {
        warnings.push(`map "${input.key}": region "${name}" covers no tiles`);
      }
      index++;
    }
  }

  // 软告警：可通行连通性（只在通行位图长度一致时求值；不阻断）
  if (walkable.length === total && total > 0) {
    let walkableCount = 0;
    for (let i = 0; i < walkable.length; i++) {
      if (walkable[i] === 1) walkableCount++;
    }
    if (walkableCount === 0) {
      warnings.push(`map "${input.key}": no walkable tiles (whole map impassable)`);
    } else {
      const [domains, largest] = walkableDomains(walkable, width, height);
      const minShare = options?.minMainDomainShare ?? DEFAULT_MIN_MAIN_DOMAIN_SHARE;
      if (domains > 1 && largest / walkableCount < minShare) {
        const share = ((largest / walkableCount) * 100).toFixed(1);
        warnings.push(
          `map "${input.key}": walkable area splits into ${domains} domains, largest covers only ${share}% of walkable tiles`,
        );
      }
    }
  }

  if (errors.length > 0) {
    throw new Error(`map "${input.key}": ${errors.join("; ")}`);
  }
  for (const warning of warnings) {
    logger.warn(warning);
  }
  return warnings;
}
