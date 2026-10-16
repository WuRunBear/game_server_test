import { createRequire } from "node:module";
import { hasComponent, query } from "bitecs";
import type { Body, Box, Circle, Response, System as Check2dSystem } from "check2d";

const require = createRequire(import.meta.url);
const check2d = require("check2d") as typeof import("check2d");

import { Collider, ColliderShape, Transform, Velocity } from "components";
import { entityMapOf } from "framework/components/entityMap";
import { entityLevelOf } from "framework/components/entityLevel";
import { distinctLevels, walkableAtLevel, type BuiltFloorsByLevel } from "map/geometry/query";
import {
  collectBuiltStructures,
  getBuiltStructuresEpoch,
  type BuiltStructuresIndex,
} from "framework/map/runtime/builtStructures";
import type { MapGeometry } from "map/geometry/types";
import type { EntityId, GameWorld } from "world";

/**
 * 碰撞系统：基于 check2d（SAT 分离）做服务端碰撞。
 *
 * 运行位置：每 tick 在 movementSystem / entityLevelSystem 之后执行——
 * 先由 movementSystem 把速度积分到位移、entityLevelSystem 推导实体层号，
 * 本系统再纠正越界/重叠的位置。
 * 职责：
 * - 把地图阻挡格与实体（Transform + Collider）同步成 check2d 碰撞体
 * - 执行分离，把重叠实体推开，并把修正后的坐标写回 ECS
 * - 若某轴被修正（顶到障碍），清零该轴速度，避免持续顶墙抖动
 * 运行时缓存在 world.systemRuntimes["collision"]：
 * Map<mapId, Map<level, CollisionRuntime>>——**按 (地图, 层号) 分区**（v2
 * 地图切片 5：每层一个碰撞世界，静态体是该层视角下的阻挡格；跨图/跨层
 * 实体绝不进同一运行时，同一坐标不同图/不同层的实体互不碰撞）。
 * 静态体按**行游程矩形合并**（同一行连续阻挡格合并为一个 box，纯性能改进，
 * 阻挡语义与逐格等价）。实体按其 (entityMapOf, entityLevelOf) 同步进对应
 * 运行时，懒初始化，跨 tick 复用。
 */

/**
 * 碰撞系统调试里的地图占位结构。
 */
export type CollisionDebugMapBody = {
  kind: "map";
  shape: "box";
  x: number;
  y: number;
  width: number;
  height: number;
};

/**
 * 碰撞系统调试里的实体占位结构。
 */
export type CollisionDebugEntityBody =
  | {
      kind: "entity";
      shape: "circle";
      eid: EntityId;
      x: number;
      y: number;
      r: number;
    }
  | {
      kind: "entity";
      shape: "box";
      eid: EntityId;
      x: number;
      y: number;
      width: number;
      height: number;
    };

/**
 * 碰撞调试快照。
 */
export type CollisionDebugBody = CollisionDebugMapBody | CollisionDebugEntityBody;

/**
 * 碰撞调试快照结果。
 */
export type CollisionDebugSnapshot = {
  tick: number;
  mapBodies?: CollisionDebugMapBody[];
  entityBodies: CollisionDebugEntityBody[];
  pairs: CollisionDebugPair[];
};

/**
 * 碰撞调试里的碰撞对信息。
 */
export type CollisionDebugPair = {
  id: string;
  a: string;
  b: string;
  overlap: number;
};

/** 碰撞体附加的用户数据：区分地图格与实体，供调试 id 使用。 */
type CollisionBodyUserData =
  | {
      kind: "map";
      id: string;
    }
  | {
      kind: "entity";
      eid: EntityId;
      id: string;
    };

/** 携带 userData 的 check2d 碰撞体。 */
type CollisionBody = Body<CollisionBodyUserData>;

/** 碰撞运行时：check2d 系统 + 地图/实体碰撞体缓存 + 本帧调试碰撞对。 */
type CollisionRuntime = {
  system: Check2dSystem<CollisionBody>;
  mapBodies: CollisionBody[];
  entityBodies: Map<EntityId, CollisionBody>;
  pairs: CollisionDebugPair[];
  /** 构建静态体时的建造纪元（楼板增删 → 纪元变化 → 静态体重建）。 */
  builtEpoch: number;
};

/** 单图按层的碰撞运行时表：level → CollisionRuntime（每层一个碰撞世界）。 */
type MapCollisionRuntimes = Map<number, CollisionRuntime>;

