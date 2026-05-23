import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { deflateSync } from "node:zlib";
import type { MapRuntime } from "map/types";

type Rgba = readonly [number, number, number, number];

const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

const COLOR_GRID: Rgba = [210, 210, 210, 255];
const COLOR_WALKABLE: Rgba = [255, 255, 255, 255];
const COLOR_BLOCKED: Rgba = [0, 0, 0, 255];

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

function pngChunk(type: string, data: Uint8Array): Buffer {
  const typeBuf = Buffer.from(type, "ascii");
  const lenBuf = Buffer.alloc(4);
  lenBuf.writeUInt32BE(data.length, 0);

  const crcBuf = Buffer.alloc(4);
  const crcVal = crc32(Buffer.concat([typeBuf, Buffer.from(data)]));
  crcBuf.writeUInt32BE(crcVal, 0);

  return Buffer.concat([lenBuf, typeBuf, Buffer.from(data), crcBuf]);
}

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

function renderBlockedGridPng(runtime: MapRuntime, cellSize: number): Buffer {
  const gridW = runtime.grid.width;
  const gridH = runtime.grid.height;

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
        color = runtime.blocked[idx] === 1 ? COLOR_BLOCKED : COLOR_WALKABLE;
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

function mapRuntimeToJsonSerializable(runtime: MapRuntime) {
  return {
    ...runtime,
    blocked: Array.from(runtime.blocked),
  };
}

/**
 * 将“程序生成”后的运行时地图导出到本地文件（JSON + PNG）。
 *
 * - JSON：完整 MapRuntime，但会把 blocked 从 Uint8Array 转成 number[]
 * - PNG：以格子图展示 blocked（黑=阻挡，白=可走），并叠加细网格线
 *
 * @param runtime 生成后的 MapRuntime
 * @returns 导出的 json/png 绝对路径
 */
export function exportGeneratedMapArtifacts(runtime: MapRuntime): {
  jsonPath: string;
  pngPath: string;
} {
  const outDir = resolve(process.cwd(), "config/maps/exports");
  mkdirSync(outDir, { recursive: true });

  const base = runtime.id;
  const jsonPath = resolve(outDir, `${base}.json`);
  const pngPath = resolve(outDir, `${base}.png`);

  const json = JSON.stringify(mapRuntimeToJsonSerializable(runtime), null, 2);
  writeFileSync(jsonPath, json, "utf8");

  const png = renderBlockedGridPng(runtime, 8);
  writeFileSync(pngPath, png);

  return { jsonPath, pngPath };
}
