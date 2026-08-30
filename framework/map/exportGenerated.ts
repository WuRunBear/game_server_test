/**
 * 地图几何导出工具：把 MapGeometry 落盘为 JSON 快照与 PNG 预览图。
 *
 * 用途（tools 命令 export-map）：导出产物供人工检查与前端对照。
 * PNG 用纯 Node 实现（zlib deflate + 手写 crc32），不依赖任何图片库。
 * 上色依据 tiles 的数值语义 id，色表由调用方（工具层）以参数传入——
 * 框架不解释语义含义；色表未覆盖的语义 id 用中性灰兜底。
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { deflateSync } from "node:zlib";
import type { MapGeometry } from "map/geometry/types";
import { serializeGeometry } from "map/geometry/snapshot";

/** RGBA 颜色值（固定四元组）。 */
type Rgba = readonly [number, number, number, number];

/**
 * 语义 id → RGBA 色表（工具层参数；键为 tiles 中的数值语义 id）。
 * 语义 id 的含义命名映射在 game 配置侧，框架与色表本身都不解释。
 */
export type TilePalette = Readonly<Record<number, Rgba>>;

/** PNG 文件头签名（固定 8 字节魔数）。 */
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

/** 网格线颜色（浅灰）。 */
const COLOR_GRID: Rgba = [210, 210, 210, 255];
/** 色表未覆盖语义 id 的兜底色（中性灰）。 */
const COLOR_FALLBACK: Rgba = [153, 153, 153, 255];

/** 计算 PNG chunk 的 CRC32 校验和（标准 0xedb88320 反射多项式）。 */
function crc32(buf: Uint8Array): number {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i += 1) {
    crc ^= buf[i]!;
    for (let k = 0; k < 8; k += 1) {
      const mask = -(crc & 1);
      crc = (crc >>> 1) ^ (0xedb88320 & mask);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/** 构造一个 PNG chunk（长度 + 类型 + 数据 + CRC 校验）。 */
function pngChunk(type: string, data: Uint8Array): Buffer {
  const typeBuf = Buffer.from(type, "ascii");
  const lenBuf = Buffer.alloc(4);
  lenBuf.writeUInt32BE(data.length, 0);

  const crcBuf = Buffer.alloc(4);
  const crcVal = crc32(Buffer.concat([typeBuf, Buffer.from(data)]));
  crcBuf.writeUInt32BE(crcVal, 0);

  return Buffer.concat([lenBuf, typeBuf, Buffer.from(data), crcBuf]);
}

/** 把 RGBA 像素数组编码为 PNG Buffer（8bit RGBA、行首 0 滤波）。 */
function encodePngRgba(width: number, height: number, rgba: Uint8Array): Buffer {
  const scanlineSize = 1 + width * 4;
  const raw = Buffer.alloc(scanlineSize * height);
  for (let y = 0; y < height; y += 1) {
    const rowStart = y * scanlineSize;
    raw[rowStart] = 0;
    raw.set(rgba.subarray(y * width * 4, (y + 1) * width * 4), rowStart + 1);
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  const idat = deflateSync(raw);

  return Buffer.concat([
    PNG_SIGNATURE,
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", idat),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

/**
 * 把 tiles 语义网格渲染为预览图（每格 cellSize 像素，叠加浅灰网格线；
 * 颜色 = 色表[语义 id]，未覆盖的语义 id 用中性灰兜底）。
 */
function renderTileGridPng(geometry: MapGeometry, palette: TilePalette, cellSize: number): Buffer {
  const gridW = geometry.grid.width;
  const gridH = geometry.grid.height;

  const width = gridW * cellSize + 1;
  const height = gridH * cellSize + 1;
  const rgba = new Uint8Array(width * height * 4);

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const isGridLine = x % cellSize === 0 || y % cellSize === 0;
      let color: Rgba;

      if (isGridLine) {
        color = COLOR_GRID;
      } else {
        const tx = Math.floor(x / cellSize);
        const ty = Math.floor(y / cellSize);
        const idx = ty * gridW + tx;
        color = palette[geometry.tiles[idx]] ?? COLOR_FALLBACK;
      }

      const p = (y * width + x) * 4;
      rgba[p] = color[0];
      rgba[p + 1] = color[1];
      rgba[p + 2] = color[2];
      rgba[p + 3] = color[3];
    }
  }

  return encodePngRgba(width, height, rgba);
}

/** 导出选项：输出目录 / 语义色表 / 每格像素尺寸。 */
export interface GeometryExportOptions {
  /** 输出目录（缺省当前工作目录）。 */
  outDir?: string;
  /** 语义 id → RGBA 色表（缺省空表——全部语义走兜底灰）。 */
  palette?: TilePalette;
  /** PNG 每格像素尺寸（缺省 8）。 */
  cellSize?: number;
}

/**
 * 将地图几何导出到本地文件（JSON 快照 + PNG 预览图）。
 *
 * - JSON：serializeGeometry 快照（tiles/walkable/regions/regionOfTile/version，
 *   类型化数组编码为 number[]，与 /maps/runtime 应答同形状）
 * - PNG：以格子图展示 tiles 语义上色（色表为参数），并叠加细网格线
 *
 * @param geometry 生成后的 MapGeometry
 * @returns 导出的 json/png 绝对路径
 */
export function exportGeometryArtifacts(
  geometry: MapGeometry,
  options: GeometryExportOptions = {},
): { jsonPath: string; pngPath: string } {
  const dir = resolve(options.outDir ?? process.cwd());
  mkdirSync(dir, { recursive: true });

  const base = geometry.key;
  const jsonPath = resolve(dir, `${base}.json`);
  const pngPath = resolve(dir, `${base}.png`);

  writeFileSync(jsonPath, JSON.stringify(serializeGeometry(geometry), null, 2), "utf8");
  writeFileSync(pngPath, renderTileGridPng(geometry, options.palette ?? {}, options.cellSize ?? 8));

  return { jsonPath, pngPath };
}