/** world.systemRuntimes 中碰撞运行时表的缓存键（值为 Map<mapId, MapCollisionRuntimes>）。 */
const COLLISION_KEY = "collision";

/** 判定"位置被分离修正"的最小阈值，用于避免浮点误差导致的误判。 */
const POSITION_EPSILON = 0.0001;

/**
 * 判断碰撞体是否为圆形。
 *
 * @param body check2d 碰撞体
 * @returns 是否为圆形
 */
function isCircleBody(body: CollisionBody): body is Circle<CollisionBodyUserData> {
  return body.type === check2d.BodyType.Circle;
}

/**
 * 判断碰撞体是否为矩形。
 *
 * @param body check2d 碰撞体
 * @returns 是否为矩形
 */
function isBoxBody(body: CollisionBody): body is Box<CollisionBodyUserData> {
  return body.type === check2d.BodyType.Box;
}

/**
 * 读取实体碰撞体的中心点坐标。
 *
 * @param body check2d 碰撞体
 * @returns 中心点坐标
 */
function getBodyCenter(body: CollisionBody): { x: number; y: number } {
  if (isCircleBody(body)) {
    return { x: body.x, y: body.y };
  }

  if (isBoxBody(body)) {
    return {
      x: body.x + body.width * 0.5,
      y: body.y + body.height * 0.5,
    };
  }

  return {
    x: body.x,
    y: body.y,
  };
}

/**
 * 生成调试用的碰撞体标识。
 *
 * @param body check2d 碰撞体
 * @returns 稳定字符串 id
 */
function getDebugBodyId(body: CollisionBody): string {
  const data = body.userData;
  return data?.id ?? "unknown";
}

/**
 * 判断碰撞体是否匹配实体当前声明的形状。
 *
 * @param body 现有 check2d 碰撞体
 * @param eid 实体 id
 * @param world ECS World
 * @returns 是否可复用
 */
function doesBodyMatchShape(body: CollisionBody, eid: EntityId, world: GameWorld): boolean {
  const shape = Collider.shape[eid];
  return shape === ColliderShape.Circle ? isCircleBody(body) : isBoxBody(body);
}

/**
 * 为阻挡格游程创建静态矩形碰撞体（行游程合并：同一行连续阻挡格合为一个 box）。
 *
 * @param system check2d 系统
 * @param x 游程左缘像素 x
 * @param y 游程所在行像素 y
 * @param width 游程像素宽
 * @param height 单格像素高
 * @param tileX 游程起始格 x（调试 id 用）
 * @param tileY 游程所在行格 y（调试 id 用）
 * @returns 创建后的静态碰撞体
 */
function createMapBody(
  system: Check2dSystem<CollisionBody>,
  x: number,
  y: number,
  width: number,
  height: number,
  tileX: number,
  tileY: number,
): CollisionBody {
  return system.createBox(
    { x, y },
    width,
    height,
    {
      isStatic: true,
      userData: {
        kind: "map",
        id: `map:${tileX}:${tileY}`,
      },
    },
  ) as CollisionBody;
}

/**
 * 构建某图某层视角下的全部静态碰撞体（行游程矩形合并）。
 *
 * 阻挡判定走 walkableAtLevel（与 projectile 同源的按层查询）：每层的阻挡 =
 * 该层视角下的不可走格——cliff 格对不高于其层号的视角单向可越（跳下语义），
 * 其余不可走格在任何层都阻挡；`built` 提供时楼板实体让其所在格在该层可站
 * （前置修正 3：地形 OR 建造）。合并是纯性能改进（阻挡集合与逐格并集等价，
 * map-block 运行时测试有等价性对照）。
 *
 * @param system check2d 系统
 * @param map 地图几何
 * @param level 该碰撞世界的层号
 * @param built 建造层楼板索引（可选；缺省仅地形判定）
 * @returns 静态碰撞体列表
 */
export function buildLevelMapBodies(
  system: Check2dSystem<CollisionBody>,
  map: MapGeometry,
  level: number,
  built?: BuiltFloorsByLevel,
): CollisionBody[] {
  const bodies: CollisionBody[] = [];
  const { width, height, tileWidth, tileHeight } = map.grid;

  for (let tileY = 0; tileY < height; tileY += 1) {
    let runStart = -1;
    for (let tileX = 0; tileX <= width; tileX += 1) {
      const blocked =
        tileX < width && !walkableAtLevel(map, tileX, tileY, level, built);
      if (blocked && runStart < 0) {
        runStart = tileX;
      } else if (!blocked && runStart >= 0) {
        bodies.push(
          createMapBody(
            system,
            runStart * tileWidth,
            tileY * tileHeight,
            (tileX - runStart) * tileWidth,
            tileHeight,
            runStart,
            tileY,
          ),
        );
        runStart = -1;
      }
    }
  }

  return bodies;
}

