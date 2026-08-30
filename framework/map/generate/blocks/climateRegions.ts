/**
 * climate-regions 生成积木（framework/map/generate/blocks/climateRegions.ts）。
 *
 * 把已定尺寸的草稿划入命名区域（区域位图）：
 * - params.names 声明区域名，数组顺序 = regionOfTile 索引序 = regions Map
 *   插入序（本积木保证三者严格一致）；
 * - params.style 首版仅支持 "noise"：以本步骤的独立随机流（ctx.rng）驱动
 *   种子撒点 + 预算化 BFS 邻接扩张——每格认领时必有同区域已认领邻格，
 *   区域恒 4-连通成片生长，不产生盐粒状碎斑；
 * - 未被任何命名区域认领的格子指向隐式 "wilderness" 区域，本积木保证其
 *   存在：仅在确有未认领格时追加到 regions 末尾（names 不得占用该保留名）；
 * - params.minArea（可选）：生长结束后面积不足的命名区域整体并入相邻区域
 *   （简单重平衡），保证输出中每个命名区域面积 ≥ minArea。
 *
 * 纯几何生产：不 import ECS/world，不产出实体；只要求草稿已定尺寸
 * （前置积木设定 width/height 并分配缓冲），不依赖 tiles 语义细节。
 * 全程只用 ctx.rng，同 seed 同配置产出确定。
 */

import type { GenerationContext } from "map/generate/types";

/** 隐式野区名：未被命名区域认领的格子归属此区域（保留名，tiled-source 同名复用）。 */
export const WILDERNESS = "wilderness";

/** 区域生长预算占全图格数的最小/最大份额（每次运行经 rng 在区间内取值）。 */
const MIN_AREA_SHARE = 0.12;
const MAX_AREA_SHARE = 0.4;

/** 收窄校验后的积木参数。 */
interface ClimateRegionsParams {
  /** 区域名（数组顺序即 regionOfTile 索引序）。 */
  names: string[];
  /** 最小面积约束（格数）；undefined 表示不做重平衡。 */
  minArea: number | undefined;
}

/**
 * 从 ctx.params 收窄并校验本积木参数（边界处一次性解析）。
 *
 * @param params 步骤自有参数切片（未校验的外部输入）
 * @param key 地图 key（错误消息点名）
 * @returns 收窄后的参数
 * @throws Error 当 params 形状不满足约定时（消息含地图 key 与具体字段）
 */
function parseParams(params: unknown, key: string): ClimateRegionsParams {
  if (typeof params !== "object" || params === null) {
    throw new Error(`map "${key}" climate-regions: params must be an object`);
  }
  // 边界收窄：已确认为非空 object，逐字段运行时校验（unknown → 具体类型）
  const raw = params as Record<string, unknown>;

  const rawNames = raw.names;
  if (!Array.isArray(rawNames) || rawNames.length === 0) {
    throw new Error(
      `map "${key}" climate-regions: params.names must be a non-empty array of region names`,
    );
  }
  const names: string[] = [];
  for (const entry of rawNames) {
    if (typeof entry !== "string" || entry.length === 0) {
      throw new Error(
        `map "${key}" climate-regions: params.names entries must be non-empty strings`,
      );
    }
    if (entry === WILDERNESS) {
      throw new Error(
        `map "${key}" climate-regions: params.names must not contain reserved region name "${WILDERNESS}"`,
      );
    }
    if (names.includes(entry)) {
      throw new Error(
        `map "${key}" climate-regions: params.names contains duplicate region name "${entry}"`,
      );
    }
    names.push(entry);
  }

  if (raw.style !== "noise") {
    throw new Error(
      `map "${key}" climate-regions: params.style must be "noise" (got ${String(raw.style)}) — only the noise style is supported`,
    );
  }

  let minArea: number | undefined;
  if (raw.minArea !== undefined) {
    const value = raw.minArea;
    if (typeof value !== "number" || !Number.isFinite(value) || value < 1) {
      throw new Error(
        `map "${key}" climate-regions: params.minArea must be a finite number >= 1 (got ${String(value)})`,
      );
    }
    minArea = value;
  }

  return { names, minArea };
}

/**
 * climate-regions 积木：向草稿写入命名区域位图。
 *
 * @param ctx 生成步骤上下文（params 见模块注释；geometry 须已定尺寸）
 * @throws Error 当 params 非法，或草稿未定尺寸/缓冲未分配时（消息含地图 key）
 */
