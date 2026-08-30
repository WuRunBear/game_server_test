/**
 * 生成层类型定义（framework/map/generate/types.ts）。
 *
 * 生成层是「配置 → 几何」的纯生产管线：地图配置（MapGenerationConfig）
 * 声明一个积木管道，每个积木（MapGenerator）在 GenerationContext 中向
 * GeometryDraft 累积写入地理缓冲，管道终态把 draft 冻结为不可变的
 * MapGeometry（见 geometry/types.ts）。
 *
 * 纯几何生产层：不 import bitecs/ECS/任何 world 类型，不产出实体。
 */

import type { RegionMeta } from "map/geometry/types";
import type { Rng } from "map/generate/rng";

/**
 * 生成期可变几何草稿：各积木按管道顺序向其累积写入，冻结前仅存在于
 * buildMapGeometry 内部。
 *
 * 字段与 MapGeometry 一一对应（grid 摊平为四个标量），全部可变：
 * - 首个积木负责设定 width/height/tileWidth/tileHeight 并分配
 *   tiles/walkable/regionOfTile 缓冲（长度 = width × height，行主序）；
 * - regions 为「区域名 → 元信息」Map，插入顺序即 regionOfTile 的索引序；
 * - key 为地图稳定标识，冻结时原样带入 MapGeometry。
 */
export interface GeometryDraft {
  /** 地图 key（registry 中的稳定标识）。 */
  key: string;
  /** 地图宽度（tile 数）。 */
  width: number;
  /** 地图高度（tile 数）。 */
  height: number;
  /** 单个 tile 的宽度（像素）。 */
  tileWidth: number;
  /** 单个 tile 的高度（像素）。 */
  tileHeight: number;
  /** 每格地面语义 id（行主序展平，纯数字，含义映射在 game 配置）。 */
  tiles: Uint8Array;
  /** 每格通行位图（行主序展平，1=可通行，0=不可通行）。 */
  walkable: Uint8Array;
  /** 区域名 → 区域元信息（插入顺序即 regionOfTile 的索引序）。 */
  regions: Map<string, RegionMeta>;
  /** 每格所属区域的索引（行主序展平，指向 regions 的插入顺序）。 */
  regionOfTile: Uint16Array;
}

/**
 * 创建空白的几何草稿（零尺寸、零长缓冲、空区域表）。
 *
 * @param key 地图 key
 * @returns 可变 GeometryDraft
 */
export function createGeometryDraft(key: string): GeometryDraft {
  return {
    key,
    width: 0,
    height: 0,
    tileWidth: 0,
    tileHeight: 0,
    tiles: new Uint8Array(0),
    walkable: new Uint8Array(0),
    regions: new Map<string, RegionMeta>(),
    regionOfTile: new Uint16Array(0),
  };
}

/**
 * 生成积木的执行上下文：一次管道步骤的全部输入。
 *
 * params 为该步骤在配置中声明的**自有参数切片**（未声明时为空对象），
 * 由积木自行收窄解释——框架不理解参数含义。
 */
export interface GenerationContext {
  /** 地图 key（与 geometry.key 一致）。 */
  key: string;
  /** 本步骤的独立确定性随机流（由总 seed + 步骤序号派生）。 */
  rng: Rng;
  /** 累积写入目标的几何草稿。 */
  geometry: GeometryDraft;
  /** 本步骤的自有配置参数切片（积木自行解释）。 */
  params: unknown;
}

/**
 * 生成积木：接收执行上下文，向 ctx.geometry 累积写入地理数据。
 *
 * 无返回值——产出只经 geometry 草稿传递；签名沿用旧生成器注册表的
 * 「名 → 函数」注册形状。
 */
export type MapGenerator = (ctx: GenerationContext) => void;

/** 管道单步骤声明：引用一个已注册积木及其自有参数。 */
export interface MapGenerationStep {
  /** 积木注册名（generatorRegistry 中的 id）。 */
  generator: string;
  /** 该步骤的自有参数切片（可选，原样透传给积木）。 */
  params?: Record<string, unknown>;
}

/**
 * 单张地图的生成配置：地图 key + 随机种子 + 积木管道。
 *
 * 管道按数组声明顺序执行；同 seed 同配置产出深相等的 MapGeometry。
 * 保持最小通用形状——todo 侧的 zod schema 按此形状对齐。
 */
export interface MapGenerationConfig {
  /** 地图 key（registry 中的稳定标识）。 */
  key: string;
  /** 随机种子（各管道步骤经 deriveStream 派生独立流）。 */
  seed: number;
  /** 积木管道（按声明顺序执行）。 */
  pipeline: MapGenerationStep[];
}
