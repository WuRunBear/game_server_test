/**
 * /debug/colliders 分图调试端点测试（per-player-maps 计划 todo 14）。
 *
 * 覆盖：
 * - a) GameRoom.getCollisionDebugSnapshot({mapId})：把 mapId 原样透传给仿真层
 *   （fake sim spy 捕获参数；GameRoom 是纯传输胶水，不关心快照结构）。
 * - b) GameSimulation.getDebugSnapshot：?mapId 指定图 → 仅该图的 mapBodies +
 *   实体 bodies；缺省 mapId → 默认图（a）的 bodies。两图各放一个带碰撞体的
 *   实体，断言互斥（T6 运行时按 EntityMap 分区）。
 * - c) 未知 / 空 mapId → 空 bodies（不抛错；T6 缺省语义：无运行时即空）。
 * - d) HTTP 端点集成（真实 startColyseusServer + fetch，镜像 maps-http.test.ts）：
 *   缺省 → 200 默认图 bodies；?mapId=cave → 200 且响应与默认图不同（证明
 *   mapId 被透传——修复前该参数被忽略，cave 返回默认图 bodies）；?mapId=unknown
 *   → 200 空 bodies（不 404，匹配现有 /debug/colliders 响应形状）。
 *
 * 服务器启动方式：vi.hoisted 先于全部静态导入把 PORT 置 0（config/server.ts 的
 * serverConfig 在模块导入时固化），因此绑定临时端口；SAVE_DIR 指向临时空目录，
 * 常驻房间读档为空 ⇒ 世界从零启动（仅默认图激活，cave 无运行时——这正是
 * 「cave 响应异于默认图」的判定前提）。
 */
import { makeTestGeometry } from "./helpers/mapGeometry";
import type { MapGeometry } from "map/geometry/types";
import http from "node:http";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import {
  bootstrapFramework,
  createGameSimulation,
  createDefaultGameDefinition,
  spawnEntity,
  getRegistries,
} from "framework/index";
import { EntityMap } from "framework/components/entityMap";
import { prewarmCollisionRuntime } from "framework/systems/core/collisionSystem";
import type { CollisionDebugSnapshot } from "framework/systems/core/collisionSystem";
import type { GameWorld } from "framework/world";
import type { ColyseusServer } from "framework/net/colyseus/server";
import type { SimulationPort } from "simulation";
import { GameRoom } from "network/colyseus/rooms/GameRoom";
import type { Logger } from "utils/logger";

// 必须在任何 config 模块求值之前生效（serverConfig 于导入时固化端口）。
vi.hoisted(() => {
  process.env.PORT = "0";
  // 常驻房间 onCreate 运行时读取 SAVE_DIR：指向空目录 ⇒ 无存档读入
  // （data/saves/main.json 是开发残留，不能成为测试的隐含输入）。
  process.env.SAVE_DIR = "/tmp/per-player-maps-debugcolliders-save";
});

/** 静默日志器：测试不落日志文件（winston 惰性初始化同样被绕过）。 */
const stubLogger: Logger = {
  info: () => {},
  warn: () => {},
  error: () => {},
};

beforeAll(() => {
  // 全局引导一次：注册表是幂等单例，所有用例共享同一套内置实现
  bootstrapFramework();
});

/** 取仿真内部的 GameWorld（镜像 slice5 simWorld 私有访问器）。 */
function simWorld(sim: SimulationPort): GameWorld {
  return (sim as unknown as { world: GameWorld }).world;
}

/** 清空 EntityMap 模块级单例残留（AoS 数组跨 world 复用 eid，防跨用例串扰）。 */
function clearEntityMap(): void {
  for (let i = 0; i < EntityMap.length; i++) EntityMap[i] = undefined;
}

/** 清空存活实体的 EntityMap（用例结束时调用，防跨用例/跨世界残留）。 */
function cleanEntityMapOf(alive: number[]): void {
  for (const eid of alive) EntityMap[eid] = undefined;
}

/** 手工构建一张确定性地图几何（8×8 tile，tile 16px；显式声明墙格）。 */
function buildMap(id: string, wallTiles: Array<{ x: number; y: number }>): MapGeometry {
  return makeTestGeometry({
    key: id,
    width: 8,
    height: 8,
    blocked: (tx, ty) => wallTiles.some((t) => t.x === tx && t.y === ty),
  });
}

