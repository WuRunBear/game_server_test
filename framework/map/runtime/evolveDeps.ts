/**
 * 演化引擎的真实依赖装配（framework/map/runtime/evolveDeps.ts）。
 *
 * 把引擎的 EvolutionDeps（seed / countByKind / canPlace / spawn）接到真实
 * ECS world 上，供开机初始演化（boot.ts）与每 tick 演化钩子（GameSimulation）
 * 共用——两条链路必须走同一套读写约定，保证「一次推演 ≡ 任意分段推演」。
 *
 * 坐标约定：引擎与选点全部工作在 **tile 坐标**；实体 Transform 为像素坐标。
 * spawn 通道负责 tile→像素中心换算（(t + 0.5) × tileWidth），占用/计数
 * 负责像素→tile 换算（floor(p / tileWidth)）——引擎缺省 spawn 通道不换算，
 * 真实接线必须使用本模块的装配。
 *
 * footprint 占位语义（与放置链 placeableSystem 同源，全框架一套）：
 * - 尺寸来源 = components/placeable.ts 的 footprintOf（Placeable.footprintW/H
 *   声明，未声明按 16px 兜底——Size 是碰撞包围盒语义，不作占位来源），
 *   px→tile 向上取整（≥1）；
 * - 矩形以 **中心 tile 锚定**：x0 = tx - ⌊(wt-1)/2⌋（与放置链 snapToGrid 对
 *   tile 中心坐标的量化一致——奇数尺寸居中、偶数尺寸向右/下扩展）；
 * - 占用按 footprint **整矩形** 登记，canPlace 同样展开整矩形逐格检查
 *   （界内 + 可走 + 未占用）——2×2 放置物不再互相重叠。
 *
 * 索引化（性能）：单次 createMapEvolveDeps 调用做一次实体全扫，构建
 * - 占用集：tile 线性索引（y*width+x）的 Set（按整矩形登记）；
 * - 计数索引：(region, kind) → 实体数（region = 中心 tile 的 regionOf）。
 * spawn 通道同步写两者（引擎契约：canPlace/countByKind 须反映本调用此前的
 * spawn 结果）；单次调用内实体只增不删（引擎不变式），索引无需失效。
 */
import { query } from "bitecs";

import { Transform } from "framework/components/transform";
import { Kind } from "framework/components/kind";
import { EntityMap } from "framework/components/entityMap";
import { footprintOf } from "framework/components/placeable";
import { spawnEntity } from "framework/entities/spawn";
import { regionOf } from "map/geometry/query";
import type { MapGeometry } from "map/geometry/types";
import type { EvolutionDeps } from "map/evolution/engine";
import type { GameWorld } from "framework/world";

/** 实体像素坐标 → tile 坐标（floor 换算；与 spawn 通道的中心换算互逆）。 */
function tileOf(geometry: MapGeometry, px: number, py: number): { tx: number; ty: number } {
  return {
    tx: Math.floor(px / geometry.grid.tileWidth),
    ty: Math.floor(py / geometry.grid.tileHeight),
  };
}

/**
 * 装配单图一次 evolve 调用的依赖：
 * - 占用集/计数索引在调用开始时从当前实体快照一次性构建，spawn 通道同步
 *   写入（引擎契约：canPlace/countByKind 须反映本调用此前的 spawn 结果）；
 * - countByKind 为索引 O(1) 查询（引擎保证每规则至多查一次）。
 *
 * @param world 目标世界
 * @param geometry 当前图几何（deps 绑定该图的网格换算）
 * @param seed 选点流种子（地图配置 seed）
 */
