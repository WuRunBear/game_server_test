/**
 * 地图内容版本哈希与运行时分块工具（framework/map/version.ts）。
 *
 * 纯函数、零依赖、零副作用，供 /maps/runtime、/maps/meta 使用，
 * 也被单元测试直接导入（T3）：
 * - buildMapChunks：把阻挡网格切成 16×16 tile/块（块内字节 base64），供网络传输；
 * - computeMapVersion：对 MapRuntime 内容计算 32 位内容哈希（8 位小写十六进制），
 *   同内容恒定、内容变化即变，客户端可作 {id, version} 缓存键；
 * - describeMapSource：从 MapSource 提取 /maps/meta 需要的元信息（不含 version）。
 */
import type { MapGrid, MapRuntime, MapSource } from "map/types";

/** 分块尺寸：16×16 tile/块（满块 256 字节）。 */
export const MAP_CHUNK_SIZE = 16;

/**
 * /maps/runtime 响应中的单个块：
 * cx/cy 为块坐标（cx=列索引，cy=行索引，行主序排列），
 * data 为块内阻挡字节（行主序）的 base64 编码。
 */
export interface MapChunk {
  /** 块列索引（第 cx 个 16 列）。 */
  cx: number;
  /** 块行索引（第 cy 个 16 行）。 */
  cy: number;
  /** 块内字节的 base64（满块 256 字节，边缘块按余量缩小）。 */
  data: string;
}

/**
 * /maps/meta 中单张地图的元信息（version 由调用方经 computeMapVersion 补充）。
 */
export interface MapMetaInfo {
  id: string;
  name: string;
  kind: "generated" | "tiled";
  /** 宽度（tile 数）；tiled 来源的 Tiled JSON 缺失该字段时省略。 */
  width?: number;
  /** 高度（tile 数）；tiled 来源的 Tiled JSON 缺失该字段时省略。 */
  height?: number;
  /** 单 tile 宽度（像素）；tiled 来源的 Tiled JSON 缺失该字段时省略。 */
  tileWidth?: number;
  /** 单 tile 高度（像素）；tiled 来源的 Tiled JSON 缺失该字段时省略。 */
  tileHeight?: number;
  /** 生成器 id；仅 kind=generated 存在。 */
  generatorId?: string;
  /** 随机种子；仅 kind=generated 存在。 */
  seed?: number;
}

/**
 * 把阻挡网格切成 MAP_CHUNK_SIZE×MAP_CHUNK_SIZE 的块。
 *
 * 约定：
 * - 块 (cx,cy) 覆盖 tile 行 [cy*16, (cy+1)*16)、列 [cx*16, (cx+1)*16)；
 * - 块总数 = ceil(width/16) × ceil(height/16)；
 * - 块内字节按行主序从展平 blocked 数组切出；
 * - 宽/高不整除 16 时，边缘块按实际余量缩小（不满 256 字节）。
 *
 * @param blocked 展平阻挡网格（行主序，0=可走，1=阻挡）
 * @param grid 网格尺寸
 * @returns 块列表（cy 外层、cx 内层，行主序）
 */
export function buildMapChunks(blocked: Uint8Array, grid: MapGrid): MapChunk[] {
  const cols = Math.ceil(grid.width / MAP_CHUNK_SIZE);
  const rows = Math.ceil(grid.height / MAP_CHUNK_SIZE);
  const chunks: MapChunk[] = [];

  for (let cy = 0; cy < rows; cy++) {
    for (let cx = 0; cx < cols; cx++) {
      const rowStart = cy * MAP_CHUNK_SIZE;
      const rowEnd = Math.min(rowStart + MAP_CHUNK_SIZE, grid.height);
      const colStart = cx * MAP_CHUNK_SIZE;
      const colEnd = Math.min(colStart + MAP_CHUNK_SIZE, grid.width);

      const out = new Uint8Array((rowEnd - rowStart) * (colEnd - colStart));
      let p = 0;
      for (let y = rowStart; y < rowEnd; y++) {
        for (let x = colStart; x < colEnd; x++) {
          out[p] = blocked[y * grid.width + x] ?? 0;
          p++;
        }
      }

      chunks.push({ cx, cy, data: Buffer.from(out).toString("base64") });
    }
  }

  return chunks;
}

/**
 * FNV-1a 32 位哈希（返回 8 位小写十六进制字符串）。
 *
 * @param bytes 字节流
 * @returns 8 位小写十六进制（如 "a1b2c3d4"）
 */
