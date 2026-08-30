/**
 * Colyseus 服务端装配：创建 WebSocket 传输层、注册单房间类型
 * （game）、启动一个常驻房间，并挂载少量调试 HTTP 端点
 * （/health、/maps/runtime、/maps/meta、/debug/colliders）。游戏逻辑全部在
 * 仿真层，本文件只负责把 Colyseus 接到 GameRoom 上。
 */
import http from "node:http";

import { Server, matchMaker } from "@colyseus/core";
import { WebSocketTransport } from "@colyseus/ws-transport";

import { getMapGeometryFromConfig, listMapIdsFromConfig, serverConfig } from "config";
import { buildMapChunks } from "map";
import type { MapGeometry } from "map/geometry/types";
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

/** MapGeometry → /maps/runtime 响应（blocked 位图由 walkable 取反派生）。 */
function geometryToJson(geometry: MapGeometry) {
  const blocked = new Uint8Array(geometry.walkable.length);
  for (let i = 0; i < geometry.walkable.length; i++) {
    blocked[i] = geometry.walkable[i] === 0 ? 1 : 0;
  }
  return {
    id: geometry.key,
    name: geometry.key,
    grid: geometry.grid,
    version: geometry.version,
    chunks: buildMapChunks(blocked, geometry.grid),
  };
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
  const mapRuntimeCache = new Map<string, unknown>();
  let persistentRoomId: string | undefined;

  const gameServer = new Server({
    transport,
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

      app.get("/maps/runtime", (req: any, res: any) => {
        const rawMapId = req.query?.mapId;
        const mapId = typeof rawMapId === "string" ? rawMapId : undefined;
        const geometry = mapId !== undefined ? getMapGeometryFromConfig(mapId) : getMapGeometryFromConfig();

        if (!geometry) {
          res.status(404).json({ error: "unknown map", available: listMapIdsFromConfig() });
          return;
        }

        let runtimeJson = mapRuntimeCache.get(geometry.key);
        if (!runtimeJson) {
          runtimeJson = geometryToJson(geometry);
          mapRuntimeCache.set(geometry.key, runtimeJson);
        }

        res.status(200).json(runtimeJson);
      });

      app.get("/maps/meta", (_req: any, res: any) => {
        const maps = listMapIdsFromConfig()
          .map((mapId) => getMapGeometryFromConfig(mapId))
          .filter((geometry): geometry is MapGeometry => geometry !== null)
          .map((geometry) => ({
            id: geometry.key,
            name: geometry.key,
            kind: "geometry",
            width: geometry.grid.width,
            height: geometry.grid.height,
            tileWidth: geometry.grid.tileWidth,
            tileHeight: geometry.grid.tileHeight,
            version: geometry.version,
          }));

        res.status(200).json({ default: listMapIdsFromConfig()[0] ?? "", maps });
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
        },
        (err) => {
          options.logger.error("常驻房间创建失败", { error: String(err) });
        },
      );
    },
    (err) => {
      options.logger.error("服务器启动失败", { error: String(err) });
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
