/**
 * 巢穴系统（nestSystem）：周期在巢周围把 spawnKind 实体补到容量。
 *
 * 每 tick 遍历活巢（Nest AoS 条目存在，AoS 不可查询——Transform 查询后过滤）：
 * - 对齐槽门控：world.time.tick % nest.intervalTicks === 0 才检查
 *   （与演化引擎 every 槽同一对齐约定）
 * - 存活重数：巢所在图上、spawnKind 相同、巢 radiusTiles 切比雪夫半径内的实体数
 *   （Kind/EntityMap 是 AoS，线性扫描后过滤），镜像进 Nest[eid].current
 * - 补足：存活 < capacity 时在巢半径内随机 tile 尝试落位——锚点 tile 可走 +
 *   占位合法性（footprintOf + overlapsAnyEntity/overlapsMapBlocked，与放置链
 *   同一套语义，见 spawnPlacement.trySpawnAtPixel）；每巢单门控尝试数有界
 *   （PLACEMENT_MAX_ATTEMPTS 惯例）
 * - 生成走 spawnEntity（AoS 初始化钩子照常）；spawnKind 原型缺失记 warn
 *   （每 kind 一次）并跳过该巢——配置错误可见但不砸 tick
 *
 * 确定性：每次尝试的随机流由 (tick, eid, attempt) 经 createRng 派生——
 * 不用 Math.random，同世界状态恒产生同落点序列，测试可精确断言。
 * 巢（实体）被摧毁即 AoS 条目消失 → 自然停产，无独立生命周期代码。
 */
import { query } from "bitecs";
import { Nest, Kind, Transform, entityMapOf } from "components";
import { createRng } from "framework/map/generate/rng";
import {
  PLACEMENT_MAX_ATTEMPTS,
  DEFAULT_SPAWN_RADIUS_TILES,
  attemptSeed,
  effectiveMapOf,
  randomTileCenterNear,
  trySpawnAtPixel,
} from "framework/systems/gameplay/spawnPlacement";
import type { GameWorld } from "world";

interface SystemConfig {
  /** 巢周围计数/落位搜索半径（tile，缺省 4）。 */
  radiusTiles?: number;
  /** 单巢单门控的落位尝试上限（缺省 32）。 */
  maxAttempts?: number;
}

export function createNestSystem(config?: Record<string, unknown>) {
  const radiusTiles =
    typeof config?.radiusTiles === "number" && config.radiusTiles > 0
      ? Math.floor(config.radiusTiles)
      : DEFAULT_SPAWN_RADIUS_TILES;
  const maxAttempts =
    typeof config?.maxAttempts === "number" && config.maxAttempts > 0
      ? Math.floor(config.maxAttempts)
      : PLACEMENT_MAX_ATTEMPTS;
  // spawnKind 原型缺失告警去重（每 kind 一次——配置错误可见但不刷屏）
  const warnedMissingKinds = new Set<string>();

  return function nestSystem(world: GameWorld): GameWorld {
    const tick = world.time.tick;

    for (const nestEid of query(world, [Transform])) {
      const nest = Nest[nestEid];
      if (!nest) continue;
      // 对齐槽门控（与演化引擎 every 槽同一约定）
      if (tick % nest.intervalTicks !== 0) continue;

      const mapId = effectiveMapOf(world, nestEid);
      const geometry = mapId === "" ? undefined : world.maps[mapId];
      if (!geometry) continue; // 空串归属=无图世界；非空不可解析已由 effectiveMapOf 记 error

      if (!world.archetypes.has(nest.spawnKind)) {
        if (!warnedMissingKinds.has(nest.spawnKind)) {
          warnedMissingKinds.add(nest.spawnKind);
          world.logger.warn("nest spawnKind archetype is not registered; nest skipped", {
            eid: nestEid,
            spawnKind: nest.spawnKind,
          });
        }
        continue;
      }
      const archetype = world.archetypes.get(nest.spawnKind);

      const { tileWidth, tileHeight } = geometry.grid;
      const nestTx = Math.floor(Transform.x[nestEid] / tileWidth);
      const nestTy = Math.floor(Transform.y[nestEid] / tileHeight);

      // 存活重数（线性扫描惯例：Kind/EntityMap 为 AoS，查询后过滤）
      let alive = 0;
      for (const eid of query(world, [Transform])) {
        if (Kind[eid] !== nest.spawnKind) continue;
        if (entityMapOf(world, eid) !== mapId) continue;
        const dx = Math.floor(Transform.x[eid] / tileWidth) - nestTx;
        const dy = Math.floor(Transform.y[eid] / tileHeight) - nestTy;
        if (Math.max(Math.abs(dx), Math.abs(dy)) <= radiusTiles) alive += 1;
      }
      nest.current = alive;

      // 补足至容量：半径内随机 tile + 可走/占位合法性，尝试数有界
      for (let attempt = 0; attempt < maxAttempts && alive < nest.capacity; attempt += 1) {
        const rng = createRng(attemptSeed(tick, nestEid, 0, attempt));
        const { px, py } = randomTileCenterNear(rng, geometry, nestTx, nestTy, radiusTiles);
        if (trySpawnAtPixel(world, geometry, mapId, archetype, px, py)) alive += 1;
      }
    }

    return world;
  };
}

/** 无配置默认实例（向后兼容直接注册形态）。 */
export function nestSystem(world: GameWorld): GameWorld {
  return createNestSystem()(world);
}