function fnv1a32Hex(bytes: Uint8Array): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < bytes.length; i++) {
    hash ^= bytes[i] ?? 0;
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

/**
 * 计算 MapRuntime 的内容版本（内容哈希）。
 *
 * 规范序列化布局（JSDoc 即契约）：先构造固定键序的规范化对象，再对其
 * JSON.stringify 结果的 UTF-8 字节流做 FNV-1a 32 位哈希，输出 8 位小写
 * 十六进制。规范化对象形状（键序固定，字段缺失时按 undefined 参与序列化）：
 *
 * ```
 * {
 *   grid: { width, height, tileWidth, tileHeight },
 *   blocked: [0|1, ...],   // 行主序展平数组
 *   spawns: {
 *     player: { x, y } | null,
 *     npcs: [{ kind, pos: { x, y }, zoneId? }],
 *   },
 *   zones: [{ id, name, polygon: [{ x, y }, ...] }],
 * }
 * ```
 *
 * 说明：
 * - 选择 JSON.stringify 而非手工字节拼接，是因为规范对象形状直观可审计，
 *   且键序在本函数内显式固定，不受运行时对象构造顺序影响；
 * - blocked 为 Uint8Array（整数），spawns/zones 坐标为有限浮点数，
 *   JSON.stringify 对同一数值恒产出同一字符串，因此哈希稳定；
 * - 内容不变则哈希不变；网格尺寸、阻挡字节、出生点或区域任一变化都会改变哈希。
 *
 * @param runtime 地图运行时数据
 * @returns 8 位小写十六进制内容哈希
 */
export function computeMapVersion(runtime: MapRuntime): string {
  const canonical = {
    grid: {
      width: runtime.grid.width,
      height: runtime.grid.height,
      tileWidth: runtime.grid.tileWidth,
      tileHeight: runtime.grid.tileHeight,
    },
    blocked: Array.from(runtime.blocked),
    spawns: {
      player: runtime.spawns.player
        ? { x: runtime.spawns.player.x, y: runtime.spawns.player.y }
        : null,
      npcs: runtime.spawns.npcs.map((npc) => {
        const entry: { kind: string; pos: { x: number; y: number }; zoneId?: number } = {
          kind: npc.kind,
          pos: { x: npc.pos.x, y: npc.pos.y },
        };
        if (npc.zoneId !== undefined) entry.zoneId = npc.zoneId;
        return entry;
      }),
    },
    zones: runtime.zones.map((zone) => ({
      id: zone.id,
      name: zone.name,
      polygon: zone.polygon.map((v) => ({ x: v.x, y: v.y })),
    })),
  };

  return fnv1a32Hex(new TextEncoder().encode(JSON.stringify(canonical)));
}

/**
 * 判断值是否为普通对象（Record）。
 *
 * @param value 任意值
 * @returns 是否为对象且非数组
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * 把 unknown 转为 number（有限数）或返回 null。
 *
 * @param value 任意值
 * @returns number 或 null
 */
function asNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/**
 * 从 MapSource 提取 /maps/meta 所需的元信息（不含 version）。
 *
 * - kind=generated：直接取来源声明的尺寸/生成器/种子；
 * - kind=tiled：尺寸从 Tiled JSON 顶层字段（width/height/tilewidth/tileheight）
 *   派生，字段缺失时省略（不在返回对象上设置该键）。
 *
 * @param source 地图来源
 * @returns 元信息（generatorId/seed 仅 generated 存在）
 */
export function describeMapSource(source: MapSource): MapMetaInfo {
  if (source.kind === "generated") {
    return {
      id: source.id,
      name: source.name,
      kind: source.kind,
      width: source.width,
      height: source.height,
      tileWidth: source.tileWidth,
      tileHeight: source.tileHeight,
      generatorId: source.generatorId,
      seed: source.seed,
    };
  }

  const meta: MapMetaInfo = { id: source.id, name: source.name, kind: source.kind };
  const json = isRecord(source.json) ? source.json : null;
  const width = asNumber(json?.["width"]);
  const height = asNumber(json?.["height"]);
  const tileWidth = asNumber(json?.["tilewidth"]);
  const tileHeight = asNumber(json?.["tileheight"]);

  if (width !== null) meta.width = width;
  if (height !== null) meta.height = height;
  if (tileWidth !== null) meta.tileWidth = tileWidth;
  if (tileHeight !== null) meta.tileHeight = tileHeight;
  return meta;
}
