import { buildMapRuntime } from "map/buildRuntime";
import { exportGeneratedMapArtifacts } from "map/exportGenerated";
import { getMapSourceFromConfig } from "config/map";

/**
 * 工具层：加载地图来源配置 → 构建运行时 → 导出产物到磁盘（JSON + PNG）。
 *
 * 原先此副作用内嵌在 buildMapRuntime 中，现在分离为独立工具函数，
 * 框架核心 `buildMapRuntime` 保持纯函数。
 */
export function exportMap(): void {
  const source = getMapSourceFromConfig();
  const runtime = buildMapRuntime(source);
  const { jsonPath, pngPath } = exportGeneratedMapArtifacts(runtime);
  console.log(`Map exported: ${jsonPath}, ${pngPath}`);
}