export function createMapEvolveDeps(world: GameWorld, geometry: MapGeometry, seed: number): EvolutionDeps {
  const { width, height, tileWidth, tileHeight } = geometry.grid;

  // 占用集：tile 线性索引（y*width+x）→ 按 footprint 整矩形登记
  const occupied = new Set<number>();
  // 计数索引：`${region}\u0000${kind}` → 实体数（region = 中心 tile 的 regionOf）
  const countsByRegionKind = new Map<string, number>();
  // footprint tile 数按 kind 缓存（同一 kind 的原型规格单次调用内不变）
  const footprintTilesByKind = new Map<string, { wt: number; ht: number }>();

  const toTileIndex = (tx: number, ty: number): number => ty * width + tx;

  /** kind 原型 footprint 的 tile 数（px→tile 向上取整，≥1；未知原型按 1×1）。 */
  const footprintTilesOf = (kind: string): { wt: number; ht: number } => {
    let tiles = footprintTilesByKind.get(kind);
    if (!tiles) {
      let w = 0;
      let h = 0;
      if (world.archetypes.has(kind)) {
        ({ w, h } = footprintOf(world.archetypes.get(kind)));
      }
      tiles = {
        wt: Math.max(1, Math.ceil(w / tileWidth)),
        ht: Math.max(1, Math.ceil(h / tileHeight)),
      };
      footprintTilesByKind.set(kind, tiles);
    }
    return tiles;
  };

  /**
   * kind footprint 以 (tx, ty) 中心 tile 锚定的覆盖矩形（左上角 + tile 数）。
   * 锚定与放置链 snapToGrid 的 tile 中心量化一致：x0 = tx - ⌊(wt-1)/2⌋
   * （奇数尺寸居中、偶数尺寸向右/下扩展；中心 tile 恒在矩形内）。
   */
  const rectOf = (kind: string, tx: number, ty: number): { x0: number; y0: number; wt: number; ht: number } => {
    const { wt, ht } = footprintTilesOf(kind);
    return { x0: tx - ((wt - 1) >> 1), y0: ty - ((ht - 1) >> 1), wt, ht };
  };

  /** 按 footprint 整矩形登记占用（界外格跳过）。 */
  const registerFootprint = (kind: string, tx: number, ty: number): void => {
    const { x0, y0, wt, ht } = rectOf(kind, tx, ty);
    for (let dy = 0; dy < ht; dy++) {
      const yy = y0 + dy;
      if (yy < 0 || yy >= height) continue;
      for (let dx = 0; dx < wt; dx++) {
        const xx = x0 + dx;
        if (xx < 0 || xx >= width) continue;
        occupied.add(toTileIndex(xx, yy));
      }
    }
  };

  /** 中心 tile 所属区域计数 +1（越界中心不计——与历史全扫语义一致）。 */
  const countUp = (kind: string, tx: number, ty: number): void => {
    const region = regionOf(geometry, tx, ty);
    if (region === undefined) return;
    const key = `${region}\u0000${kind}`;
    countsByRegionKind.set(key, (countsByRegionKind.get(key) ?? 0) + 1);
  };

  // 单次全扫：构建占用矩形 + 计数索引（替代旧「每次查询全表扫描」）
  for (const eid of query(world, [Transform])) {
    if (EntityMap[eid] !== geometry.key) continue;
    const { tx, ty } = tileOf(geometry, Transform.x[eid], Transform.y[eid]);
    const kind = Kind[eid] ?? "";
    registerFootprint(kind, tx, ty);
    countUp(kind, tx, ty);
  }

  return {
    seed,
    spawn: (kind, mapKey, tx, ty) => {
      const archetype = world.archetypes.get(kind);
      spawnEntity(world, archetype, world.components_registry, {
        x: (tx + 0.5) * tileWidth,
        y: (ty + 0.5) * tileHeight,
        mapId: mapKey,
      });
      registerFootprint(kind, tx, ty);
      countUp(kind, tx, ty);
    },
    canPlace: (_mapKey, kind, x, y) => {
      const { x0, y0, wt, ht } = rectOf(kind, x, y);
      for (let dy = 0; dy < ht; dy++) {
        const yy = y0 + dy;
        if (yy < 0 || yy >= height) return false;
        for (let dx = 0; dx < wt; dx++) {
          const xx = x0 + dx;
          if (xx < 0 || xx >= width) return false;
          if (geometry.walkable[toTileIndex(xx, yy)] !== 1) return false;
          if (occupied.has(toTileIndex(xx, yy))) return false;
        }
      }
      return true;
    },
    countByKind: (mapKey, region, kind) => {
      if (mapKey !== geometry.key) return 0;
      return countsByRegionKind.get(`${region}\u0000${kind}`) ?? 0;
    },
  };
}
