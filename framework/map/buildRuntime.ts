/**
 * 地图运行时构建入口：把“地图来源”（MapSource）解析为系统可直接使用的 MapRuntime。
 *
 * 两种来源的处理方式：
 * - `tiled`：转交 tiled.ts 的 mapRuntimeFromTiled，从 Tiled 导出 JSON 解析；
 * - `generated`：从 generatorRegistry 按 generatorId 取出生成器并执行，
 *   生成器参数即该来源对象本身（按 Record<string, unknown> 断言传入）。
 */
import type { MapRuntime, MapSource } from "framework/map/types";
import { mapRuntimeFromTiled } from "framework/map/tiled";
import { getRegistries } from "framework/bootstrap";

/**
 * 根据来源类型构建 MapRuntime。
 *
 * @param source 地图来源（Tiled 导入 / 程序生成）
 * @returns 运行时地图（grid / blocked / spawns / zones）
 */
export function buildMapRuntime(source: MapSource): MapRuntime {
  if (source.kind === "tiled") {
    return mapRuntimeFromTiled(source.id, source.name, source.json);
  }

  const { generatorRegistry } = getRegistries();
  const generator = generatorRegistry.get(source.generatorId);
  return generator(source as unknown as Record<string, unknown>);
}
