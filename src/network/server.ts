import http from "node:http";

import WebSocket, { WebSocketServer, type RawData } from "ws";

import type { ClientToServerInput, ServerToClientMessage, ServerToClientSnapshot } from "network/protocol";
import { decodeClientMessage, encodeServerMessage } from "network/serializers";
import type { Logger } from "utils/logger";

function rawDataToBytes(data: RawData): Uint8Array {
  if (typeof data === "string") return Buffer.from(data, "utf-8");
  if (Array.isArray(data)) return Buffer.concat(data);
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  return data;
}

/**
 * 单个客户端的运行期状态。
 */
export interface NetworkClient {
  id: string;
  ws: WebSocket;
  lastInputSeq: number;
}

/**
 * 网络运行时：系统层只依赖这个结构即可广播/读取输入。
 */
export interface NetworkRuntime {
  clients: Map<string, NetworkClient>;
  latestInputByClientId: Map<string, ClientToServerInput>;
  pendingSnapshot: ServerToClientSnapshot | null;
  broadcast(message: ServerToClientMessage): void;
}

export interface NetworkServer {
  httpServer: http.Server;
  wss: WebSocketServer;
  runtime: NetworkRuntime;
  stop(): Promise<void>;
}

export interface StartNetworkServerOptions {
  port: number;
  wsPath: string;
  logger: Logger;
}

/**
 * 启动 http + ws 的最小网络服务。
 *
 * @param options 端口、ws 路径、日志器
 * @returns 可停止的网络服务对象
 */
export function startNetworkServer(options: StartNetworkServerOptions): NetworkServer {
  const httpServer = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);

    if (url.pathname === "/health") {
      res.statusCode = 200;
      res.setHeader("content-type", "application/json; charset=utf-8");
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    res.statusCode = 200;
    res.setHeader("content-type", "text/plain; charset=utf-8");
    res.end("bitECS headless game server");
  });

  const wss = new WebSocketServer({ server: httpServer, path: options.wsPath });

  let nextClientNumber = 1;

  const runtime: NetworkRuntime = {
    clients: new Map(),
    latestInputByClientId: new Map(),
    pendingSnapshot: null,
    broadcast(message) {
      const payload = encodeServerMessage(message);
      for (const client of runtime.clients.values()) {
        if (client.ws.readyState === WebSocket.OPEN) client.ws.send(payload);
      }
    },
  };

  wss.on("connection", (ws: WebSocket) => {
    const id = String(nextClientNumber++);
    const client: NetworkClient = { id, ws, lastInputSeq: 0 };
    runtime.clients.set(id, client);

    options.logger.info("客户端已连接", { id });

    ws.on("message", (data: RawData) => {
      const message = decodeClientMessage(rawDataToBytes(data));
      if (!message) return;

      if (message.payload.case !== "input") return;
      const input: ClientToServerInput = message.payload.value;

      if (input.seq <= client.lastInputSeq) return;
      client.lastInputSeq = input.seq;
      runtime.latestInputByClientId.set(id, input);
    });

    ws.on("close", () => {
      runtime.clients.delete(id);
      runtime.latestInputByClientId.delete(id);
      options.logger.info("客户端已断开", { id });
    });
  });

  httpServer.listen(options.port, () => {
    options.logger.info("服务器已启动", {
      port: options.port,
      wsPath: options.wsPath,
    });
  });

  return {
    httpServer,
    wss,
    runtime,
    async stop() {
      await new Promise<void>((resolve) => wss.close(() => resolve()));
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    },
  };
}
