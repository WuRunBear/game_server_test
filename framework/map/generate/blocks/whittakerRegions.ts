/**
 * 生成积木 "whittaker-regions"（framework/map/generate/blocks/whittakerRegions.ts）。
 *
 * 温度 × 湿度双通道查表分区积木：消费上游两个噪声场（如 noise-channel
 * 生产的温度场与湿度场，经配置声明的 aux 槽位名读取），按阈值查表把每格
 * 划入一个命名区域——
 * - params.rowThresholds（温度带阈值，升序）把温度场切成 bands 行
 *   （带序 = #{ t : 温度 ≥ t }，边界值归上带，与 quantize-terrain 同约定）；
 * - params.colThresholds（湿度带阈值，升序）把湿度场切成 bands 列；
 * - params.table 是 (行数+1) × (列数+1) 的二维区域名表：table[row][col]，
 *   row 0 = 最冷带、col 0 = 最干带；region 名 = 表中字符串，框架不解释
 *   含义（含义映射在 game 配置）；
 * - regionOfTile 按查表结果写入；regions Map 插入序 = 行主序扫描的
 *   首次出现序（零覆盖的表项不进 regions，避免零覆盖软告警）；
 * - params.minArea（可选）：分区结束后面积不足的命名区域整体并入相邻
 *   区域（共享边界最多者，平局取插入序在前者；无相邻区域时保持原状），
 *   参照 climate-regions 的既有做法。
 *
 * 上游衔接：两个场经 branded 槽位（以配置槽位名运行期构造）读取，缺失或
 * 长度不符即抛错（消费积木对上游依赖 fail-fast）。本积木全图划分、覆盖
 * 上游区域表（regions.clear() 后重建）——区域类积木对区域表拥有全权。
 * 本积木不写 tiles/walkable。
 *
 * 纯几何生产：不 import ECS/world，不做文件 I/O，不含游戏专属语义。
 * 无随机性（纯查表），同 seed 同配置产出深相等（区域重平融化同为确定）。
 */

import type { GenerationContext } from "map/generate/types";
import { defineAuxSlot, getAux } from "map/generate/types";

/** 隐式野区保留名：查表分区是全覆盖划分，表项不得占用该保留名（与 climate-regions 一致）。 */
const WILDERNESS = "wilderness";

/** 收窄校验后的积木参数。 */
interface WhittakerRegionsParams {
  /** 温度场 aux 槽位名（上游 noise-channel 声明的同名槽位）。 */
  temperatureSlot: string;
  /** 湿度场 aux 槽位名（须与温度槽位不同）。 */
  moistureSlot: string;
  /** 温度带阈值（升序严格递增，每个 ∈ (0, 1)；空数组 = 单带）。 */
  rowThresholds: number[];
  /** 湿度带阈值（同上）。 */
  colThresholds: number[];
  /** 查表区域名：table[row][col]（row 0 = 最冷带，col 0 = 最干带）。 */
  table: string[][];
  /** 最小面积约束（格数）；undefined 表示不做重平衡。 */
  minArea: number | undefined;
}

/** 参数错误统一出口：消息含地图 key 与具体原因。 */
function fail(mapKey: string, detail: string): never {
  throw new Error(`map "${mapKey}": whittaker-regions ${detail}`);
}

/** 校验阈值数组：可为空数组（单带）；条目须 ∈ (0, 1) 且升序严格递增。 */
function parseThresholds(raw: unknown, name: string, mapKey: string): number[] {
  if (!Array.isArray(raw)) {
    fail(mapKey, `params.${name} must be an array of band thresholds`);
  }
  const thresholds: number[] = [];
  for (const entry of raw) {
    if (typeof entry !== "number" || !Number.isFinite(entry) || entry <= 0 || entry >= 1) {
      fail(mapKey, `params.${name} entries must be numbers in (0, 1), got ${String(entry)}`);
    }
    thresholds.push(entry);
  }
  for (let i = 1; i < thresholds.length; i++) {
    if (thresholds[i] <= thresholds[i - 1]) {
      fail(mapKey, `params.${name} must be strictly ascending (${name}[${i}]=${thresholds[i]})`);
    }
  }
  return thresholds;
}

