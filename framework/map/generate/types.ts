/**
 * 生成层类型定义（framework/map/generate/types.ts）。
 *
 * 生成层是「配置 → 几何」的纯生产管线：地图配置（MapGenerationConfig）
 * 声明一个积木管道，每个积木（MapGenerator）在 GenerationContext 中向
 * GeometryDraft 累积写入地理缓冲，管道终态把 draft 冻结为不可变的
 * MapGeometry（见 geometry/types.ts）。积木间的非地理结构化中间产物经
 * draft 的 aux 槽位池传递（仅管道执行期，冻结时丢弃，见 AuxSlot）。
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
 * - key 为地图稳定标识，冻结时原样带入 MapGeometry；
 * - aux 为积木间结构化中间产物暂存池：仅存在于 buildMapGeometry 执行期，
 *   不进快照、不参与内容指纹与出口校验，冻结为 MapGeometry 时天然丢弃。
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
  /**
   * 结构化中间产物暂存池（仅管道执行期存活）：供积木间传递非地理数据，
   * 上游积木 setAux 写入、下游积木 getAux 读取。仅存在于 buildMapGeometry
   * 内部——不进快照、不参与内容指纹与出口校验，冻结为 MapGeometry 时
   * 天然丢弃。读写一律经 branded 槽位（见 AuxSlot / setAux / getAux）。
   */
  aux: Map<string, unknown>;
}

/**
 * 创建空白的几何草稿（零尺寸、零长缓冲、空区域表、空 aux 池）。
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
    aux: new Map<string, unknown>(),
  };
}

/**
 * aux 槽位键（branded 类型）：T 为该槽位承载值的类型，编码在品牌字段的
 * 返回值（协变）位置——不同 T 的槽位在结构类型检查下互不兼容，把 A 槽
 * 的值写进 B 槽会在编译期报错（运行时品牌字段不参与任何行为）。
 *
 * 槽位名命名约定："<积木名>.<产物>"（如 "room-corridor.rooms"），积木名
 * 即其在注册表中的 id，保证跨积木传递的键不冲突。
 *
 * 框架不预置任何槽位：具体槽位常量由各积木自带（经 defineAuxSlot 声明），
 * 协作积木双方引用同一常量即可完成传递。
 */
export interface AuxSlot<T> {
  /** 槽位名（aux 池的键，跨积木协作双方共用）。 */
  readonly name: string;
  /** 类型品牌占位：仅存在于类型层，运行时永不调用。 */
  readonly brand: (value: never) => T;
}

/**
 * 声明一个 branded 槽位常量（积木自带槽位的推荐入口）。
 *
 * @param name 槽位名（aux 池的键）
 * @returns 带品牌标记的槽位键
 */
export function defineAuxSlot<T>(name: string): AuxSlot<T> {
  return { name, brand: (value) => value as T };
}

/**
 * 向草稿的 aux 槽位写入结构化中间产物（同槽覆盖旧值）。
 *
 * @param draft 目标几何草稿
 * @param slot branded 槽位键
 * @param value 要写入的值（类型由槽位约束）
 */
export function setAux<T>(draft: GeometryDraft, slot: AuxSlot<T>, value: T): void {
  draft.aux.set(slot.name, value);
}

/**
 * 读取草稿的 aux 槽位。
 *
 * @param draft 来源几何草稿
 * @param slot branded 槽位键
 * @returns 槽位值；未写入时为 undefined
 */
export function getAux<T>(draft: GeometryDraft, slot: AuxSlot<T>): T | undefined {
  return draft.aux.get(slot.name) as T | undefined;
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
