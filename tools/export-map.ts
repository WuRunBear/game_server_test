import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  bootstrapFramework,
  createGameInstance,
  exportGeometryArtifacts,
  loadGameDefinition,
  type TilePalette,
} from "framework";

/** RGBA 颜色值（固定四元组）。 */
type Rgba = readonly [number, number, number, number];

/**
 * 默认预览色表（数值语义 id → RGBA）。仅预览便利——语义 id 的含义命名
 * 映射在 game 配置侧；真实色表应经 --palette 文件参数覆盖。
 */
const DEFAULT_PALETTE: TilePalette = {
  1: [45, 65, 120, 255],
  2: [70, 130, 180, 255],
  3: [222, 196, 130, 255],
  4: [106, 153, 78, 255],
  5: [125, 115, 105, 255],
};

const isByte = (n: unknown): n is number =>
  typeof n === "number" && Number.isInteger(n) && n >= 0 && n <= 255;

/** 解析色表文件（JSON 对象：语义 id 字符串键 → [r,g,b] 或 [r,g,b,a]）。 */
function parsePaletteFile(path: string): TilePalette {
  const fullPath = resolve(process.cwd(), path);
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(fullPath, "utf8"));
  } catch (err) {
    throw new Error(`色表文件读取/解析失败: ${fullPath} — ${err instanceof Error ? err.message : String(err)}`);
  }
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(`色表文件必须是对象: {"<语义id>": [r,g,b] 或 [r,g,b,a]}`);
  }

  const palette: Record<number, Rgba> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (!/^\d+$/.test(key)) {
      throw new Error(`色表键必须是数字语义 id: "${key}"`);
    }
    if (!Array.isArray(value) || (value.length !== 3 && value.length !== 4) || !value.every(isByte)) {
      throw new Error(`色表 "${key}" 的值必须是 [r,g,b] 或 [r,g,b,a]（0–255 整数）`);
    }
    const [r, g, b] = value;
    palette[Number(key)] = [r, g, b, value.length === 4 ? value[3] : 255];
  }
  return palette;
}

export function exportMap(argv: string[]): void {
  const mapKey = argv[0] || null;

  const args: Record<string, string> = {};
  for (let i = 1; i < argv.length; i += 2) {
    if (argv[i]?.startsWith("--") && argv[i + 1] !== undefined) {
      args[argv[i].replace(/^--/, "")] = argv[i + 1];
    }
  }

  bootstrapFramework();

  try {
    const gameDef = loadGameDefinition();
    const instance = createGameInstance(gameDef);
    const world = instance.world;

    const available = Object.keys(world.maps);
    const selected = mapKey ?? world.defaultMapId;
    const geometry = world.maps[selected];
    if (!geometry) {
      throw new Error(`地图 "${selected}" 未在世界中构建。可用: ${available.join(", ") || "无"}`);
    }

    const palette = args.palette ? parsePaletteFile(args.palette) : DEFAULT_PALETTE;
    const outDir = args.out ? resolve(process.cwd(), args.out) : undefined;
    const { jsonPath, pngPath } = exportGeometryArtifacts(geometry, { outDir, palette });

    console.log(`地图已导出: ${jsonPath}, ${pngPath}`);
    console.log(`  version: ${geometry.version}, grid: ${geometry.grid.width}x${geometry.grid.height}, regions: ${[...geometry.regions.keys()].join(", ")}`);
  } catch (err) {
    console.error("地图导出失败:", err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}
