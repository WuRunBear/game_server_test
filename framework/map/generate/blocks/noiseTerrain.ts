/**
 * 生成积木 "noise-terrain"（framework/map/generate/blocks/noiseTerrain.ts）。
 *
 * 管道首积木：值噪声/fBm 生成地面语义分布，并派生通行位图。
 * - 设定 draft 的 width/height/tileWidth/tileHeight，并分配 tiles/walkable/
 *   regionOfTile 缓冲（行主序，长度 = width × height）；
 * - 每格采样多倍频值噪声（fBm，归一化到 [0, 1)），可选经指数重映射
 *   （redistribution）与径向掩膜衰减（falloff）整形采样值后，按
 *   groundPalette 的累计阈值带（升序上界，噪声值 ≤ 上界 → 该带语义 id）
 *   映射为数字语义 id；语义 id 的含义命名映射整体在 game 配置，框架只见
 *   数字；
 * - walkable 由 nonWalkableSemantics 派生：语义 ∈ 集合 → 0，否则 1；
 * - 全部随机性取自 ctx.rng（管道派生流）：晶格随机值按「层序 × 行主序」
 *   固定顺序抽取，同 params 同 seed 确定复现。
 *
 * 纯几何生产：不 import ECS/world，不做文件 I/O，不含游戏专属语义。
 */
import type { Rng } from "map/generate/rng";
import type { GenerationContext } from "map/generate/types";

/** 噪声特征：基频晶格间距（tile 数，逐层减半）的缺省值。 */
const DEFAULT_BASE_CELL_TILES = 8;
/** 噪声特征：fBm 叠加层数的缺省值。 */
const DEFAULT_OCTAVES = 4;
/** 噪声特征：逐层振幅衰减系数（固定常量，不参数化）。 */
const GAIN = 0.5;

/** 采样参数边界：falloff 径向掩膜 ∈ [0, 0.9]（0 = 关闭）。 */
const FALLOFF_MAX = 0.9;
/** 采样参数边界：redistribution 指数 ∈ [0.5, 1.5]（1 = 现状）。 */
const REDISTRIBUTION_MIN = 0.5;
const REDISTRIBUTION_MAX = 1.5;
/** 采样参数边界：octaves 层数 ∈ [1, 8]。 */
const OCTAVES_MIN = 1;
const OCTAVES_MAX = 8;
/** 采样参数边界：基频晶格间距 ∈ [2, 64] tile。 */
const BASE_CELL_MIN = 2;
const BASE_CELL_MAX = 64;

/** 单条阈值带：语义 id + 累计上界（升序排列后覆盖 (0, 1]，末位为 1）。 */
interface TerrainBand {
  /** 地面语义 id（数字，含义映射在 game 配置）。 */
  id: number;
  /** 累计上界：噪声值 ≤ 上界 → 该带。 */
  bound: number;
}

/** 收窄校验后的积木参数。 */
interface NoiseTerrainParams {
  /** 地图宽度（tile 数，正整数）。 */
  width: number;
  /** 地图高度（tile 数，正整数）。 */
  height: number;
  /** 单 tile 宽（像素，正数）。 */
  tileWidth: number;
  /** 单 tile 高（像素，正数）。 */
  tileHeight: number;
  /** 阈值带表（按 bound 升序，末位 bound = 1）。 */
  bands: TerrainBand[];
  /** 不可通行语义 id 集合。 */
  nonWalkable: Set<number>;
  /** 径向掩膜强度（[0, 0.9]，0 = 关闭 = 现状）。 */
  falloff: number;
  /** 归一化后指数重映射指数（[0.5, 1.5]，1 = 现状）。 */
  redistribution: number;
  /** fBm 叠加层数（[1, 8]，缺省 4 = 现状）。 */
  octaves: number;
  /** 基频晶格间距 tile 数（[2, 64]，缺省 8 = 现状）。 */
  baseCellTiles: number;
}

/** 抛出点名地图 key 与具体配置项的参数错误。 */
function fail(mapKey: string, detail: string): never {
  throw new Error(`map "${mapKey}": noise-terrain params ${detail}`);
}