/**
 * 为实体创建碰撞体。
 *
 * 静态判定：挂 Velocity 的实体（玩家/生物，movementSystem 驱动）为动态体，
 * 否则（建筑/资源等无移动能力的实体）注册为静态体——分离时不被推开。
 * 若无此判定，玩家放置的墙会被玩家顶走（动态 body 互相分离）。
 *
 * @param world ECS World
 * @param system check2d 系统
 * @param eid 实体 id
 * @returns 创建后的碰撞体
 */
function createEntityBody(
  world: GameWorld,
  system: Check2dSystem<CollisionBody>,
  eid: EntityId,
): CollisionBody {
  const isStatic = !hasComponent(world, eid, Velocity);
  const bodyOptions = {
    isStatic,
    userData: {
      kind: "entity",
      eid,
      id: `entity:${eid}`,
    },
  };

  if (Collider.shape[eid] === ColliderShape.Circle) {
    return system.createCircle(
      { x: Transform.x[eid], y: Transform.y[eid] },
      Collider.radius[eid],
      bodyOptions,
    ) as CollisionBody;
  }

  return system.createBox(
    {
      x: Transform.x[eid] - Collider.halfW[eid],
      y: Transform.y[eid] - Collider.halfH[eid],
    },
    Collider.halfW[eid] * 2,
    Collider.halfH[eid] * 2,
    bodyOptions,
  ) as CollisionBody;
}

/**
 * 根据当前实体组件数据同步 check2d 碰撞体。
 *
 * @param world ECS World
 * @param eid 实体 id
 * @param body 可复用的碰撞体
 */
function syncEntityBody(world: GameWorld, eid: EntityId, body: CollisionBody): void {
  if (Collider.shape[eid] === ColliderShape.Circle && isCircleBody(body)) {
    body.r = Collider.radius[eid];
    body.setPosition(Transform.x[eid], Transform.y[eid], true);
    return;
  }

  if (Collider.shape[eid] === ColliderShape.Box && isBoxBody(body)) {
    body.width = Collider.halfW[eid] * 2;
    body.height = Collider.halfH[eid] * 2;
    body.setPosition(
      Transform.x[eid] - Collider.halfW[eid],
      Transform.y[eid] - Collider.halfH[eid],
      true,
    );
  }
}

/**
 * 取（或惰性创建）world.systemRuntimes["collision"] 的运行时表。
 * @returns 按 mapId → 按层运行时表索引的两级表
 */
function getCollisionRuntimeMap(world: GameWorld): Map<string, MapCollisionRuntimes> {
  let runtimes = world.systemRuntimes.get(COLLISION_KEY) as
    | Map<string, MapCollisionRuntimes>
    | undefined;
  if (!runtimes) {
    runtimes = new Map<string, MapCollisionRuntimes>();
    world.systemRuntimes.set(COLLISION_KEY, runtimes);
  }
  return runtimes;
}

/**
 * 取某地图的几何（阻挡格来源）。空串归属（无图配置世界的哨兵）返回
 * undefined——得到无地图体的碰撞运行时；非空 mapId 解析不到已构建图即抛
 * 含 mapId 的显式错误（归属异常是配置/存档 bug，不允许静默回退默认图）。
 */
function getCollisionMapSource(world: GameWorld, mapId: string): MapGeometry | undefined {
  if (mapId === "") return undefined;
  const geometry = world.maps[mapId];
  if (!geometry) {
    throw new Error(`collision: map "${mapId}" is not present in world.maps`);
  }
  return geometry;
}

/**
 * 懒初始化某图某层的碰撞运行时，并把该层视角下的阻挡格（行游程合并）
 * 注册为静态碰撞体。
 *
 * 静态体的阻挡判定含建造楼板（地形 OR 建造，前置修正 3）：运行时记录构建
 * 时的建造纪元，楼板增删（纪元递增）后下次访问即重建静态体——实体碰撞体
 * 缓存保留（墙/连接器是实体体，不随静态体重建）。
 *
 * @param world ECS World
 * @param mapId 地图 id
 * @param level 层号（碰撞世界分区键）
 * @returns 可复用的碰撞运行时
 */