/**
 * 从 ctx.params 收窄积木参数：逐项校验，缺失/非法即抛出点名具体配置项的错误。
 *
 * @param params 管道透传的本步骤参数切片
 * @param mapKey 地图 key（错误消息定位用）
 * @returns 可信参数形状
 */
function parseParams(params: unknown, mapKey: string): WhittakerRegionsParams {
  if (typeof params !== "object" || params === null || Array.isArray(params)) {
    fail(mapKey, "params must be an object");
  }
  const raw = params as Record<string, unknown>;

  const slotNames: string[] = [];
  for (const key of ["temperatureSlot", "moistureSlot"] as const) {
    const value = raw[key];
    if (typeof value !== "string" || value.length === 0) {
      fail(mapKey, `params.${key} must be a non-empty string, got ${String(value)}`);
    }
    slotNames.push(value);
  }
  if (slotNames[0] === slotNames[1]) {
    fail(mapKey, `params.temperatureSlot and params.moistureSlot must be distinct (both are "${slotNames[0]}")`);
  }

  const rowThresholds = parseThresholds(raw.rowThresholds, "rowThresholds", mapKey);
  const colThresholds = parseThresholds(raw.colThresholds, "colThresholds", mapKey);

  // 查表：二维字符串数组，行数 = rowThresholds.length + 1，列数 =
  // colThresholds.length + 1（行等长），条目为非空、非保留、互不重复的区域名
  const tableRaw = raw.table;
  if (!Array.isArray(tableRaw)) {
    fail(mapKey, "params.table must be a 2D array of region names");
  }
  const expectedRows = rowThresholds.length + 1;
  const expectedCols = colThresholds.length + 1;
  if (tableRaw.length !== expectedRows) {
    fail(
      mapKey,
      `params.table must have ${expectedRows} rows (rowThresholds.length + 1), got ${tableRaw.length}`,
    );
  }
  const table: string[][] = [];
  const seenNames = new Set<string>();
  for (let r = 0; r < tableRaw.length; r++) {
    const row = tableRaw[r];
    if (!Array.isArray(row) || row.length !== expectedCols) {
      fail(
        mapKey,
        `params.table[${r}] must have ${expectedCols} columns (colThresholds.length + 1), got ${Array.isArray(row) ? row.length : String(row)}`,
      );
    }
    const cells: string[] = [];
    for (let c = 0; c < row.length; c++) {
      const name = row[c];
      if (typeof name !== "string" || name.length === 0) {
        fail(mapKey, `params.table[${r}][${c}] must be a non-empty string, got ${String(name)}`);
      }
      if (name === WILDERNESS) {
        fail(mapKey, `params.table[${r}][${c}] must not use reserved region name "${WILDERNESS}"`);
      }
      if (seenNames.has(name)) {
        fail(mapKey, `params.table contains duplicate region name "${name}"`);
      }
      seenNames.add(name);
      cells.push(name);
    }
    table.push(cells);
  }

  let minArea: number | undefined;
  if (raw.minArea !== undefined) {
    const value = raw.minArea;
    if (typeof value !== "number" || !Number.isFinite(value) || value < 1) {
      fail(mapKey, `params.minArea must be a finite number >= 1 (got ${String(value)})`);
    }
    minArea = value;
  }

  return {
    temperatureSlot: slotNames[0],
    moistureSlot: slotNames[1],
    rowThresholds,
    colThresholds,
    table,
    minArea,
  };
}

/**
 * whittaker-regions 生成积木：温度×湿度双场查表，把全图划入命名区域。
 *
 * @param ctx 生成上下文（params 由本积木收窄校验）
 * @throws Error 当 params 非法、草稿未定尺寸/regionOfTile 未分配，或上游
 *   噪声场缺失（aux 槽位无场或长度不符）时——消息含地图 key
 */