/**
 * 两图 a（默认）/b 的仿真：a 墙 tile(2,4) → 地图体 (32,64,16,16)；
 * b 墙 tile(5,4) → 地图体 (80,64,16,16)；两图各放一个 player 实体
 * （spawnEntity overrides.mapId，todo 4 已把归属写入 EntityMap）。
 */
async function twoMapSim(): Promise<{ sim: SimulationPort; world: GameWorld; pa: number; pb: number }> {
  const sim = await createGameSimulation(createDefaultGameDefinition());
  const world = simWorld(sim);
  world.defaultMapId = "a";
  world.maps = {
    a: buildMap("a", [{ x: 2, y: 4 }]),
    b: buildMap("b", [{ x: 5, y: 4 }]),
  };
  world.activeMaps = new Set(["a", "b"]);
  // 预暖两图碰撞运行时（键："collision" → Map<mapId, CollisionRuntime>）。
  prewarmCollisionRuntime(world, "a");
  prewarmCollisionRuntime(world, "b");

  const pa = spawnEntity(world, world.archetypes.get("player"), getRegistries().componentRegistry, {
    x: 100,
    y: 100,
    mapId: "a",
  });
  const pb = spawnEntity(world, world.archetypes.get("player"), getRegistries().componentRegistry, {
    x: 200,
    y: 100,
    mapId: "b",
  });
  return { sim, world, pa, pb };
}

