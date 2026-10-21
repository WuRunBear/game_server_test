/**
 * Colyseus 服务端装配：创建 WebSocket 传输层、注册单房间类型
 * （game）、启动一个常驻房间，并挂载少量调试 HTTP 端点
 * （/health、/content、/maps/runtime、/maps/meta、/debug/colliders）。游戏逻辑全部在
 * 仿真层，本文件只负责把 Colyseus 接到 GameRoom 上。
 */
import http from "node:http";

import { Server, matchMaker } from "@colyseus/core";
import { WebSocketTransport } from "@colyseus/ws-transport";

import { getRegistries } from "framework/bootstrap";
import { loadGameDefinition } from "framework/bootstrap/loadGameDefinition";
import type { MapConfig } from "framework/config/schema/MapRegistrySchema";
import { serverConfig } from "config";
import { buildMapGeometry } from "map/generate/pipeline";
import { serializeGeometry, type SerializedMapGeometry } from "map/geometry/snapshot";
import { describeGeometry, type GeometryMetaInfo } from "map/geometry/version";
import type { MapGeometry } from "map/geometry/types";
import { buildContentCatalog } from "framework/content/catalog";
import { GameRoom } from "network/colyseus/rooms/GameRoom";
import type { Logger } from "utils/logger";

/**
 * Colyseus 服务对象的最小封装。
 *
 * 约定：
 * - httpServer 负责端口监听（由 WebSocketTransport 持有与管理）
 * - gameServer 负责 Colyseus 的房间管理与 WebSocket 通讯
 */
export interface ColyseusServer {
  httpServer: http.Server;
  gameServer: Server;
  stop(): Promise<void>;
}

/**
 * 启动 Colyseus 服务的参数。
 */
export interface StartColyseusServerOptions {
  logger: Logger;
  gameJsonPath?: string;
}

/**
 * 启动 Colyseus 单房间服务器，并注册 game 房间类型。
 *
 * 说明：
 * - 对外只暴露一个房间类型：game（单房间模式由客户端 joinOrCreate("game") 使用）
 * - 仍保留 /health 便于容器/进程健康检查
 * - 使用 WebSocketTransport 内置的 Express 挂载 /matchmake 路由（用于 joinOrCreate 等匹配请求）
 * - 对 /matchmake 等 HTTP 请求开启 CORS，避免本地开发跨域被浏览器拦截
 *
 * @param options 启动参数（主要是日志器）
 * @returns 启动后的服务器对象，可用于停止服务
 */