export function climateRegions(ctx: GenerationContext): void {
  const { names, minArea } = parseParams(ctx.params, ctx.key);

  const { width, height, regions, regionOfTile } = ctx.geometry;
  const total = width * height;
  if (width <= 0 || height <= 0) {
    throw new Error(
      `map "${ctx.key}" climate-regions: draft is not sized (width=${width}, height=${height}) — a prior pipeline step must set the grid size and buffers`,
    );
  }
  if (regionOfTile.length !== total) {
    throw new Error(
      `map "${ctx.key}" climate-regions: regionOfTile length ${regionOfTile.length} != width*height ${total} — the prior sizing step must allocate the buffers`,
    );
  }

  // 工作面：assign[t] = 命名区域索引（0..N-1）或 -1（未认领 → wilderness）
  const assign = new Int16Array(total).fill(-1);
  const regionCount = new Int32Array(names.length);
  const budget = new Int32Array(names.length);
  for (let i = 0; i < names.length; i++) {
    const share = MIN_AREA_SHARE + ctx.rng.next() * (MAX_AREA_SHARE - MIN_AREA_SHARE);
    budget[i] = Math.max(1, Math.round(total * share));
  }

  // 待认领前沿队列（共享）：条目 = (tile, region)，随机弹出认领
  const queueTile: number[] = [];
  const queueRegion: number[] = [];

  // 把 tile 的 4-邻域中尚未认领的格子入队（认领后由所属区域继续扩张）
  const pushNeighbors = (tile: number, region: number): void => {
    const x = tile % width;
    const y = (tile - x) / width;
    if (x > 0 && assign[tile - 1] === -1) {
      queueTile.push(tile - 1);
      queueRegion.push(region);
    }
    if (x < width - 1 && assign[tile + 1] === -1) {
      queueTile.push(tile + 1);
      queueRegion.push(region);
    }
    if (y > 0 && assign[tile - width] === -1) {
      queueTile.push(tile - width);
      queueRegion.push(region);
    }
    if (y < height - 1 && assign[tile + width] === -1) {
      queueTile.push(tile + width);
      queueRegion.push(region);
    }
  };

  // 种子撒点：每区域一枚种子（落点被占时向后环绕扫描下一个空格）
  for (let i = 0; i < names.length; i++) {
    const start = ctx.rng.int(total);
    let seed = -1;
    for (let k = 0; k < total; k++) {
      const candidate = (start + k) % total;
      if (assign[candidate] === -1) {
        seed = candidate;
        break;
      }
    }
    if (seed === -1) continue; // 全图已被种子占满（区域数 > 格数的退化配置）
    assign[seed] = i;
    regionCount[i] = 1;
    pushNeighbors(seed, i);
  }

  // 共享前沿扩张：随机弹出一格，预算内认领并继续外扩——认领格必有
  // 同区域已认领邻格（种子除外），每区域恒为一片 4-连通地块
  while (queueTile.length > 0) {
    const pick = ctx.rng.int(queueTile.length);
    const tile = queueTile[pick];
    const region = queueRegion[pick];
    const last = queueTile.length - 1;
    queueTile[pick] = queueTile[last];
    queueRegion[pick] = queueRegion[last];
    queueTile.pop();
    queueRegion.pop();

    if (assign[tile] !== -1) continue;
    if (regionCount[region] >= budget[region]) continue;
    assign[tile] = region;
    regionCount[region]++;
    pushNeighbors(tile, region);
  }

  // 最小面积重平衡：面积不足的命名区域整体并入相邻区域——优先命名区域
  // （共享边界最多者，平局取索引小者），无命名邻接时并入 wilderness
  const dropped = new Uint8Array(names.length);
  if (minArea !== undefined) {
    // 遍历 tile 的 4-邻域（越界跳过）
    const forEachNeighbor = (tile: number, visit: (neighbor: number) => void): void => {
      const x = tile % width;
      const y = (tile - x) / width;
      if (x > 0) visit(tile - 1);
      if (x < width - 1) visit(tile + 1);
      if (y > 0) visit(tile - width);
      if (y < height - 1) visit(tile + width);
    };

    for (let i = 0; i < names.length; i++) {
      const tiles: number[] = [];
      for (let t = 0; t < total; t++) {
        if (assign[t] === i) tiles.push(t);
      }
      if (tiles.length === 0) {
        dropped[i] = 1; // 未撒到种子的区域：直接移除
        continue;
      }
      if (tiles.length >= minArea) continue;

      const contact = new Int32Array(names.length);
      let wildContact = 0;
      for (const t of tiles) {
        forEachNeighbor(t, (n) => {
          const owner = assign[n];
          if (owner === i) return;
          if (owner === -1) wildContact++;
          else contact[owner]++;
        });
      }

      // -2 = 无可并入目标（退化：全图仅此区域且无空格），保持原状
      let target = -2;
      let best = 0;
      for (let v = 0; v < names.length; v++) {
        if (contact[v] > best) {
          best = contact[v];
          target = v;
        }
      }
      if (target === -2 && wildContact > 0) target = -1;

      if (target === -2) continue;
      for (const t of tiles) assign[t] = target;
      dropped[i] = 1;
    }
  }

  // 重建输出：regions 插入序 = 幸存命名区域的声明序（+ wilderness 兜底），
  // regionOfTile 按新索引重写——每格必有一个合法区域索引
  regions.clear();
  const indexMap = new Int16Array(names.length).fill(-1);
  let next = 0;
  for (let i = 0; i < names.length; i++) {
    if (dropped[i] === 1) continue;
    regions.set(names[i], { name: names[i], meta: {} });
    indexMap[i] = next++;
  }
  let hasWild = false;
  for (let t = 0; t < total; t++) {
    if (assign[t] === -1) {
      hasWild = true;
      break;
    }
  }
  const wildIndex = hasWild ? next : -1;
  if (hasWild) regions.set(WILDERNESS, { name: WILDERNESS, meta: {} });
  for (let t = 0; t < total; t++) {
    const owner = assign[t];
    regionOfTile[t] = owner === -1 ? wildIndex : indexMap[owner];
  }
}