describe("debug colliders", () => {
  describe("GameRoom.getCollisionDebugSnapshot → sim 透传", () => {
    it("a) mapId / includeMapBodies 原样传给仿真层（fake sim spy）", () => {
      const room = new GameRoom();
      const getDebugSnapshot = vi.fn(() => ({
        tick: 0,
        mapBodies: [],
        entityBodies: [],
        pairs: [],
      }));
      (room as unknown as { sim: SimulationPort }).sim = {
        getDebugSnapshot,
      } as unknown as SimulationPort;

      room.getCollisionDebugSnapshot({ mapId: "cave" });
      expect(getDebugSnapshot).toHaveBeenLastCalledWith({ mapId: "cave" });

      room.getCollisionDebugSnapshot({ includeMapBodies: false, mapId: "b" });
      expect(getDebugSnapshot).toHaveBeenLastCalledWith({ includeMapBodies: false, mapId: "b" });

      // 无参调用：透传 undefined（缺省 = 默认图）
      room.getCollisionDebugSnapshot();
      expect(getDebugSnapshot).toHaveBeenLastCalledWith(undefined);
    });
  });

  describe("GameSimulation.getDebugSnapshot 分图", () => {
    it("b) 指定图 → 仅该图 bodies（mapBodies 坐标 + 实体互斥）", async () => {
      clearEntityMap();
      const { sim, pa, pb } = await twoMapSim();

      const bSnap = sim.getDebugSnapshot({ mapId: "b" }) as CollisionDebugSnapshot;
      expect(bSnap.mapBodies).toEqual([
        { kind: "map", shape: "box", x: 80, y: 64, width: 16, height: 16 },
      ]);
      const bEids = bSnap.entityBodies.map((b) => b.eid);
      expect(bEids).toContain(pb);
      expect(bEids).not.toContain(pa);

      cleanEntityMapOf([pa, pb]);
    });

    it("b) 缺省 mapId → 默认图（a）bodies，且不含 b 图实体", async () => {
      clearEntityMap();
      const { sim, pa, pb } = await twoMapSim();

      const defSnap = sim.getDebugSnapshot() as CollisionDebugSnapshot;
      expect(defSnap.mapBodies).toEqual([
        { kind: "map", shape: "box", x: 32, y: 64, width: 16, height: 16 },
      ]);
      const defEids = defSnap.entityBodies.map((b) => b.eid);
      expect(defEids).toContain(pa);
      expect(defEids).not.toContain(pb);

      cleanEntityMapOf([pa, pb]);
    });

    it("c) 未知 / 空 mapId → 空 bodies（不抛错）", async () => {
      clearEntityMap();
      const { sim, pa, pb } = await twoMapSim();

      const snap = sim.getDebugSnapshot({ mapId: "does-not-exist" }) as CollisionDebugSnapshot;
      expect(snap).toEqual({ tick: 0, mapBodies: [], entityBodies: [], pairs: [] });

      const empty = sim.getDebugSnapshot({ mapId: "" }) as CollisionDebugSnapshot;
      expect(empty.mapBodies).toEqual([]);
      expect(empty.entityBodies).toEqual([]);
      expect(empty.pairs).toEqual([]);

      cleanEntityMapOf([pa, pb]);
    });
  });

  describe("HTTP 端点 /debug/colliders（startColyseusServer 集成）", () => {
    let colyseus: ColyseusServer | undefined;
    let baseUrl = "";

    /** 等待 http.Server 进入监听状态（启动已在 startColyseusServer 内异步发起）。 */
    function waitForListen(server: http.Server): Promise<void> {
      if (server.listening) return Promise.resolve();
      return new Promise((resolve, reject) => {
        const onListening = () => {
          server.off("error", onError);
          resolve();
        };
        const onError = (err: Error) => {
          server.off("listening", onListening);
          reject(err);
        };
        server.once("listening", onListening);
        server.once("error", onError);
      });
    }

    /**
     * 等常驻房间就绪且默认图碰撞运行时已建立：
     * 房间创建是 listen 之后的异步步骤（persistentRoomId 未定前路由 404）；
     * 碰撞运行时由首帧 tick 惰性创建（默认图上必有初始实体 ⇒ mapBodies 非空）。
     */
    async function waitForRoom(): Promise<void> {
      for (let i = 0; i < 150; i += 1) {
        const res = await fetch(`${baseUrl}/debug/colliders`);
        if (res.status === 200) {
          const body = (await res.json()) as CollisionDebugSnapshot;
          if (body.mapBodies && body.mapBodies.length > 0) return;
        }
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
      throw new Error("常驻房间未就绪或默认图碰撞体未生成");
    }

    beforeAll(async () => {
      // PORT=0 已在文件顶部（vi.hoisted）生效——此处断言防静默回退到 3000 端口冲突
      const { serverConfig } = await import("config");
      expect(serverConfig.port).toBe(0);

      // 动态导入 server 模块：serverConfig 的固化发生在导入求值时，必须在 PORT 就位之后
      const serverModule = await import("framework/net/colyseus/server");
      colyseus = serverModule.startColyseusServer({ logger: stubLogger });
      await waitForListen(colyseus.httpServer);

      const addr = colyseus.httpServer.address();
      if (!addr || typeof addr === "string") {
        throw new Error("测试服务器未监听任何端口");
      }
      baseUrl = `http://127.0.0.1:${addr.port}`;
      await waitForRoom();
    });

    afterAll(async () => {
      const server = colyseus;
      if (!server) return;

      await Promise.race([
        server.stop().catch(() => {}),
        new Promise((resolve) => setTimeout(resolve, 5000)),
      ]);
      if (server.httpServer.listening) {
        await new Promise<void>((resolve) => server.httpServer.close(() => resolve()));
      }
    });

    it("缺省 mapId → 200，返回默认图（generated-map）bodies（形状含 tick/mapBodies/entityBodies/pairs）", async () => {
      const res = await fetch(`${baseUrl}/debug/colliders`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as CollisionDebugSnapshot;
      expect(typeof body.tick).toBe("number");
      expect(body.mapBodies!.length).toBeGreaterThan(0);
      expect(Array.isArray(body.entityBodies)).toBe(true);
      expect(Array.isArray(body.pairs)).toBe(true);
    });

    it("?mapId=cave → 200 且响应与默认图不同（mapId 已透传；cave 未激活 ⇒ 空 bodies）", async () => {
      const res = await fetch(`${baseUrl}/debug/colliders?mapId=cave`);
      expect(res.status).toBe(200);
      const cave = (await res.json()) as CollisionDebugSnapshot;
      const def = (await (await fetch(`${baseUrl}/debug/colliders`)).json()) as CollisionDebugSnapshot;
      expect(cave.mapBodies).not.toEqual(def.mapBodies);
    });

    it("?mapId=does-not-exist → 200 空 bodies（不 404，匹配现有响应形状）", async () => {
      const res = await fetch(`${baseUrl}/debug/colliders?mapId=does-not-exist`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as CollisionDebugSnapshot;
      expect(body.mapBodies).toEqual([]);
      expect(body.entityBodies).toEqual([]);
      expect(body.pairs).toEqual([]);
    });
  });
});
