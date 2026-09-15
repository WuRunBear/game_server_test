/**
 * 生成积木 "smooth-terrain"（framework/map/generate/blocks/smoothTerrain.ts）。
 *
 * 后处理变换积木（生成后精修）：对已写入的 tiles 做局部多数平滑——每轮
 * 对每格统计「自身 + 4-邻域」共 5 格的语义众数，若最高频语义（并列时取
 * 语义 id 最小者，保证确定性）的出现次数严格大于自身语义的出现次数，
 * 则把该格改为最高频语义。孤立格/细刺被邻域吞并，实心块内部不变，
 * 边界逐步平直。double-buffer 同步更新（整轮基于同一快照）。
 *
 * 定点收敛（积木内部迭代，不改管道类型）：以 maxRounds 为轮数上限，
 * 某一轮无任何格变更即提前退出；输出恒为平滑算子的不动点或恰好
 * maxRounds 轮后的状态（有界，不依赖收敛性）。
 *
 * 参数（全部可选）：
 * - maxRounds?: 收敛轮数上限（整数 ≥ 0，缺省 8）；
 * - nonWalkableSemantics?: 语义 id 数组——提供时平滑结束后按最终 tiles
 *   重派生 walkable（∈ 集合 → 0，否则 1），保证语义→通行一致；不提供时
 *   walkable 保持原样（由上游积木自行保证一致性）。
 *
 * 纯几何生产：不 import ECS/world，不做文件 I/O，不含游戏专属语义。
 */

import type { GenerationContext, GeometryDraft } from "map/generate/types";

/** maxRounds 缺省值。 */
const DEFAULT_MAX_ROUNDS = 8;
/** 语义 id 上界：tiles 缓冲是 Uint8Array，语义 id 必须落在单字节内。 */
const MAX_SEMANTIC_ID = 255;

/** 收窄校验后的积木参数。 */
interface SmoothTerrainParams {
  /** 收敛轮数上限（整数 ≥ 0）。 */
  maxRounds: number;
  /** 语义 → 通行重派生集合；undefined = 不重派生 walkable。 */
  nonWalkable: Set<number> | undefined;
}

/** 参数错误统一出口：消息含地图 key 与具体原因。 */
function fail(mapKey: string, detail: string): never {
  throw new Error(`map "${mapKey}": smooth-terrain ${detail}`);
}

/**
 * 从 ctx.params 收窄积木参数：maxRounds 缺省 8（整数 ≥ 0）；
 * nonWalkableSemantics 缺省不重派生，提供时条目须为 [0, 255] 整数。
 *
 * @param params 管道透传的本步骤参数切片
 * @param mapKey 地图 key（错误消息定位用）
 * @returns 收窄后的参数
 */
function parseParams(params: unknown, mapKey: string): SmoothTerrainParams {
  if (params === undefined || params === null) {
    return { maxRounds: DEFAULT_MAX_ROUNDS, nonWalkable: undefined };
  }
  if (typeof params !== "object" || Array.isArray(params)) {
    fail(mapKey, "params must be an object with optional maxRounds / nonWalkableSemantics");
  }
  const raw = params as Record<string, unknown>;

  let maxRounds = DEFAULT_MAX_ROUNDS;
  if (raw.maxRounds !== undefined) {
    const value = raw.maxRounds;
    if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
      fail(mapKey, `params.maxRounds must be a non-negative integer, got ${String(value)}`);
    }
    maxRounds = value;
  }

  let nonWalkable: Set<number> | undefined;
  if (raw.nonWalkableSemantics !== undefined) {
    const entries = raw.nonWalkableSemantics;
    if (!Array.isArray(entries)) {
      fail(mapKey, "params.nonWalkableSemantics must be an array of semantic ids");
    }
    const set = new Set<number>();
    for (const entry of entries) {
      if (typeof entry !== "number" || !Number.isInteger(entry) || entry < 0 || entry > MAX_SEMANTIC_ID) {
        fail(mapKey, `params.nonWalkableSemantics entries must be integers in [0, 255], got ${String(entry)}`);
      }
      set.add(entry);
    }
    nonWalkable = set;
  }

  return { maxRounds, nonWalkable };
}

/**
 * 单轮多数平滑（纯函数，double-buffer 同步更新）。
 *
 * 每格统计「自身 + 4-邻域」的语义出现次数：最高频语义（并列取语义 id
 * 最小）出现次数严格大于自身语义次数时改为最高频语义，否则保持。
 * 计数用固定长度数组（索引 = 语义 id），无逐格分配。
 *
 * @param tiles 输入语义缓冲（行主序，不改写）
 * @param width 网格宽度
 * @param height 网格高度
 * @returns [新语义缓冲（副本），本轮变更格数]
 */
export function smoothRound(tiles: Uint8Array, width: number, height: number): [Uint8Array, number] {
  const next = new Uint8Array(tiles.length);
  // 语义计数表（索引 = 语义 id，上限 256）
  const counts = new Int32Array(MAX_SEMANTIC_ID + 1);
  let changed = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const index = y * width + x;
      // 收集自身 + 4-邻域语义（越界跳过）
      counts.fill(0);
      counts[tiles[index]]++;
      if (x > 0) counts[tiles[index - 1]]++;
      if (x < width - 1) counts[tiles[index + 1]]++;
      if (y > 0) counts[tiles[index - width]]++;
      if (y < height - 1) counts[tiles[index + width]]++;
      // 找最高频语义（并列取 id 最小者）：升序扫描，首个最大值即最小 id
      const self = tiles[index];
      let bestId = self;
      let bestCount = 0;
      for (let id = 0; id <= MAX_SEMANTIC_ID; id++) {
        if (counts[id] > bestCount) {
          bestCount = counts[id];
          bestId = id;
        }
      }
      if (bestId !== self && bestCount > counts[self]) {
        next[index] = bestId;
        changed++;
      } else {
        next[index] = self;
      }
    }
  }
  return [next, changed];
}

/**
 * smooth-terrain 生成积木：对已定尺寸草稿的 tiles 施加有界定点多数平滑。
 *
 * @param ctx 生成上下文（params 由本积木收窄校验）
 * @throws Error 当 params 非法，或草稿未定尺寸/缓冲未分配时（消息含地图 key）
 */
export function smoothTerrain(ctx: GenerationContext): void {
  const params = parseParams(ctx.params, ctx.key);
  const draft: GeometryDraft = ctx.geometry;
  const total = draft.width * draft.height;
  if (draft.width <= 0 || draft.height <= 0 || draft.tiles.length !== total || draft.tiles.length === 0) {
    throw new Error(
      `map "${ctx.key}": smooth-terrain requires a sized draft with allocated tiles (width=${draft.width}, height=${draft.height}, tiles.length=${draft.tiles.length}) — a sizing block must run first`,
    );
  }

  // 定点迭代：maxRounds 轮上限，某轮零变更提前退出
  for (let round = 0; round < params.maxRounds; round++) {
    const [next, changed] = smoothRound(draft.tiles, draft.width, draft.height);
    draft.tiles.set(next);
    if (changed === 0) {
      break;
    }
  }

  // 语义 → 通行重派生（可选）：按最终 tiles 保证一致
  if (params.nonWalkable !== undefined) {
    if (draft.walkable.length !== total) {
      fail(ctx.key, `walkable length ${draft.walkable.length} != width*height ${total}`);
    }
    for (let i = 0; i < draft.tiles.length; i++) {
      draft.walkable[i] = params.nonWalkable.has(draft.tiles[i]) ? 0 : 1;
    }
  }
}
