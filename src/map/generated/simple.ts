import type { MapRuntime } from "map/types";

/**
 * 基于 xorshift32 的伪随机数生成器。
 * 传入相同 seed 时会生成确定性的随机序列，便于复现同一张地图。
 * @param state 随机种子
 * @returns 返回一个每次调用都会产生下一个随机数的函数
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

/**
 * 简易地图生成器参数。
 */
export interface SimpleGeneratorOptions {
  /** 地图 ID */
  id: string;
  /** 地图名称 */
  name: string;
  /** 随机种子 */
  seed: number;
  /** 网格宽度（格子数） */
  width: number;
  /** 网格高度（格子数） */
  height: number;
  /** 单格宽度（像素） */
  tileWidth: number;
  /** 单格高度（像素） */
  tileHeight: number;
}

/**
 * 生成一张简易网格地图：
 * - 四周边界固定为阻挡
 * - 内部随机放置少量障碍
 * - 提供默认玩家与 NPC 出生点
 * @param options 生成参数
 * @returns 可运行时使用的地图数据
 */
export function generateSimpleMap(options: SimpleGeneratorOptions): MapRuntime {
  const rng = xorshift32(options.seed);
  const blocked = new Uint8Array(options.width * options.height);

  /**
   * 初始化边界阻挡：四周一圈全部置为 1，其余保持 0。
   */
  for (let y = 0; y < options.height; y++) {
    for (let x = 0; x < options.width; x++) {
      const isBorder = x === 0 || y === 0 || x === options.width - 1 || y === options.height - 1;
      blocked[y * options.width + x] = isBorder ? 1 : 0;
    }
  }

  /**
   * 随机放置内部障碍（约 5%）。
   * 仅在非边界区域投放，避免覆盖边界规则。
   */
  const obstacleCount = Math.floor((options.width * options.height) * 0.05);
  for (let i = 0; i < obstacleCount; i++) {
    const x = 1 + (rng() % (options.width - 2));
    const y = 1 + (rng() % (options.height - 2));
    blocked[y * options.width + x] = 1;
  }

  /**
   * 默认出生点：用像素坐标表示。
   */
  const player = { x: options.tileWidth * (options.width * 0.5), y: options.tileHeight * (options.height * 0.5) };
  const npcs = [
    { kind: "villager", pos: { x: options.tileWidth * (options.width * 0.5 + 2), y: options.tileHeight * (options.height * 0.5) } },
  ];

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
    zones: [],
  };
}
