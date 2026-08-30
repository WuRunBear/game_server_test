/**
 * 生成层出口结构校验（framework/map/generate/validate.ts）。
 *
 * 对 GeometryDraft / MapGeometry 做**纯结构**校验（无语义上下文）：
 * - 硬错误（抛错）：网格非空、tiles/walkable/regionOfTile 长度与
 *   width × height 一致、regions 非空、regionOfTile 索引落在 regions
 *   数量范围内（即每格区域索引可解析）；
 * - 软告警（logger.warn）：已声明但零覆盖的区域——结构合法但可疑，
 *   不阻断。
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

/** 校验输入：生成期草稿或冻结后的几何（结构字段同形）。 */
export type GeometryValidationInput = GeometryDraft | MapGeometry;

/**
 * 结构校验地图几何（原地校验，不修改输入）。
 *
 * 硬错误存在时抛错（消息含地图 key 与全部问题，问题消息点名具体
 * 缓冲/字段与数值）；无硬错误时对软告警逐条 logger.warn 后返回。
 *
 * @param input 几何草稿或冻结几何
 * @throws Error 当结构校验发现硬错误时
 */
export function validateMapGeometry(input: GeometryValidationInput): void {
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

  if (errors.length > 0) {
    throw new Error(`map "${input.key}": ${errors.join("; ")}`);
  }
  for (const warning of warnings) {
    logger.warn(warning);
  }
}