function ensureCollisionRuntime(world: GameWorld, mapId: string, level: number): CollisionRuntime {
  const runtimeMap = getCollisionRuntimeMap(world);
  let byLevel = runtimeMap.get(mapId);
  if (!byLevel) {
    byLevel = new Map<number, CollisionRuntime>();
    runtimeMap.set(mapId, byLevel);
  }
  const existing = byLevel.get(level);
  const builtEpoch = getBuiltStructuresEpoch(world, mapId);
  if (existing) {
    if (existing.builtEpoch !== builtEpoch) {
      rebuildMapBodies(world, existing, mapId, level, builtEpoch);
    }
    return existing;
  }

  const system = new check2d.System<CollisionBody>();

  const map = getCollisionMapSource(world, mapId);
  const built = map ? collectBuiltStructures(world, mapId) : undefined;
  const mapBodies = map ? buildLevelMapBodies(system, map, level, built) : [];

  const runtime: CollisionRuntime = {
    system,
    mapBodies,
    entityBodies: new Map<EntityId, CollisionBody>(),
    pairs: [],
    builtEpoch,
  };

  byLevel.set(level, runtime);
  return runtime;
}

/**
 * 重建某图某层运行时的静态碰撞体（建造纪元变化时调用）：移除旧地图体、
 * 按当前建造索引重建。低频事件（楼板放置/拆除触发，每运行时每 tick 至多
 * 一次），非热路径。
 */
function rebuildMapBodies(
  world: GameWorld,
  runtime: CollisionRuntime,
  mapId: string,
  level: number,
  builtEpoch: number,
): void {
  const map = getCollisionMapSource(world, mapId);
  for (const body of runtime.mapBodies) {
    runtime.system.remove(body);
  }
  const built: BuiltStructuresIndex | undefined = map ? collectBuiltStructures(world, mapId) : undefined;
  runtime.mapBodies = map ? buildLevelMapBodies(runtime.system, map, level, built) : [];
  runtime.builtEpoch = builtEpoch;
}

/**
 * 立即构建并存储某图全部层的碰撞运行时（幂等：已存在则 no-op）。
 *
 * 供 movePlayerToMap 在激活新图时调用，保证新激活图当 tick 即有碰撞体
 * （无需等碰撞系统惰性创建）。按 distinctLevels 逐层构建——实体落到哪层，
 * 该层的静态体已就绪。若该图在 world.maps 中缺失，则得到一个仅含空运行时
 * 的层级表（level 0）；已在 world.activeMaps 中但尚无实体的空图，也借此
 * 具备「常驻空图」的可分离运行时。
 *
 * @param world ECS World
 * @param mapId 地图 id
 */
export function prewarmCollisionRuntime(world: GameWorld, mapId: string): void {
  const map = getCollisionMapSource(world, mapId);
  for (const level of map ? distinctLevels(map) : [0]) {
    ensureCollisionRuntime(world, mapId, level);
  }
}

/**
 * 同步当前帧某图某层的全部实体碰撞体，并移除已不存在的实体碰撞体。
 *
 * 仅处理 entityMapOf(eid) 等于该地图且 entityLevelOf(eid) 等于该层的实体
 * （跨图/跨层实体绝不进本运行时）。
 *
 * @param world ECS World
 * @param runtime 碰撞运行时
 * @param mapId 该运行时对应的地图 id
 * @param level 该运行时对应的层号
 */
function syncMapEntityBodies(
  world: GameWorld,
  runtime: CollisionRuntime,
  mapId: string,
  level: number,
): void {
  const alive = new Set<EntityId>();

  for (const eid of query(world, [Transform, Collider])) {
    if (entityMapOf(world, eid) !== mapId) continue;
    if (entityLevelOf(eid) !== level) continue;
    alive.add(eid);

    let body = runtime.entityBodies.get(eid);
    if (!body || !doesBodyMatchShape(body, eid, world)) {
      if (body) {
        runtime.system.remove(body);
      }
      body = createEntityBody(world, runtime.system, eid);
      runtime.entityBodies.set(eid, body);
    }

    syncEntityBody(world, eid, body);
  }

  for (const [eid, body] of runtime.entityBodies) {
    if (alive.has(eid)) continue;
    runtime.system.remove(body);
    runtime.entityBodies.delete(eid);
  }

  runtime.system.update();
}

