/**
 * 演化引擎的真实依赖装配（framework/map/runtime/evolveDeps.ts）。
 *
 * 把引擎的 EvolutionDeps（seed / countByKind / isOccupied / spawn）接到真实
 * ECS world 上，供开机初始演化（boot.ts）与每 tick 演化钩子（GameSimulation）
 * 共用——两条链路必须走同一套读写约定，保证「一次推演 ≡ 任意分段推演」。
 *
 * 坐标约定：引擎与选点全部工作在 **tile 坐标**；实体 Transform 为像素坐标。
 * spawn 通道负责 tile→像素中心换算（(t + 0.5) × tileWidth），计数/占用查询
 * 负责像素→tile 换算（floor(p / tileWidth)）——引擎缺省 spawn 通道不换算，
 * 真实接线必须使用本模块的装配。
 */
import { query } from "bitecs";

import { Transform } from "framework/components/transform";
import { Kind } from "framework/components/kind";
import { EntityMap } from "framework/components/entityMap";
import { spawnEntity } from "framework/entities/spawn";
import { regionOf } from "map/geometry/query";
import type { MapGeometry } from "map/geometry/types";
import type { EvolutionDeps } from "map/evolution/engine";
import type { GameWorld } from "framework/world";

/** 占用集键：tile 坐标对（"tx,ty"）。 */
function tileKey(tx: number, ty: number): string {
  return `${tx},${ty}`;
}

/** 实体像素坐标 → tile 坐标（floor 换算；与 spawn 通道的中心换算互逆）。 */
function tileOf(geometry: MapGeometry, px: number, py: number): { tx: number; ty: number } {
  return {
    tx: Math.floor(px / geometry.grid.tileWidth),
    ty: Math.floor(py / geometry.grid.tileHeight),
  };
}

/**
 * 装配单图一次 evolve 调用的依赖：
 * - 占用集在调用开始时从当前实体快照构建，spawn 通道同步写入（引擎契约：
 *   isOccupied 须反映本调用此前的 spawn 结果）；
 * - countByKind 惰性到规则首个槽（引擎保证每规则至多查一次），实时扫描。
 *
 * @param world 目标世界
 * @param geometry 当前图几何（deps 绑定该图的网格换算）
 * @param seed 选点流种子（地图配置 seed）
 */
export function createMapEvolveDeps(world: GameWorld, geometry: MapGeometry, seed: number): EvolutionDeps {
  const occupied = new Set<string>();
  for (const eid of query(world, [Transform])) {
    if (EntityMap[eid] !== geometry.key) continue;
    const { tx, ty } = tileOf(geometry, Transform.x[eid], Transform.y[eid]);
    occupied.add(tileKey(tx, ty));
  }

  return {
    seed,
    spawn: (kind, mapKey, tx, ty) => {
      const archetype = world.archetypes.get(kind);
      spawnEntity(world, archetype, world.components_registry, {
        x: (tx + 0.5) * geometry.grid.tileWidth,
        y: (ty + 0.5) * geometry.grid.tileHeight,
        mapId: mapKey,
      });
      occupied.add(tileKey(tx, ty));
    },
    isOccupied: (_mapKey, tx, ty) => occupied.has(tileKey(tx, ty)),
    countByKind: (mapKey, region, kind) => {
      let count = 0;
      for (const eid of query(world, [Transform])) {
        if (EntityMap[eid] !== mapKey || Kind[eid] !== kind) continue;
        const { tx, ty } = tileOf(geometry, Transform.x[eid], Transform.y[eid]);
        if (regionOf(geometry, tx, ty) === region) count += 1;
      }
      return count;
    },
  };
}