export function startColyseusServer(options: StartColyseusServerOptions): ColyseusServer {
  const transport = new WebSocketTransport();

  // /maps/* 端点数据源：加载期游戏定义（resolvedMapConfigs）按固定 seed
  // 确定性重建几何，与仿真 world.maps 同源同内容（bootMaps 用同一配置与
  // 同一积木注册表构建）。几何不可变，按 key 惰性构建并缓存快照。
  // 已知局限：seed 缺省的图在仿真侧走「快照固化/开机随机」解析（弱表挂
  // GameWorld，本端点拿不到该 world），此处回退 0——registry 声明固定 seed
  // 的图两端同源，缺省 seed 的图 HTTP 视图可能与存档世界分歧（调试视图，
  // 不影响仿真权威状态）。
  const gameDef = loadGameDefinition({ gameJsonPath: options.gameJsonPath });
  const geometryCache = new Map<string, MapGeometry>();
  const mapIds = gameDef.resolvedMapConfigs.map((config) => config.key);
  const defaultMapId = gameDef.map?.default ?? mapIds[0] ?? "";
  const geometryOf = (config: MapConfig): MapGeometry => {
    const cached = geometryCache.get(config.key);
    if (cached) return cached;
    const geometry = buildMapGeometry(
      { key: config.key, seed: config.seed ?? 0, pipeline: config.pipeline },
      getRegistries().mapGeneratorRegistry,
    );
    geometryCache.set(config.key, geometry);
    return geometry;
  };

  let persistentRoomId: string | undefined;

  /**
   * 常驻房间就绪信号。
   *
   * 地图端点需要区分「房间已就绪 → 读 live 几何」与「无房间 → 按配置重建」，
   * 故端点先 await 本信号（带超时兜底），避免启动初期读到不一致的视图。
   */
  let markRoomReady: () => void = () => {};
  const roomReady = new Promise<void>((resolve) => {
    markRoomReady = resolve;
  });

  /** 等待常驻房间就绪（带超时；超时后按「无房间」处理）。 */
  const waitForRoom = async (timeoutMs = 5000): Promise<void> => {
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([
      roomReady,
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, timeoutMs);
        timer.unref?.();
      }),
    ]);
    if (timer) clearTimeout(timer);
  };

  /**
   * 取常驻房间内某图的**实时几何**快照（房间未就绪/图不存在 → undefined）。
   *
   * 实时几何含运行期写回（野火焦土等）的结果，version 指纹随之变化——
   * 这正是「按配置重建」视图看不到的部分。
   */
  const liveGeometryOf = async (mapId: string): Promise<SerializedMapGeometry | undefined> => {
    if (!persistentRoomId) return undefined;
    try {
      const result = await matchMaker.remoteRoomCall<GameRoom>(
        persistentRoomId,
        "getLiveMapGeometry",
        [mapId],
      );
      return (result as SerializedMapGeometry | null | undefined) ?? undefined;
    } catch {
      return undefined;
    }
  };

  /** 取常驻房间内全部地图的实时元信息（房间未就绪 → undefined）。 */
  const liveMetaOf = async (): Promise<GeometryMetaInfo[] | undefined> => {
    if (!persistentRoomId) return undefined;
    try {
      const result = await matchMaker.remoteRoomCall<GameRoom>(persistentRoomId, "getLiveMapMeta", []);
      return Array.isArray(result) ? (result as GeometryMetaInfo[]) : undefined;
    } catch {
      return undefined;
    }
  };

  const gameServer = new Server({
    transport,
    // 停机存档接线（F-08）：Colyseus 的 gracefullyShutdown 钩子默认会监听
    // SIGINT/SIGTERM，并在退出前 await 每个房间的 dispose（GameRoom.onDispose
    // 内 await sim.flushSave）；这里显式声明，避免默认值变化导致无停机存档。
    gracefullyShutdown: true,
    express: (app) => {
      app.use((req: any, res: any, next: any) => {
        const origin = req.headers.origin;
        const allowAll = serverConfig.corsOrigins.includes("*");

        if (allowAll) {
          res.setHeader("access-control-allow-origin", "*");
        } else if (origin && serverConfig.corsOrigins.includes(origin)) {
          res.setHeader("access-control-allow-origin", origin);
          res.setHeader("vary", "origin");
        }

        res.setHeader("access-control-allow-methods", "GET,POST,PUT,PATCH,DELETE,OPTIONS");

        const reqHeaders = req.headers["access-control-request-headers"];
        res.setHeader(
          "access-control-allow-headers",
          typeof reqHeaders === "string" ? reqHeaders : "content-type, authorization",
        );

        if (req.method === "OPTIONS") {
          res.status(204).end();
          return;
        }

        next();
      });

      app.get("/health", (_req: any, res: any) => {
        res.status(200).json({ ok: true });
      });

      // 内容目录（静态表的服务端单一来源）：客户端一次拉取即拿到当前
      // game/ 配置的物品/配方/任务/成就/相位/技能清单——不必硬编码。
      app.get("/content", (_req: any, res: any) => {
        res.status(200).json(buildContentCatalog(gameDef));
      });

      app.get("/maps/runtime", async (req: any, res: any) => {
        const rawMapId = req.query?.mapId;
        const mapId = typeof rawMapId === "string" ? rawMapId : undefined;
        // 缺省 mapId → 默认图；显式未知 key（含空串）→ 404，不静默顶替默认图
        const config = gameDef.resolvedMapConfigs.find(
          (c) => c.key === (mapId !== undefined ? mapId : defaultMapId),
        );

        if (!config) {
          res.status(404).json({ error: "unknown map", available: mapIds });
          return;
        }

        // 优先读**活动房间的 live 几何**（含运行期写回，如野火焦土）；
        // 无房间（房间未就绪/创建失败）时回退到按配置重建的视图。
        await waitForRoom();
        const live = await liveGeometryOf(config.key);
        const snapshot = live ?? serializeGeometry(geometryOf(config));
        res.setHeader("x-map-version", snapshot.version);
        res.status(200).json(snapshot);
      });

      app.get("/maps/meta", async (_req: any, res: any) => {
        await waitForRoom();
        const live = await liveMetaOf();
        const maps =
          live ??
          gameDef.resolvedMapConfigs.map((config) =>
            describeGeometry(geometryOf(config), config.pipeline[0].generator),
          );

        res.status(200).json({ default: defaultMapId, maps });
      });

      app.get("/debug/colliders", (req: any, res: any) => {
        if (!persistentRoomId) {
          res.status(404).json({ error: "room_not_ready" });
          return;
        }

        // 可选 mapId：快照只含该图碰撞体；缺省由房间内仿真回退默认图
        // （与 /maps/runtime?mapId 的解析口径一致：非字符串视为缺省）。
        const rawMapId = req.query?.mapId;
        const mapId = typeof rawMapId === "string" ? rawMapId : undefined;

        void matchMaker
          .remoteRoomCall<GameRoom>(
            persistentRoomId,
            "getCollisionDebugSnapshot",
            mapId !== undefined ? [{ mapId }] : [],
          )
          .then(
            (snapshot) => {
              res.status(200).json(snapshot);
            },
            (err) => {
              res.status(500).json({ error: String(err) });
            },
          );
      });
    },
  });

  gameServer.define("game", GameRoom);

  void gameServer.listen(serverConfig.port).then(
    () => {
      options.logger.info("服务器已启动", { port: serverConfig.port });
      void matchMaker.createRoom("game", { gameJsonPath: options.gameJsonPath }).then(
        (room) => {
          persistentRoomId = room.roomId;
          options.logger.info("常驻房间已创建", { roomId: room.roomId });
          markRoomReady();
        },
        (err) => {
          options.logger.error("常驻房间创建失败", { error: String(err) });
          markRoomReady();
        },
      );
    },
    (err) => {
      options.logger.error("服务器启动失败", { error: String(err) });
      markRoomReady();
    },
  );

  const httpServer = transport.server as http.Server;

  return {
    httpServer,
    gameServer,
    async stop() {
      await gameServer.gracefullyShutdown(false);
    },
  };
}
