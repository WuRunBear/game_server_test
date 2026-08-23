/**
 * Colyseus 服务端装配：创建 WebSocket 传输层、注册单房间类型
 * （game）、启动一个常驻房间，并挂载少量调试 HTTP 端点
 * （/health、/maps/runtime、/maps/meta、/debug/colliders）。游戏逻辑全部在
 * 仿真层，本文件只负责把 Colyseus 接到 GameRoom 上。
 */
import http from "node:http";

import { Server, matchMaker } from "@colyseus/core";
import { WebSocketTransport } from "@colyseus/ws-transport";

import { getMapSourceFromConfig, listMapIdsFromConfig, serverConfig } from "config";
import {
  buildMapChunks,
  buildMapRuntime,
  computeMapVersion,
  describeMapSource,
} from "map";
import type { MapSource } from "map";
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
        const source = mapId !== undefined ? getMapSourceFromConfig(mapId) : getMapSourceFromConfig();

        if (!source) {
          res.status(404).json({ error: "unknown map", available: listMapIdsFromConfig() });
          return;
        }

        let runtimeJson = mapRuntimeCache.get(source.id);
        if (!runtimeJson) {
          const runtime = buildMapRuntime(source);
          runtimeJson = {
            id: runtime.id,
            name: runtime.name,
            grid: runtime.grid,
            version: computeMapVersion(runtime),
            chunks: buildMapChunks(runtime.blocked, runtime.grid),
          };
          mapRuntimeCache.set(source.id, runtimeJson);
        }

        res.status(200).json(runtimeJson);
      });

      app.get("/maps/meta", (_req: any, res: any) => {
        const defaultSource = getMapSourceFromConfig();
        const maps = listMapIdsFromConfig()
          .map((mapId) => getMapSourceFromConfig(mapId))
          .filter((source): source is MapSource => source !== null)
          .map((source) => ({
            ...describeMapSource(source),
            version: computeMapVersion(buildMapRuntime(source)),
          }));

        res.status(200).json({ default: defaultSource.id, maps });
      });

      app.get("/debug/colliders", (_req: any, res: any) => {
        if (!persistentRoomId) {
          res.status(404).json({ error: "room_not_ready" });
          return;
        }

        void matchMaker
          .remoteRoomCall<GameRoom>(persistentRoomId, "getCollisionDebugSnapshot")
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