/** 校验并取回一个正整数字段。 */
function requirePositiveInt(params: Record<string, unknown>, key: string, mapKey: string): number {
  const value = params[key];
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    fail(mapKey, `${key} must be a positive integer, got ${String(value)}`);
  }
  return value;
}

/** 校验并取回一个正数字段。 */
function requirePositiveNumber(params: Record<string, unknown>, key: string, mapKey: string): number {
  const value = params[key];
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    fail(mapKey, `${key} must be a positive number, got ${String(value)}`);
  }
  return value;
}

/**
 * 校验并取回一个可选的有界数字段：缺省时返回缺省值；提供时必须为
 * 有限数字且落在 [min, max]，越界/类型错误即抛错（fail-fast，不 clamp）。
 */
function optionalBoundedNumber(
  params: Record<string, unknown>,
  key: string,
  mapKey: string,
  min: number,
  max: number,
  fallback: number,
): number {
  const raw = params[key];
  if (raw === undefined) return fallback;
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw < min || raw > max) {
    fail(mapKey, `${key} must be a number in [${min}, ${max}], got ${String(raw)}`);
  }
  return raw;
}

/**
 * 校验并取回一个可选的有界整数字段：缺省时返回缺省值；提供时必须为
 * 整数且落在 [min, max]，越界/类型错误即抛错。
 */
function optionalBoundedInt(
  params: Record<string, unknown>,
  key: string,
  mapKey: string,
  min: number,
  max: number,
  fallback: number,
): number {
  const raw = params[key];
  if (raw === undefined) return fallback;
  if (typeof raw !== "number" || !Number.isInteger(raw) || raw < min || raw > max) {
    fail(mapKey, `${key} must be an integer in [${min}, ${max}], got ${String(raw)}`);
  }
  return raw;
}

/**
 * 校验并收窄阈值带表：键为 [0, 255] 规范整数字符串语义 id（tiles 是
 * Uint8Array），值为 (0, 1] 累计上界；升序排列后须严格递增、末位为 1
 * （完整覆盖 [0, 1]，任何噪声值都有归属带），且最小带界须等于 bandLevel。
 */
function parseBands(raw: unknown, bandLevel: number, mapKey: string): TerrainBand[] {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    fail(mapKey, "groundPalette must be an object of semantic id -> band bound");
  }
  const bands: TerrainBand[] = [];
  for (const [key, bound] of Object.entries(raw as Record<string, unknown>)) {
    const id = Number(key);
    if (!Number.isInteger(id) || id < 0 || id > 255 || String(id) !== key) {
      fail(mapKey, `groundPalette key "${key}" must be an integer semantic id in [0, 255]`);
    }
    if (typeof bound !== "number" || !Number.isFinite(bound) || bound <= 0 || bound > 1) {
      fail(mapKey, `groundPalette["${key}"] must be a number in (0, 1], got ${String(bound)}`);
    }
    bands.push({ id, bound });
  }
  if (bands.length === 0) {
    fail(mapKey, "groundPalette must declare at least one band");
  }
  bands.sort((a, b) => a.bound - b.bound);
  for (let i = 1; i < bands.length; i++) {
    if (bands[i].bound === bands[i - 1].bound) {
      fail(mapKey, `groundPalette band bounds must be strictly increasing (duplicate bound ${bands[i].bound})`);
    }
  }
  const highest = bands[bands.length - 1];
  if (highest.bound !== 1) {
    fail(mapKey, `groundPalette bounds must cover [0, 1] (largest bound is ${highest.bound})`);
  }
  const lowest = bands[0];
  if (lowest.bound !== bandLevel) {
    fail(mapKey, `bandLevel (${bandLevel}) must equal the lowest groundPalette band bound (${lowest.bound})`);
  }
  return bands;
}

/**
 * 从 ctx.params 收窄积木参数：逐项校验，缺失/非法即抛出点名具体配置项的错误。
 *
 * @param params 管道透传的本步骤参数切片
 * @param mapKey 地图 key（错误消息定位用）
 * @returns 可信参数形状
 */