export function whittakerRegions(ctx: GenerationContext): void {
  const params = parseParams(ctx.params, ctx.key);

  const { width, height, regions, regionOfTile } = ctx.geometry;
  const total = width * height;
  if (width <= 0 || height <= 0) {
    fail(
      ctx.key,
      `draft is not sized (width=${width}, height=${height}) — a prior pipeline step must set the grid size and buffers`,
    );
  }
  if (regionOfTile.length !== total) {
    fail(
      ctx.key,
      `regionOfTile length ${regionOfTile.length} != width*height ${total} — the prior sizing step must allocate the buffers`,
    );
  }

  // 上游依赖：两个噪声场必须已由 noise-channel（或同槽位名的生产者）写入 aux
  const temperatureField = getAux(ctx.geometry, defineAuxSlot<Float64Array>(params.temperatureSlot));
  if (!temperatureField || temperatureField.length !== total) {
    fail(
      ctx.key,
      `requires an upstream noise-channel step filling aux slot "${params.temperatureSlot}" (field.length=${temperatureField?.length ?? "undefined"}, expected ${total})`,
    );
  }
  const moistureField = getAux(ctx.geometry, defineAuxSlot<Float64Array>(params.moistureSlot));
  if (!moistureField || moistureField.length !== total) {
    fail(
      ctx.key,
      `requires an upstream noise-channel step filling aux slot "${params.moistureSlot}" (field.length=${moistureField?.length ?? "undefined"}, expected ${total})`,
    );
  }

  // 工作面：assign[t] = 首次出现序的区域索引（查表即得，天然全覆盖）
  const assign = new Int16Array(total);
  // 区域名 → 首次出现序索引；regions Map 插入序与之一致
  const nameIndex = new Map<string, number>();
  const namesInOrder: string[] = [];
  for (let t = 0; t < total; t++) {
    // 带序 = #{ threshold : 场值 ≥ threshold }（边界值归上带）
    let row = 0;
    for (const threshold of params.rowThresholds) {
      if (temperatureField[t] >= threshold) row++;
      else break;
    }
    let col = 0;
    for (const threshold of params.colThresholds) {
      if (moistureField[t] >= threshold) col++;
      else break;
    }
    const name = params.table[row][col];
    let index = nameIndex.get(name);
    if (index === undefined) {
      index = namesInOrder.length;
      nameIndex.set(name, index);
      namesInOrder.push(name);
    }
    assign[t] = index;
  }

  // 最小面积重平衡：面积不足的区域整体并入相邻区域——共享边界最多者
  // （平局取插入序在前者）；合并即时改写 assign，后续 contact 计数天然
  // 指向幸存区域；无相邻区域（全图仅此区域）时保持原状
  const dropped = new Uint8Array(namesInOrder.length);
  if (params.minArea !== undefined) {
    for (let i = 0; i < namesInOrder.length; i++) {
      if (dropped[i] === 1) continue;
      let area = 0;
      for (let t = 0; t < total; t++) {
        if (assign[t] === i) area++;
      }
      if (area === 0 || area >= params.minArea) continue;

      // 统计与区域 i 相邻的各区域接触格数（4-邻接，越界跳过）
      const contact = new Int32Array(namesInOrder.length);
      for (let t = 0; t < total; t++) {
        if (assign[t] !== i) continue;
        const x = t % width;
        const y = (t - x) / width;
        if (x > 0 && assign[t - 1] !== i) contact[assign[t - 1]]++;
        if (x < width - 1 && assign[t + 1] !== i) contact[assign[t + 1]]++;
        if (y > 0 && assign[t - width] !== i) contact[assign[t - width]]++;
        if (y < height - 1 && assign[t + width] !== i) contact[assign[t + width]]++;
      }

      // -2 = 无可并入目标（全图仅此区域），保持原状；平局取插入序在前者
      let target = -2;
      let best = 0;
      for (let v = 0; v < namesInOrder.length; v++) {
        if (contact[v] > best) {
          best = contact[v];
          target = v;
        }
      }
      if (target === -2) continue;
      for (let t = 0; t < total; t++) {
        if (assign[t] === i) assign[t] = target;
      }
      dropped[i] = 1;
    }
  }

  // 重建输出：regions 插入序 = 幸存区域的首次出现序，regionOfTile 按新索引重写
  regions.clear();
  const indexMap = new Int16Array(namesInOrder.length).fill(-1);
  let next = 0;
  for (let i = 0; i < namesInOrder.length; i++) {
    if (dropped[i] === 1) continue;
    regions.set(namesInOrder[i], { name: namesInOrder[i], meta: {} });
    indexMap[i] = next++;
  }
  for (let t = 0; t < total; t++) {
    regionOfTile[t] = indexMap[assign[t]];
  }
}
