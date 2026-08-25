/**
 * "simple" 内置地图生成器：极简随机地图，用于框架演示与地图流程验证。
 *
 * 生成规则：
 * - 边界一圈全部阻挡（不可走）；
 * - 内部随机撒约 5% 的障碍物（xorshift32 伪随机，同种子结果可复现）；
 * - 出生点：玩家在地图中心，NPC 出生点按 npcSpawns 配置布置（缺省无）；
 * - 区域：1 个覆盖地图内侧的默认区域。
 */
import type { MapRuntime, NpcSpawnSpec } from "map/types";

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

/** "simple" 生成器的参数（与 GeneratedMapSource 字段一一对应）。 */
export interface SimpleGeneratorOptions {
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
  /** 程序生成时布置的 NPC 出生点列表（可选，相对玩家出生点偏移）。 */
  npcSpawns?: NpcSpawnSpec[];
}

/**
 * 按 simple 规则生成 MapRuntime。
 *
 * @param options 生成参数
 * @returns 运行时地图（grid / blocked / spawns / zones）
 */
export function generateSimpleMap(options: SimpleGeneratorOptions): MapRuntime {
  // 伪随机源：同种子生成结果一致
  const rng = xorshift32(options.seed);
  // 阻挡网格（按行展平；0=可走，1=阻挡）
  const blocked = new Uint8Array(options.width * options.height);

  // 1) 边界一圈全部标记为阻挡
  for (let y = 0; y < options.height; y++) {
    for (let x = 0; x < options.width; x++) {
      const isBorder = x === 0 || y === 0 || x === options.width - 1 || y === options.height - 1;
      blocked[y * options.width + x] = isBorder ? 1 : 0;
    }
  }

  // 2) 在内部随机撒约 5% 的障碍物（避开边界）
  const obstacleCount = Math.floor((options.width * options.height) * 0.05);
  for (let i = 0; i < obstacleCount; i++) {
    const x = 1 + (rng() % (options.width - 2));
    const y = 1 + (rng() % (options.height - 2));
    blocked[y * options.width + x] = 1;
  }

  // 像素尺寸 = tile 数 × 单 tile 尺寸
  const mapPixelW = options.width * options.tileWidth;
  const mapPixelH = options.height * options.tileHeight;

  // 3) 出生点：玩家在地图中心；NPC 出生点按 npcSpawns 配置（相对中心偏移）布置
  const player = { x: mapPixelW * 0.5, y: mapPixelH * 0.5 };
  const npcs = (options.npcSpawns ?? []).map((s) => ({
    kind: s.kind,
    pos: {
      x: player.x + s.offsetTiles[0] * options.tileWidth,
      y: player.y + s.offsetTiles[1] * options.tileHeight,
    },
    zoneId: s.zoneId,
  }));

  // 4) 单个默认区域：覆盖地图内侧（四周各留出边界 tile 的宽度）
  const zones = [{
    id: 1,
    name: "default",
    polygon: [
      { x: options.tileWidth, y: options.tileHeight },
      { x: mapPixelW - options.tileWidth, y: options.tileHeight },
      { x: mapPixelW - options.tileWidth, y: mapPixelH - options.tileHeight },
      { x: options.tileWidth, y: mapPixelH - options.tileHeight },
    ],
  }];

  return {
    id: options.id,
    name: options.name,
    grid: {
      width: options.width,
      height: options.height,
      tileWidth: options.tileWidth,
      tileHeight: options.tileHeight,
    },
    blocked,
    spawns: { player, npcs },
    zones,
  };
}