/**
 * 记录当前帧的碰撞对信息。
 *
 * @param runtime 碰撞运行时
 * @param bodyA 碰撞体 A
 * @param bodyB 碰撞体 B
 * @param overlap 重叠深度
 */
function recordCollisionPair(
  runtime: CollisionRuntime,
  bodyA: CollisionBody,
  bodyB: CollisionBody,
  overlap: number,
): void {
  const a = getDebugBodyId(bodyA);
  const b = getDebugBodyId(bodyB);
  const [left, right] = a < b ? [a, b] : [b, a];
  runtime.pairs.push({
    id: `${left}|${right}`,
    a: left,
    b: right,
    overlap,
  });
}

/**
 * 把分离后的碰撞体中心点写回 ECS，并清理被阻挡方向上的速度分量。
 *
 * @param world ECS World
 * @param eid 实体 id
 * @param body 该实体的 check2d 碰撞体
 * @param prev 分离前的实体中心点
 */
function writeBodyBackToWorld(
  world: GameWorld,
  eid: EntityId,
  body: CollisionBody,
  prev: { x: number; y: number } | undefined,
): void {
  const next = getBodyCenter(body);

  Transform.x[eid] = next.x;
  Transform.y[eid] = next.y;

  if (!prev || !hasComponent(world, eid, Velocity)) {
    return;
  }

  const correctionX = next.x - prev.x;
  const correctionY = next.y - prev.y;

  if (Math.abs(correctionX) > POSITION_EPSILON) {
    Velocity.vx[eid] = 0;
  }
  if (Math.abs(correctionY) > POSITION_EPSILON) {
    Velocity.vy[eid] = 0;
  }
}

/**
 * 采集当前帧的调试碰撞体列表。
 *
 * @param runtime 碰撞运行时
 * @returns 可序列化碰撞体列表
 */
function collectDebugMapBodies(runtime: CollisionRuntime): CollisionDebugMapBody[] {
  const bodies: CollisionDebugMapBody[] = [];

  for (const body of runtime.mapBodies) {
    if (!isBoxBody(body)) continue;
    bodies.push({
      kind: "map",
      shape: "box",
      x: body.x,
      y: body.y,
      width: body.width,
      height: body.height,
    });
  }

  return bodies;
}

/**
 * 采集当前帧的实体调试碰撞体列表。
 *
 * @param runtime 碰撞运行时
 * @returns 可序列化实体碰撞体列表
 */
function collectDebugEntityBodies(runtime: CollisionRuntime): CollisionDebugEntityBody[] {
  const bodies: CollisionDebugEntityBody[] = [];

  for (const [eid, body] of runtime.entityBodies) {
    if (isCircleBody(body)) {
      bodies.push({
        kind: "entity",
        shape: "circle",
        eid,
        x: body.x,
        y: body.y,
        r: body.r,
      });
      continue;
    }

    if (!isBoxBody(body)) continue;
    bodies.push({
      kind: "entity",
      shape: "box",
      eid,
      x: body.x,
      y: body.y,
      width: body.width,
      height: body.height,
    });
  }

  return bodies;
}

/**
 * 执行一帧服务端碰撞处理。
 *
 * 说明：
 * - 每个实体按其 (所属地图, 层号) 在单遍遍历中同步进对应层的运行时（按需
 *   惰性创建）——每层一个碰撞世界，同层实体互撞、异层互不干扰
 * - 对全部触碰过的运行时 + 每个 activeMaps 图的每层运行时跑 system.separate
 *   （空层也跑，保证常驻语义）
 * - 每帧同步实体碰撞体到 check2d，执行分离，再把修正后坐标写回 ECS
 * - 若分离导致实体在某个轴上被修正，则把该轴速度清零，避免持续顶墙抖动
 *
 * @param world ECS World
 * @returns 处理后的 World
 */