function parseParams(params: unknown, mapKey: string): NoiseTerrainParams {
  if (typeof params !== "object" || params === null || Array.isArray(params)) {
    fail(mapKey, "must be an object");
  }
  const p = params as Record<string, unknown>;

  const width = requirePositiveInt(p, "width", mapKey);
  const height = requirePositiveInt(p, "height", mapKey);
  const tileWidth = requirePositiveNumber(p, "tileWidth", mapKey);
  const tileHeight = requirePositiveNumber(p, "tileHeight", mapKey);

  const bandLevel = p.bandLevel;
  if (typeof bandLevel !== "number" || !Number.isFinite(bandLevel) || bandLevel < 0 || bandLevel > 1) {
    fail(mapKey, `bandLevel must be a number in [0, 1], got ${String(bandLevel)}`);
  }

  const bands = parseBands(p.groundPalette, bandLevel, mapKey);

  const nonWalkableRaw = p.nonWalkableSemantics;
  if (!Array.isArray(nonWalkableRaw)) {
    fail(mapKey, "nonWalkableSemantics must be an array of semantic ids");
  }
  const nonWalkable = new Set<number>();
  for (const entry of nonWalkableRaw) {
    if (typeof entry !== "number" || !Number.isInteger(entry) || entry < 0 || entry > 255) {
      fail(mapKey, `nonWalkableSemantics entries must be integers in [0, 255], got ${String(entry)}`);
    }
    nonWalkable.add(entry);
  }

  return {
    width,
    height,
    tileWidth,
    tileHeight,
    bands,
    nonWalkable,
    falloff: optionalBoundedNumber(p, "falloff", mapKey, 0, FALLOFF_MAX, 0),
    redistribution: optionalBoundedNumber(p, "redistribution", mapKey, REDISTRIBUTION_MIN, REDISTRIBUTION_MAX, 1),
    octaves: optionalBoundedInt(p, "octaves", mapKey, OCTAVES_MIN, OCTAVES_MAX, DEFAULT_OCTAVES),
    baseCellTiles: optionalBoundedInt(p, "baseCellTiles", mapKey, BASE_CELL_MIN, BASE_CELL_MAX, DEFAULT_BASE_CELL_TILES),
  };
}

/** 单倍频值噪声晶格：cell 为晶格间距（tile 数），values 为行主序晶格随机值。 */
interface NoiseLattice {
  cell: number;
  cols: number;
  values: Float64Array;
}

/**
 * 为各倍频层构建晶格：第 o 层间距 = baseCellTiles / 2^o，晶格随机值按
 * 「层序 × 行主序」从 rng 固定顺序抽取（确定性的唯一来源）。
 */
function buildLattices(width: number, height: number, rng: Rng, octaves: number, baseCellTiles: number): NoiseLattice[] {
  const lattices: NoiseLattice[] = [];
  for (let octave = 0; octave < octaves; octave++) {
    const cell = baseCellTiles / 2 ** octave;
    const cols = Math.ceil(width / cell) + 1;
    const rows = Math.ceil(height / cell) + 1;
    const values = new Float64Array(cols * rows);
    for (let i = 0; i < values.length; i++) {
      values[i] = rng.next();
    }
    lattices.push({ cell, cols, values });
  }
  return lattices;
}

/** 平滑插值曲线（smoothstep）。 */
function smooth(t: number): number {
  return t * t * (3 - 2 * t);
}

/** 五次 smootherstep 曲线（6t^5 - 15t^4 + 10t^3，两端导数为零）。 */
function smootherstep(t: number): number {
  return t * t * t * (t * (t * 6 - 15) + 10);
}

/**
 * 径向掩膜衰减系数：按"距地图边缘的归一化距离"衰减采样值。
 *
 * d = 最近边距 / (较短边长的一半)，边缘 0、地图中心 1；falloff 即海洋环带
 * 的归一化宽度——d ≥ falloff 的内部不衰减（系数 1），d ∈ [0, falloff) 的
 * 环带内越靠边缘衰减越强，边缘处经 smootherstep 平滑趋零。同
 * (width, height, falloff) 的系数是纯几何函数，与随机流无关。
 */
