/**
 * map 模块公共出口（barrel）。
 *
 * 对外暴露：
 * - buildMapRuntime：地图来源 → MapRuntime 的唯一构建入口；
 * - 地图相关类型（MapRuntime / MapSource / MapZone / Vec2 等）。
 */
export { buildMapRuntime } from "map/buildRuntime";
export type {
  MapRuntime,
  MapSource,
  MapZone,
  GeneratedMapSource,
  TiledMapSource,
  Vec2,
} from "map/types";
