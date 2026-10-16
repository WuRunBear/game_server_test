/**
 * 室内语义（framework/map/runtime/indoors.ts）——派生查询，不落盘。
 *
 * v2 地图切片 6：房间检测 = **墙围合 + 头顶有板**。产出为查询期现算的
 * 派生语义（设计文档 §2 派生视图层 / §5 房间检测），本模块不向任何组件或
 * 存档写入；季节天气（雪/雨/温度）的玩法接线留给气候切片，API 形状按其
 * 需要预留（输入：格或实体；输出：枚举，便于未来扩展半遮蔽等中间态）。
 *
 * 判定算法（对查询格 (x, y, level)）：
 * 1. **有顶**：该格在 level+1 层有楼板实体（Structure role=floor 的可站面
 *    同时是其下一格的屋顶）——无顶直接判露天（快速路径，跳过洪泛）；
 * 2. **围合**：从该格在同一层的平面上 4-邻接洪泛（floodSameLevel 同源基元），
 *    墙实体（Structure role=wall）与图边界为阻挡；洪泛访问格数超过
 *    maxEnclosedArea（缺省 256 格）即视为「豁通到远方」→ 露天。
 *    两步都过 = 室内。
 *
 * 成本：O(min(房间面积, maxEnclosedArea))，每格一次；无缓存——气候切片
 * 若需逐 tick 逐实体消费，应在调用方按帧缓存（建造实体变化前结果不变）。
 *
 * 纯函数性：同 (world 建造实体集, 查询格) 恒同输出；不依赖 tick/相位。
 */
import { query } from "bitecs";

import { Transform } from "framework/components/transform";
import { entityMapOf } from "framework/components/entityMap";
import { entityLevelOf } from "framework/components/entityLevel";
import {
  collectBuiltStructures,
  floodSameLevel,
  type BuiltStructuresIndex,
} from "framework/map/runtime/builtStructures";
import type { GameWorld } from "framework/world";

/** 空间露天语义枚举（indoor=室内；后续气候切片可扩展半遮蔽等中间态）。 */
export type SpaceExposure = "indoor" | "outdoor";

/** 围合判定洪泛格数上限（缺省）：超过即视为豁通远方（露天）。 */
export const DEFAULT_MAX_ENCLOSED_AREA = 256;

/** 室内判定选项。 */
export interface IndoorsOptions {
  /** 围合洪泛格数上限（缺省 DEFAULT_MAX_ENCLOSED_AREA）。 */
  maxEnclosedArea?: number;
}

/**
 * 按格查询空间露天语义。
 *
 * @param world ECS 世界（建造实体来源）
 * @param mapId 地图 key
 * @param x tile 列坐标
 * @param y tile 行坐标
 * @param level 查询层号
 * @param options 判定选项（围合面积上限）
 * @returns "indoor"（墙围合且头顶有楼板）| "outdoor"（其余）
 */
export function spaceExposureAt(
  world: GameWorld,
  mapId: string,
  x: number,
  y: number,
  level: number,
  options: IndoorsOptions = {},
): SpaceExposure {
  const geometry = world.maps[mapId];
  if (!geometry) return "outdoor";
  const { width, height } = geometry.grid;
  if (x < 0 || y < 0 || x >= width || y >= height) return "outdoor";

  const built: BuiltStructuresIndex = collectBuiltStructures(world, mapId);

  // 1. 有顶：level+1 层该格有楼板（楼板是可站面，同时是其下一格的屋顶）
  if (!built.floors.get(level + 1)?.has(y * width + x)) return "outdoor";

  // 2. 围合：同层洪泛被墙/边界封闭，且洪泛在触及面积上限前自然耗尽
  // （洪泛触顶 = 区域豁通到 ≥ maxEnclosedArea 格的远方 → 露天）
  const maxVisited = options.maxEnclosedArea ?? DEFAULT_MAX_ENCLOSED_AREA;
  const reach = floodSameLevel(geometry, built, x, y, level, { maxVisited });
  if (reach.size >= maxVisited) return "outdoor";
  return "indoor";
}

/** 按格查询是否室内（spaceExposureAt 的布尔便捷形态）。 */
export function isIndoors(
  world: GameWorld,
  mapId: string,
  x: number,
  y: number,
  level: number,
  options: IndoorsOptions = {},
): boolean {
  return spaceExposureAt(world, mapId, x, y, level, options) === "indoor";
}

/**
 * 按实体查询空间露天语义（实体所在格 + 实体层号）。
 *
 * @param world ECS 世界
 * @param eid 实体 id（须挂 Transform；无归属图/图未构建判露天）
 */
export function entitySpaceExposure(world: GameWorld, eid: number): SpaceExposure {
  const geometry = world.maps[entityMapOf(world, eid)];
  if (!geometry) return "outdoor";
  const { tileWidth, tileHeight } = geometry.grid;
  return spaceExposureAt(
    world,
    geometry.key,
    Math.floor(Transform.x[eid] / tileWidth),
    Math.floor(Transform.y[eid] / tileHeight),
    entityLevelOf(eid),
  );
}

/** 按实体查询是否室内（entitySpaceExposure 的布尔便捷形态）。 */
export function entityIsIndoors(world: GameWorld, eid: number): boolean {
  return entitySpaceExposure(world, eid) === "indoor";
}

/** 供未来气候切片按需全量枚举室内实体（当前无 tick 消费方，按需调用）。 */
export function listIndoorEntities(world: GameWorld): number[] {
  const result: number[] = [];
  for (const eid of query(world, [Transform])) {
    if (entityIsIndoors(world, eid)) result.push(eid);
  }
  return result;
}