function falloffFactor(x: number, y: number, width: number, height: number, falloff: number): number {
  const halfMin = Math.min(width, height) / 2;
  const edgeDist = Math.min(x, y, width - 1 - x, height - 1 - y);
  const d = Math.min(1, edgeDist / halfMin);
  const t = Math.min(1, d / falloff);
  return smootherstep(t);
}

/** 双线性 + smoothstep 采样晶格（晶格尺寸保证索引不越界）。 */
function sampleLattice(lattice: NoiseLattice, x: number, y: number): number {
  const u = x / lattice.cell;
  const v = y / lattice.cell;
  const ix = Math.floor(u);
  const iy = Math.floor(v);
  const tx = smooth(u - ix);
  const ty = smooth(v - iy);
  const base = iy * lattice.cols + ix;
  const v00 = lattice.values[base];
  const v10 = lattice.values[base + 1];
  const v01 = lattice.values[base + lattice.cols];
  const v11 = lattice.values[base + lattice.cols + 1];
  const low = v00 + (v10 - v00) * tx;
  const high = v01 + (v11 - v01) * tx;
  return low + (high - low) * ty;
}

/** fBm：各倍频层采样按振幅叠加后归一化到 [0, 1)。 */
function sampleFbm(lattices: NoiseLattice[], x: number, y: number): number {
  let amplitude = 1;
  let total = 0;
  let amplitudeSum = 0;
  for (const lattice of lattices) {
    total += amplitude * sampleLattice(lattice, x, y);
    amplitudeSum += amplitude;
    amplitude *= GAIN;
  }
  return total / amplitudeSum;
}

/**
 * 生成积木 "noise-terrain"：值噪声/fBm 地面语义 + 派生通行位图。
 *
 * @param ctx 生成上下文（params 由本积木收窄校验）
 * @throws Error 当 params 缺失/非法，或 geometry 草稿已被初始化
 *   （本积木必须是管道首积木）时
 */
export function noiseTerrain(ctx: GenerationContext): void {
  const params = parseParams(ctx.params, ctx.key);
  const draft = ctx.geometry;
  if (draft.width !== 0 || draft.height !== 0 || draft.tiles.length !== 0) {
    throw new Error(
      `map "${ctx.key}": geometry draft already initialized; noise-terrain must be the first pipeline block`,
    );
  }

  const { width, height } = params;
  const size = width * height;
  draft.width = width;
  draft.height = height;
  draft.tileWidth = params.tileWidth;
  draft.tileHeight = params.tileHeight;
  draft.tiles = new Uint8Array(size);
  draft.walkable = new Uint8Array(size);
  draft.regionOfTile = new Uint16Array(size);

  const lattices = buildLattices(width, height, ctx.rng, params.octaves, params.baseCellTiles);
  const bands = params.bands;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let level = sampleFbm(lattices, x, y);
      // 分带前的采样值整形（均不影响 bandLevel 与 groundPalette 的校验语义）：
      // 1. 指数重映射 level = level^exponent（整体平移各带覆盖率）；
      // 2. 径向掩膜向边缘衰减 level（falloff = 0 时完全跳过，保持现状逐位一致）
      if (params.redistribution !== 1) {
        level = level ** params.redistribution;
      }
      if (params.falloff > 0) {
        level *= falloffFactor(x, y, width, height, params.falloff);
      }
      // bands 末位 bound = 1 且 level ∈ [0, 1)，扫描必命中；初始化仅为类型收窄
      let id = bands[bands.length - 1].id;
      for (const band of bands) {
        if (level <= band.bound) {
          id = band.id;
          break;
        }
      }
      const index = y * width + x;
      draft.tiles[index] = id;
      draft.walkable[index] = params.nonWalkable.has(id) ? 0 : 1;
    }
  }
}
