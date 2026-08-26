import { createRequire } from "node:module";
import { hasComponent, query } from "bitecs";
import type { Body, Box, Circle, Response, System as Check2dSystem } from "check2d";

const require = createRequire(import.meta.url);
const check2d = require("check2d") as typeof import("check2d");

import { Collider, ColliderShape, Transform, Velocity } from "components";
import { entityMapOf } from "framework/components/entityMap";
import type { MapRuntime } from "framework/map/types";
import type { EntityId, GameWorld } from "world";

/**
 * 碰撞系统：基于 check2d（SAT 分离）做服务端碰撞。
 *
 * 运行位置：每 tick 在 physicsSystem / movementSystem 之后执行——
 * 先由 movementSystem 把速度积分到位移，本系统再纠正越界/重叠的位置。
 * 职责：
 * - 把地图阻挡格与实体（Transform + Collider）同步成 check2d 碰撞体
 * - 执行分离，把重叠实体推开，并把修正后的坐标写回 ECS
 * - 若某轴被修正（顶到障碍），清零该轴速度，避免持续顶墙抖动
 * 按地图分区的运行时缓存在 world.systemRuntimes["collision"]（Map<mapId, CollisionRuntime>）
 * 中（懒初始化，跨 tick 复用）。实体按其所属地图（entityMapOf）同步进对应图运行时，
 * 跨图实体绝不进同一运行时，从而保证同一坐标、不同地图的实体互不碰撞。
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
};

/** world.systemRuntimes 中碰撞运行时表的缓存键（值为 Map<mapId, CollisionRuntime>）。 */
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
 * 为阻挡格创建静态矩形碰撞体。
 *
 * @param system check2d 系统
 * @param tileX 格子 x
 * @param tileY 格子 y
 * @param tileWidth 格子宽
 * @param tileHeight 格子高
 * @returns 创建后的静态碰撞体
 */
