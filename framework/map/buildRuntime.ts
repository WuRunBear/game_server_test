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
import { validateMapRuntime } from "framework/map/validate";
import { createLogger } from "framework/utils/logger";

/** 构建日志器（游戏无关 scope），用于输出校验软告警。 */
const logger = createLogger("build-map");

/**
 * 根据来源类型构建 MapRuntime。
 *
 * 两种来源统一在出口处经 validateMapRuntime 校验：
 * - errors 非空 → 地图不可用（出生点阻挡/越界/缺失），抛错；否则
 * - warnings 逐条 logger.warn（连通性软告警，不阻断）。
 *
 * @param source 地图来源（Tiled 导入 / 程序生成）
 * @returns 运行时地图（grid / blocked / spawns / zones）
 * @throws Error 当校验发现硬错误（errors 非空）时抛出
 */
export function buildMapRuntime(source: MapSource): MapRuntime {
  let runtime: MapRuntime;
  if (source.kind === "tiled") {
    runtime = mapRuntimeFromTiled(source.id, source.name, source.json);
  } else {
    const { generatorRegistry } = getRegistries();
    const generator = generatorRegistry.get(source.generatorId);
    runtime = generator(source as unknown as Record<string, unknown>);
  }

  const report = validateMapRuntime(runtime);
  if (report.errors.length > 0) {
    throw new Error(`map ${runtime.id}: ${report.errors.join("; ")}`);
  }
  for (const warning of report.warnings) {
    logger.warn(warning);
  }
  return runtime;
}
