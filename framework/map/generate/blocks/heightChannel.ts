/**
 * 生成积木 "height-channel"（framework/map/generate/blocks/heightChannel.ts）。
 *
 * aux 辅助通道生产者（多场叠加验证积木）：在草稿的 aux 槽位池定义并填充
 * 一个 height 场（Float64Array，行主序，长度 = width × height，值 ∈ [0, 1)）。
 * 场值由单层值噪声生成：以本步骤独立随机流（ctx.rng）抽取晶格随机值，
 * 双线性 + smoothstep 插值采样，同 seed 同 params 确定复现。
 *
 * 关键约定（与 GeometryDraft.aux 机制一致）：
 * - height 场只存在于管道执行期（aux 暂存池），不进快照、不参与内容
 *   指纹与出口校验，冻结为 MapGeometry 时天然丢弃；
 * - 下游消费积木引用本模块导出的 HEIGHT_FIELD 槽位常量读取（branded
 *   槽位，类型错配编译期报错）；
 * - 本积木不写 tiles/walkable/regions——纯 aux 侧生产者。
 *
 * 参数（可选）：cell?: 晶格间距 tile 数（正数，缺省 8）。
 */

import type { GenerationContext } from "map/generate/types";
import { defineAuxSlot, setAux } from "map/generate/types";

/** height 场 aux 槽位常量：下游消费积木经此读取（值 = Float64Array）。 */
export const HEIGHT_FIELD = defineAuxSlot<Float64Array>("height-channel.field");

/** 晶格间距缺省值（tile 数）。 */
const DEFAULT_CELL = 8;

/** 参数错误统一出口：消息含地图 key 与具体原因。 */
function fail(mapKey: string, detail: string): never {
  throw new Error(`map "${mapKey}": height-channel ${detail}`);
}

/** 平滑插值曲线（smoothstep）。 */
function smooth(t: number): number {
  return t * t * (3 - 2 * t);
}

/**
 * height-channel 生成积木：向 aux 槽位写入 height 场（只写 aux，不动地理缓冲）。
 *
 * @param ctx 生成上下文（params 由本积木收窄校验）
 * @throws Error 当 params 非法，或草稿未定尺寸/缓冲未分配时（消息含地图 key）
 */
export function heightChannel(ctx: GenerationContext): void {
  // 参数收窄：cell 可选正数，缺省 8
  let cell = DEFAULT_CELL;
  if (ctx.params !== undefined && ctx.params !== null) {
    if (typeof ctx.params !== "object" || Array.isArray(ctx.params)) {
      fail(ctx.key, "params must be an object with optional cell");
    }
    const raw = (ctx.params as Record<string, unknown>).cell;
    if (raw !== undefined) {
      if (typeof raw !== "number" || !Number.isFinite(raw) || raw <= 0) {
        fail(ctx.key, `params.cell must be a positive number, got ${String(raw)}`);
      }
      cell = raw;
    }
  }

  const { width, height } = ctx.geometry;
  const total = width * height;
  if (width <= 0 || height <= 0) {
    throw new Error(
      `map "${ctx.key}": height-channel requires a sized draft (width=${width}, height=${height}) — a sizing block must run first`,
    );
  }

  // 单层值噪声晶格：间距 cell，晶格随机值按行主序从 rng 固定顺序抽取
  const cols = Math.ceil(width / cell) + 1;
  const rows = Math.ceil(height / cell) + 1;
  const lattice = new Float64Array(cols * rows);
  for (let i = 0; i < lattice.length; i++) {
    lattice[i] = ctx.rng.next();
  }

  // 双线性 + smoothstep 采样填充 height 场
  const field = new Float64Array(total);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const u = x / cell;
      const v = y / cell;
      const ix = Math.floor(u);
      const iy = Math.floor(v);
      const tx = smooth(u - ix);
      const ty = smooth(v - iy);
      const base = iy * cols + ix;
      const v00 = lattice[base];
      const v10 = lattice[base + 1];
      const v01 = lattice[base + cols];
      const v11 = lattice[base + cols + 1];
      const low = v00 + (v10 - v00) * tx;
      const high = v01 + (v11 - v01) * tx;
      field[y * width + x] = low + (high - low) * ty;
    }
  }

  setAux(ctx.geometry, HEIGHT_FIELD, field);
}
