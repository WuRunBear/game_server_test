/**
 * 生成积木 "noise-channel"（framework/map/generate/blocks/noiseChannel.ts）。
 *
 * aux 辅助通道生产者（通用噪声通道积木）：在草稿的 aux 槽位池定义并填充
 * **配置指定槽位名**的噪声场（Float64Array，行主序，长度 = width × height，
 * 值 ∈ [0, 1)）。场值由单层值噪声生成：以本步骤独立随机流（ctx.rng）抽取
 * 晶格随机值，双线性 + smoothstep 插值采样，同 seed 同 params 确定复现。
 *
 * 与 height-channel 的关系：height-channel 是本积木的特例（固定槽位名
 * "height-channel.field"），保持不动；本积木可多次实例化，每次经参数声明
 * 不同槽位名，为多通道下游积木（如 whittaker-regions 的温度/湿度双场）生产
 * 互不干扰的输入场。槽位名由配置声明（运行期经 defineAuxSlot 构造 branded
 * 槽位），仍走 aux 池的 branded 读写约定，不做裸字符串读写。
 *
 * 关键约定（与 GeometryDraft.aux 机制一致）：
 * - 噪声场只存在于管道执行期（aux 暂存池），不进快照、不参与内容指纹与
 *   出口校验，冻结为 MapGeometry 时天然丢弃；
 * - 下游消费积木以同名声明的槽位读取（branded 槽位，类型错配编译期报错）；
 * - 本积木不写 tiles/walkable/regions——纯 aux 侧生产者；
 * - **槽位占用即抛错**：目标槽位在 aux 池中已有值时 fail-fast（两次实例
 *   声明同名槽位几乎必是配置笔误，静默覆盖会污染上游产物）。
 *
 * 参数：
 * - slot: 目标 aux 槽位名（非空字符串，必填；命名约定 "<积木名>.<产物>"）；
 * - cell?: 晶格间距 tile 数（正数，缺省 8）；
 * - seedOffset?: 随机流预抽偏移（非负整数，缺省 0）——填充晶格前先从本
 *   步骤流预抽 N 个值，使同 cell 的两个实例可显式去相关。
 */

import type { GenerationContext } from "map/generate/types";
import { defineAuxSlot, getAux, setAux } from "map/generate/types";

/** 本积木写入的场的值类型（branded 槽位约束）。 */
type NoiseField = Float64Array;

/** 晶格间距缺省值（tile 数），与 height-channel 一致。 */
const DEFAULT_CELL = 8;

/** 参数错误统一出口：消息含地图 key 与具体原因。 */
function fail(mapKey: string, detail: string): never {
  throw new Error(`map "${mapKey}": noise-channel ${detail}`);
}

/** 平滑插值曲线（smoothstep）。 */
function smooth(t: number): number {
  return t * t * (3 - 2 * t);
}

/**
 * 从 ctx.params 收窄积木参数：slot 必填非空字符串；cell 可选正数（缺省 8）；
 * seedOffset 可选非负整数（缺省 0）。非法即抛出点名具体配置项的错误。
 *
 * @param params 管道透传的本步骤参数切片
 * @param mapKey 地图 key（错误消息定位用）
 * @returns 可信参数形状
 */
function parseParams(
  params: unknown,
  mapKey: string,
): { slot: string; cell: number; seedOffset: number } {
  if (typeof params !== "object" || params === null || Array.isArray(params)) {
    fail(mapKey, "params must be an object with slot (and optional cell / seedOffset)");
  }
  const raw = params as Record<string, unknown>;

  const slot = raw.slot;
  if (typeof slot !== "string" || slot.length === 0) {
    fail(mapKey, `params.slot must be a non-empty string, got ${String(slot)}`);
  }

  let cell = DEFAULT_CELL;
  if (raw.cell !== undefined) {
    if (typeof raw.cell !== "number" || !Number.isFinite(raw.cell) || raw.cell <= 0) {
      fail(mapKey, `params.cell must be a positive number, got ${String(raw.cell)}`);
    }
    cell = raw.cell;
  }

  let seedOffset = 0;
  if (raw.seedOffset !== undefined) {
    if (typeof raw.seedOffset !== "number" || !Number.isInteger(raw.seedOffset) || raw.seedOffset < 0) {
      fail(mapKey, `params.seedOffset must be a non-negative integer, got ${String(raw.seedOffset)}`);
    }
    seedOffset = raw.seedOffset;
  }

  return { slot, cell, seedOffset };
}

/**
 * noise-channel 生成积木：向配置声明的 aux 槽位写入噪声场（只写 aux，不动地理缓冲）。
 *
 * @param ctx 生成上下文（params 由本积木收窄校验）
 * @throws Error 当 params 非法、草稿未定尺寸，或目标槽位已被上游积木占用时
 *   （消息含地图 key）
 */
export function noiseChannel(ctx: GenerationContext): void {
  const { slot, cell, seedOffset } = parseParams(ctx.params, ctx.key);

  const { width, height } = ctx.geometry;
  const total = width * height;
  if (width <= 0 || height <= 0) {
    throw new Error(
      `map "${ctx.key}": noise-channel requires a sized draft (width=${width}, height=${height}) — a sizing block must run first`,
    );
  }

  // branded 槽位由配置声明（运行期构造）：下游积木以同名槽位读取。
  const target = defineAuxSlot<NoiseField>(slot);

  // 槽位占用即抛错：两次实例声明同名槽位会静默覆盖上游产物，fail-fast
  if (getAux(ctx.geometry, target) !== undefined) {
    fail(ctx.key, `aux slot "${slot}" is already occupied — two producers must not share one slot`);
  }

  // seedOffset：填充晶格前先从本步骤流预抽 N 个值（同 cell 不同 offset → 不同场）
  for (let i = 0; i < seedOffset; i++) {
    ctx.rng.next();
  }

  // 单层值噪声晶格：间距 cell，晶格随机值按行主序从 rng 固定顺序抽取
  const cols = Math.ceil(width / cell) + 1;
  const rows = Math.ceil(height / cell) + 1;
  const lattice = new Float64Array(cols * rows);
  for (let i = 0; i < lattice.length; i++) {
    lattice[i] = ctx.rng.next();
  }

  // 双线性 + smoothstep 采样填充噪声场
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

  setAux(ctx.geometry, target, field);
}