export function collisionSystem(world: GameWorld): GameWorld {
  const runtimeMap = getCollisionRuntimeMap(world);
  const previousCenters = new Map<EntityId, { x: number; y: number }>();
  const runtimeOfEntity = new Map<EntityId, CollisionRuntime>();

  // 单遍分区：把每个实体按 (所属地图, 层号) 同步进对应层运行时（同步 body 前先记录分离前中心点）。
  for (const eid of query(world, [Transform, Collider])) {
    const mapId = entityMapOf(world, eid);
    const level = entityLevelOf(eid);
    const runtime = ensureCollisionRuntime(world, mapId, level);

    let body = runtime.entityBodies.get(eid);
    if (!body || !doesBodyMatchShape(body, eid, world)) {
      if (body) {
        runtime.system.remove(body);
      }
      body = createEntityBody(world, runtime.system, eid);
      runtime.entityBodies.set(eid, body);
    }
    syncEntityBody(world, eid, body);

    previousCenters.set(eid, { x: Transform.x[eid], y: Transform.y[eid] });
    runtimeOfEntity.set(eid, runtime);
  }

  // 清理：每个运行时丢弃「本 tick 已不归属该运行时」的实体（销毁/跨图/跨层
  // 移动经此消除——实体层号变化即换运行时，旧运行时的 body 由归属比对清除，
  // 不依赖 EntityMap 残留）。
  for (const byLevel of runtimeMap.values()) {
    for (const runtime of byLevel.values()) {
      for (const [eid, body] of runtime.entityBodies) {
        if (runtimeOfEntity.get(eid) === runtime) continue;
        runtime.system.remove(body);
        runtime.entityBodies.delete(eid);
      }
    }
  }

  // 分离目标：全部已存在运行时 + 每个 activeMaps 图的全部层（空层也跑——常驻语义）。
  const targets = new Map<string, Set<number>>();
  for (const [mapId, byLevel] of runtimeMap) {
    targets.set(mapId, new Set(byLevel.keys()));
  }
  for (const mapId of world.activeMaps) {
    if (mapId === "") continue; // 无图哨兵不属于激活集（防御分支，类型收窄）
    const map = getCollisionMapSource(world, mapId);
    if (!map) continue;
    let levels = targets.get(mapId);
    if (!levels) {
      levels = new Set<number>();
      targets.set(mapId, levels);
    }
    for (const level of distinctLevels(map)) {
      levels.add(level);
    }
  }

  for (const [mapId, levels] of targets) {
    for (const level of levels) {
      const runtime = ensureCollisionRuntime(world, mapId, level);
      runtime.pairs = [];
      runtime.system.update();
      runtime.system.separate((response: Response) => {
        recordCollisionPair(runtime, response.a as CollisionBody, response.b as CollisionBody, response.overlap);
        // check2d 的 separateBody 仅在回调返回 truthy 时才累加分离偏移并推开 body。
        // 早期回调未返回值（undefined）导致分离永远不生效，实体穿墙。必须返回 true。
        return true;
      });
    }
  }

  // 逐实体回写：每个实体的修正坐标写回各自 Transform（其所属运行时已分离，
  // 跨图/跨层实体绝不共享运行时）。
  for (const [eid, runtime] of runtimeOfEntity) {
    const body = runtime.entityBodies.get(eid);
    if (body) {
      writeBodyBackToWorld(world, eid, body, previousCenters.get(eid));
    }
  }

  return world;
}

/**
 * 获取当前帧的碰撞调试快照。
 *
 * 说明：
 * - 按指定地图与层号（缺省 world.defaultMapId / 0 层）返回该层的静态碰撞体、
 *   实体动态碰撞体，以及该运行时最近一帧记录到的碰撞对
 * - 若实体碰撞体尚未同步，会在读取前先做一次该层的同步
 * - mapId 为空串或无对应运行时，返回空 bodies（todo 14 按图消费）
 *
 * @param world ECS World
 * @param options 调试选项（是否包含地图碰撞体、指定地图 id 与层号）
 * @returns 当前帧的碰撞调试快照
 */
export function getCollisionDebugSnapshot(
  world: GameWorld,
  options?: { includeMapBodies?: boolean; mapId?: string; level?: number },
): CollisionDebugSnapshot {
  const mapId = options?.mapId ?? world.defaultMapId;
  const level = options?.level ?? 0;

  if (mapId === "") {
    return { tick: world.time.tick, mapBodies: [], entityBodies: [], pairs: [] };
  }

  const runtime = getCollisionRuntimeMap(world).get(mapId)?.get(level);
  if (!runtime) {
    return { tick: world.time.tick, mapBodies: [], entityBodies: [], pairs: [] };
  }

  syncMapEntityBodies(world, runtime, mapId, level);

  return {
    tick: world.time.tick,
    mapBodies: options?.includeMapBodies === false ? undefined : collectDebugMapBodies(runtime),
    entityBodies: collectDebugEntityBodies(runtime),
    pairs: runtime.pairs,
  };
}
