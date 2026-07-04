import { createRequire } from "node:module";
import { hasComponent, query } from "bitecs";
import type { Body, Box, Circle, Response, System as Check2dSystem } from "check2d";

const require = createRequire(import.meta.url);
const check2d = require("check2d") as typeof import("check2d");

import { Collider, ColliderShape, Transform, Velocity } from "components";
import type { EntityId, GameWorld } from "world";

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

type CollisionBody = Body<CollisionBodyUserData>;

type CollisionRuntime = {
  system: Check2dSystem<CollisionBody>;
  mapBodies: CollisionBody[];
  entityBodies: Map<EntityId, CollisionBody>;
  pairs: CollisionDebugPair[];
};

const COLLISION_KEY = "collision";

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
 * 为实体创建动态碰撞体。
 *
 * @param world ECS World
 * @param system check2d 系统
 * @param eid 实体 id
 * @returns 创建后的动态碰撞体
 */
function createEntityBody(
  world: GameWorld,
  system: Check2dSystem<CollisionBody>,
  eid: EntityId,
): CollisionBody {
  if (Collider.shape[eid] === ColliderShape.Circle) {
    return system.createCircle(
      { x: Transform.x[eid], y: Transform.y[eid] },
      Collider.radius[eid],
      {
        userData: {
          kind: "entity",
          eid,
          id: `entity:${eid}`,
        },
      },
    ) as CollisionBody;
  }

  return system.createBox(
    {
      x: Transform.x[eid] - Collider.halfW[eid],
      y: Transform.y[eid] - Collider.halfH[eid],
    },
    Collider.halfW[eid] * 2,
    Collider.halfH[eid] * 2,
    {
      userData: {
        kind: "entity",
        eid,
        id: `entity:${eid}`,
      },
    },
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
 * 懒初始化碰撞运行时，并把地图阻挡格注册为静态碰撞体。
 *
 * @param world ECS World
 * @returns 可复用的碰撞运行时
 */
function ensureCollisionRuntime(world: GameWorld): CollisionRuntime {
  const existing = world.systemRuntimes.get(COLLISION_KEY) as CollisionRuntime | undefined;
  if (existing) return existing;

  const system = new check2d.System<CollisionBody>();
  const mapBodies: CollisionBody[] = [];

  if (world.map) {
    const { width, height, tileWidth, tileHeight } = world.map.grid;
    for (let tileY = 0; tileY < height; tileY += 1) {
      for (let tileX = 0; tileX < width; tileX += 1) {
        const idx = tileY * width + tileX;
        if (world.map.blocked[idx] !== 1) continue;
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

  world.systemRuntimes.set(COLLISION_KEY, runtime);
  return runtime;
}

/**
 * 同步当前帧全部实体碰撞体，并移除已不存在的实体碰撞体。
 *
 * @param world ECS World
 * @param runtime 碰撞运行时
 */
function syncEntityBodies(world: GameWorld, runtime: CollisionRuntime): void {
  const alive = new Set<EntityId>();

  for (const eid of query(world, [Transform, Collider])) {
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
 * - 首次运行时会把地图阻挡格注册为静态碰撞体
 * - 每帧同步实体碰撞体到 check2d，执行分离，再把修正后坐标写回 ECS
 * - 若分离导致实体在某个轴上被修正，则把该轴速度清零，避免持续顶墙抖动
 *
 * @param world ECS World
 * @returns 处理后的 World
 */
export function collisionSystem(world: GameWorld): GameWorld {
  const runtime = ensureCollisionRuntime(world);
  const previousCenters = new Map<EntityId, { x: number; y: number }>();

  for (const eid of query(world, [Transform, Collider])) {
    previousCenters.set(eid, {
      x: Transform.x[eid],
      y: Transform.y[eid],
    });
  }

  syncEntityBodies(world, runtime);

  runtime.pairs = [];
  runtime.system.separate((response: Response) => {
    recordCollisionPair(runtime, response.a as CollisionBody, response.b as CollisionBody, response.overlap);
  });

  writeBodiesBackToWorld(world, runtime, previousCenters);
  return world;
}

/**
 * 获取当前帧的碰撞调试快照。
 *
 * 说明：
 * - 返回地图静态碰撞体、实体动态碰撞体，以及最近一帧记录到的碰撞对
 * - 若实体碰撞体尚未同步，会在读取前先做一次同步
 *
 * @param world ECS World
 * @returns 当前帧的碰撞调试快照
 */
export function getCollisionDebugSnapshot(
  world: GameWorld,
  options?: { includeMapBodies?: boolean },
): CollisionDebugSnapshot {
  const runtime = ensureCollisionRuntime(world);

  syncEntityBodies(world, runtime);

  return {
    tick: world.time.tick,
    mapBodies: options?.includeMapBodies === false ? undefined : collectDebugMapBodies(runtime),
    entityBodies: collectDebugEntityBodies(runtime),
    pairs: runtime.pairs,
  };
}
