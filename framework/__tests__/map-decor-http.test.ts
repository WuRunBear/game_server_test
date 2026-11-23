/**
 * CC-13 装饰点集 HTTP 契约测试（真实 game/ 配置 + 常驻房间 live 几何）。
 *
 * 覆盖 `GET /maps/decor?mapId=<key>`：
 * - 200 + `{key, version, points[]}`；`x-map-version` = body.version 且与
 *   `/maps/runtime` 同源（room 就绪时都是 live 几何版本）；
 * - 点字段（decorId/x/y/level/region/variant）齐全且落在图内；
 * - 同请求重复结果逐字节一致（确定性）；
 * - 缺省 mapId → 默认图；未知 mapId → 404 {error, available}；
 * - 8 张配置图都有装饰点（地图不空）；
 * - 无装饰配置时 200 + 空点集（清空活动配置后验证，放在本文件末尾）。
 *
 * 服务器启动：vi.hoisted 先置 PORT=0；SAVE_DIR 指向空临时目录，等常驻房间
 * 创建完成后再请求，避免 live/回退视图在版本上出现启动竞态。
 */
import http from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { matchMaker } from "@colyseus/core";

import { bootstrapFramework } from "framework/bootstrap";
import { loadGameDefinition } from "framework/bootstrap/loadGameDefinition";
import { clearPresentation } from "framework/content/presentation";
import type { ColyseusServer } from "framework/net/colyseus/server";
import type { Logger } from "utils/logger";

vi.hoisted(() => {
  process.env.PORT = "0";
});

const stubLogger: Logger = {
  info: () => {},
  warn: () => {},
  error: () => {},
};

/** `/maps/decor` 单点。 */
interface DecorPoint {
  decorId: string;
  x: number;
  y: number;
  level: number;
  region: string;
  variant: number;
}

/** `/maps/decor` 响应。 */
interface DecorView {
  key: string;
  version: string;
  points: DecorPoint[];
}

/** 404 错误体。 */
interface ErrorBody {
  error: string;
  available: string[];
}

let colyseus: ColyseusServer | undefined;
let baseUrl = "";
let roomId = "";
let gameDef: ReturnType<typeof loadGameDefinition>;

/** 等待 http.Server 进入监听状态。 */
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

/** 等常驻房间创建完成（server.ts 内 matchMaker.createRoom 异步）。 */
async function waitForRoomId(): Promise<string> {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    const rooms = await matchMaker.query({});
    const room = rooms.find((entry) => entry.roomId);
    if (room) return room.roomId;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error("常驻房间未创建");
}

/** GET /maps/decor（mapId 省略则不拼查询参数）。 */
async function getDecor(mapId?: string): Promise<{
  status: number;
  body: DecorView | ErrorBody;
  versionHeader: string | null;
}> {
  const url =
    mapId === undefined
      ? `${baseUrl}/maps/decor`
      : `${baseUrl}/maps/decor?mapId=${encodeURIComponent(mapId)}`;
  const res = await fetch(url);
  return {
    status: res.status,
    body: (await res.json()) as DecorView | ErrorBody,
    versionHeader: res.headers.get("x-map-version"),
  };
}

beforeAll(async () => {
  bootstrapFramework();
  gameDef = loadGameDefinition({ gameJsonPath: "game/game.json" });

  process.env.SAVE_DIR = mkdtempSync(join(tmpdir(), "map-decor-http-saves-"));

  const serverModule = await import("framework/net/colyseus/server");
  colyseus = serverModule.startColyseusServer({ logger: stubLogger });
  await waitForListen(colyseus.httpServer);

  const addr = colyseus.httpServer.address();
  if (!addr || typeof addr === "string") throw new Error("测试服务器未监听任何端口");
  baseUrl = `http://127.0.0.1:${addr.port}`;
  roomId = await waitForRoomId();
}, 90_000);

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

describe("GET /maps/decor", () => {
  it("200 + {key, version, points}；x-map-version 与 /maps/runtime 同源", async () => {
    expect(roomId).not.toBe("");

    const res = await getDecor("island");
    expect(res.status).toBe(200);
    const view = res.body as DecorView;
    expect(view.key).toBe("island");
    expect(view.version).toMatch(/^[0-9a-f]{8}$/);
    expect(res.versionHeader).toBe(view.version);
    expect(view.points.length).toBeGreaterThan(0);

    const runtime = await fetch(`${baseUrl}/maps/runtime?mapId=island`);
    expect(runtime.status).toBe(200);
    expect(runtime.headers.get("x-map-version")).toBe(view.version);
    const runtimeBody = (await runtime.json()) as {
      grid: { width: number; height: number; tileWidth: number; tileHeight: number };
    };
    const pixelWidth = runtimeBody.grid.width * runtimeBody.grid.tileWidth;
    const pixelHeight = runtimeBody.grid.height * runtimeBody.grid.tileHeight;

    const decorIds = new Set(["bone", "bush", "flower", "moss", "mushroom", "pebble", "reed", "shell"]);
    for (const point of view.points) {
      expect(decorIds.has(point.decorId)).toBe(true);
      expect(Number.isFinite(point.x)).toBe(true);
      expect(Number.isFinite(point.y)).toBe(true);
      expect(point.x).toBeGreaterThanOrEqual(0);
      expect(point.x).toBeLessThan(pixelWidth);
      expect(point.y).toBeGreaterThanOrEqual(0);
      expect(point.y).toBeLessThan(pixelHeight);
      expect(Number.isInteger(point.level)).toBe(true);
      expect(typeof point.region).toBe("string");
      expect(Number.isInteger(point.variant)).toBe(true);
      expect(point.variant).toBeGreaterThanOrEqual(0);
    }
  });

  it("同请求重复结果逐字节一致（跨请求确定性）", async () => {
    const first = await fetch(`${baseUrl}/maps/decor?mapId=island`);
    const firstText = await first.text();
    const second = await fetch(`${baseUrl}/maps/decor?mapId=island`);
    const secondText = await second.text();
    expect(second.status).toBe(200);
    expect(secondText).toBe(firstText);
    expect(second.headers.get("x-map-version")).toBe(first.headers.get("x-map-version"));
  });

  it("缺省 mapId → 默认图；8 张配置图都有装饰点", async () => {
    const defaultView = await getDecor();
    expect(defaultView.status).toBe(200);
    expect((defaultView.body as DecorView).key).toBe(gameDef.map?.default);

    for (const config of gameDef.resolvedMapConfigs) {
      const res = await getDecor(config.key);
      expect(res.status, config.key).toBe(200);
      const view = res.body as DecorView;
      expect(view.key).toBe(config.key);
      expect(res.versionHeader).toBe(view.version);
      expect(view.points.length, `${config.key} 无装饰点`).toBeGreaterThan(0);
    }
  });

  it("未知 mapId → 404 {error, available}", async () => {
    const res = await getDecor("no-such-map");
    expect(res.status).toBe(404);
    const body = res.body as ErrorBody;
    expect(body.error).toBe("unknown map");
    expect(body.available).toContain("island");
    expect(body.available).toEqual(gameDef.resolvedMapConfigs.map((config) => config.key));
  });

  // 放在最后：清空活动配置后不得影响前面用例（server 缓存按 revision 失效）
  it("无装饰配置 → 200 + 空点集", async () => {
    clearPresentation();
    const res = await getDecor("island");
    expect(res.status).toBe(200);
    const view = res.body as DecorView;
    expect(view.key).toBe("island");
    expect(view.version).toMatch(/^[0-9a-f]{8}$/);
    expect(res.versionHeader).toBe(view.version);
    expect(view.points).toEqual([]);
  });
});