function createMapBody(
  system: Check2dSystem<CollisionBody>,
  tileX: number,
  tileY: number,
  tileWidth: number,
  tileHeight: number,
): CollisionBody {
  return system.createBox(
    { x: tileX * tileWidth, y: tileY * tileHeight },
    tileWidth,
    tileHeight,
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
 * @returns 按 mapId 索引的碰撞运行时表
 */
function getCollisionRuntimeMap(world: GameWorld): Map<string, CollisionRuntime> {
  let runtimes = world.systemRuntimes.get(COLLISION_KEY) as Map<string, CollisionRuntime> | undefined;
  if (!runtimes) {
    runtimes = new Map<string, CollisionRuntime>();
    world.systemRuntimes.set(COLLISION_KEY, runtimes);
  }
  return runtimes;
}

/**
 * 取某地图的 MapRuntime（地图阻挡格来源）。
 * 优先用 world.maps[mapId]；地图 id 未落到任何已缓存图（无 map 配置路径的 world.map
 * 手工赋值，或 EntityMap 残留导致 mapId 无法解析）时回退世界默认图别名 world.map，
 * 使碰撞几何始终取自一块真实地图（默认图），保持既有碰撞回归用例行为。
 */
function getCollisionMapSource(world: GameWorld, mapId: string): MapRuntime | undefined {
  const cached = world.maps[mapId];
  if (cached) return cached;
  return world.map ?? undefined;
}

/**
 * 懒初始化某地图的碰撞运行时，并把该图阻挡格注册为静态碰撞体。
 *
 * @param world ECS World
 * @param mapId 地图 id
 * @returns 可复用的碰撞运行时
 */
function ensureCollisionRuntime(world: GameWorld, mapId: string): CollisionRuntime {
  const runtimeMap = getCollisionRuntimeMap(world);
  const existing = runtimeMap.get(mapId);
  if (existing) return existing;

  const system = new check2d.System<CollisionBody>();
  const mapBodies: CollisionBody[] = [];

  const map = getCollisionMapSource(world, mapId);
  if (map) {
    const { width, height, tileWidth, tileHeight } = map.grid;
    for (let tileY = 0; tileY < height; tileY += 1) {
      for (let tileX = 0; tileX < width; tileX += 1) {
        const idx = tileY * width + tileX;
        if (map.blocked[idx] !== 1) continue;
        mapBodies.push(createMapBody(system, tileX, tileY, tileWidth, tileHeight));
      }
    }
  }

  const runtime: CollisionRuntime = {
    system,
    mapBodies,
    entityBodies: new Map<EntityId, CollisionBody>(),
    pairs: [],
  };

  runtimeMap.set(mapId, runtime);
  return runtime;
}

/**
 * 立即构建并存储某地图的碰撞运行时（幂等：已存在则 no-op）。
 *
 * 供 movePlayerToMap 在激活新图时调用，保证新激活图当 tick 即有碰撞体
 * （无需等碰撞系统惰性创建）。若该图在 world.maps 中缺失，则得到一个仅含
 * 阻挡格（或无阻挡格）的运行时；已在 world.activeMaps 中但尚无实体的空图，
 * 也借此具备「常驻空图」的可分离运行时。
 *
 * @param world ECS World
 * @param mapId 地图 id
 */
export function prewarmCollisionRuntime(world: GameWorld, mapId: string): void {
  ensureCollisionRuntime(world, mapId);
}

/**
 * 同步当前帧某地图的全部实体碰撞体，并移除已不存在的实体碰撞体。
 *
 * 仅处理 entityMapOf(eid) 等于该地图的实体（跨图实体绝不进本运行时）。
 *
 * @param world ECS World
 * @param runtime 碰撞运行时
 * @param mapId 该运行时对应的地图 id
 */
function syncMapEntityBodies(world: GameWorld, runtime: CollisionRuntime, mapId: string): void {
  const alive = new Set<EntityId>();

  for (const eid of query(world, [Transform, Collider])) {
    if (entityMapOf(world, eid) !== mapId) continue;
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
 * @param runtime 碰撞运行时
 * @param previousCenters 分离前的实体中心点
 */
function writeBodiesBackToWorld(
  world: GameWorld,
  runtime: CollisionRuntime,
  previousCenters: Map<EntityId, { x: number; y: number }>,
): void {
  for (const [eid, body] of runtime.entityBodies) {
    const next = getBodyCenter(body);
    const prev = previousCenters.get(eid);

    Transform.x[eid] = next.x;
    Transform.y[eid] = next.y;

    if (!prev || !hasComponent(world, eid, Velocity)) {
      continue;
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
 * - 每个实体按其所属地图（entityMapOf）在单遍遍历中同步进对应图运行时（按需惰性创建）
 * - 对每个 activeMaps 图的运行时跑 system.separate（空图也跑，保证常驻语义）；被本帧
 *   实体触碰过的运行时（即使其图非 active）也会跑
 * - 每帧同步实体碰撞体到 check2d，执行分离，再把修正后坐标写回 ECS
 * - 若分离导致实体在某个轴上被修正，则把该轴速度清零，避免持续顶墙抖动
 *
 * @param world ECS World
 * @returns 处理后的 World
 */
export function collisionSystem(world: GameWorld): GameWorld {
  const runtimeMap = getCollisionRuntimeMap(world);
  const previousCenters = new Map<EntityId, { x: number; y: number }>();
  const seenByMap = new Map<string, Set<EntityId>>();

  // 单遍分区：把每个实体按所属地图同步进该图运行时（同步 body 前先记录分离前中心点）。
  for (const eid of query(world, [Transform, Collider])) {
    const mapId = entityMapOf(world, eid);
    const runtime = ensureCollisionRuntime(world, mapId);

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

    let seen = seenByMap.get(mapId);
    if (!seen) {
      seen = new Set<EntityId>();
      seenByMap.set(mapId, seen);
    }
    seen.add(eid);
  }

  // 清理：每个运行时丢弃本 tick 未在该图出现的实体（销毁/跨图移动经此消除，不依赖 EntityMap 残留）。
  for (const [mapId, runtime] of runtimeMap) {
    const seen = seenByMap.get(mapId);
    for (const [eid, body] of runtime.entityBodies) {
      if (seen?.has(eid)) continue;
      runtime.system.remove(body);
      runtime.entityBodies.delete(eid);
    }
  }

  // 对全部触碰过的运行时 + 每个 activeMaps 图的运行时跑分离（空图也跑——常驻语义）。
  const mapIdsToSeparate = new Set<string>(runtimeMap.keys());
  for (const mapId of world.activeMaps) {
    mapIdsToSeparate.add(mapId);
  }
  for (const mapId of mapIdsToSeparate) {
    const runtime = ensureCollisionRuntime(world, mapId);
    runtime.pairs = [];
    runtime.system.update();
    runtime.system.separate((response: Response) => {
      recordCollisionPair(runtime, response.a as CollisionBody, response.b as CollisionBody, response.overlap);
      // check2d 的 separateBody 仅在回调返回 truthy 时才累加分离偏移并推开 body。
      // 早期回调未返回值（undefined）导致分离永远不生效，实体穿墙。必须返回 true。
      return true;
    });
  }

  // 逐运行时回写：每个地图的实体写回各自 Transform（跨图实体绝不进同一运行时）。
  for (const mapId of mapIdsToSeparate) {
    const runtime = runtimeMap.get(mapId);
    if (runtime) {
      writeBodiesBackToWorld(world, runtime, previousCenters);
    }
  }

  return world;
}

/**
 * 获取当前帧的碰撞调试快照。
 *
 * 说明：
 * - 按指定地图（缺省 world.defaultMapId）返回该图静态碰撞体、实体动态碰撞体，
 *   以及该运行时最近一帧记录到的碰撞对
 * - 若实体碰撞体尚未同步，会在读取前先做一次该图的同步
 * - mapId 为空串或无对应运行时，返回空 bodies（todo 14 按图消费）
 *
 * @param world ECS World
 * @param options 调试选项（是否包含地图碰撞体、指定地图 id）
 * @returns 当前帧的碰撞调试快照
 */
export function getCollisionDebugSnapshot(
  world: GameWorld,
  options?: { includeMapBodies?: boolean; mapId?: string },
): CollisionDebugSnapshot {
  const mapId = options?.mapId ?? world.defaultMapId;

  if (mapId === "") {
    return { tick: world.time.tick, mapBodies: [], entityBodies: [], pairs: [] };
  }

  const runtime = getCollisionRuntimeMap(world).get(mapId);
  if (!runtime) {
    return { tick: world.time.tick, mapBodies: [], entityBodies: [], pairs: [] };
  }

  syncMapEntityBodies(world, runtime, mapId);

  return {
    tick: world.time.tick,
    mapBodies: options?.includeMapBodies === false ? undefined : collectDebugMapBodies(runtime),
    entityBodies: collectDebugEntityBodies(runtime),
    pairs: runtime.pairs,
  };
}
