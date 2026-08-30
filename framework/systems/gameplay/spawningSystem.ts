/**
 * spawningSystem（已退役的空操作——文件删除归后续 todo）。
 *
 * 实体生产的唯一决策路径是地图演化引擎（framework/map/evolution）：规则已
 * 迁入 game/maps/entity-rules.json，开机初始铺放与每 tick 补差统一走
 * bootMaps / GameSimulation 的 evolve 钩子。本系统保留注册仅为兼容既有
 * game.json systems 列表（移除注册与删除文件归后续 todo），tick 体恒为
 * no-op——resolvedSpawns 已无规则来源，旧的 zone 随机刷怪逻辑随之消亡。
 */
import type { GameWorld } from "world";

export function spawningSystem(world: GameWorld): GameWorld {
  return world;
}
