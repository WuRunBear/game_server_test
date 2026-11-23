/**
 * CC-01 Client Manifest：HTTP 契约测试。
 *
 * 覆盖 `GET /client/manifest`：
 * - 200 + JSON；强 ETag（带引号）等于 contentVersion；Cache-Control: no-cache；
 * - `If-None-Match` 精确 / 弱前缀 / 列表命中 → 304 且无 body；
 * - 未命中的 ETag → 200 全量；
 * - 响应内容与纯函数构建结果一致（版本来自 protocol.ts）。
 *
 * 服务器启动：vi.hoisted 先于静态导入把 PORT 置 0；SAVE_DIR 指向空临时目录
 * （避免旧存档让常驻房间创建失败——本端点不依赖房间，但保持与其他 HTTP
 * 测试同一启动路径）。
 */
import http from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { bootstrapFramework } from "framework/bootstrap";
import { loadGameDefinition } from "framework/bootstrap/loadGameDefinition";
import { buildClientManifest, type ClientManifest } from "framework/content/manifest";
import { registerContentLabel, resetContentLabels } from "framework/content/labels";
import type { ColyseusServer } from "framework/net/colyseus/server";
import { PROTOCOL_VERSION } from "framework/net/protocol";
import type { Logger } from "utils/logger";

vi.hoisted(() => {
  process.env.PORT = "0";
});

/** 静默日志器：测试不落日志文件。 */
const stubLogger: Logger = {
  info: () => {},
  warn: () => {},
  error: () => {},
};

let colyseus: ColyseusServer | undefined;
let baseUrl = "";
let gameDef: ReturnType<typeof loadGameDefinition>;
let expected: ClientManifest;

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

beforeAll(async () => {
  bootstrapFramework();
  gameDef = loadGameDefinition({ gameJsonPath: "game/game.json" });
  // 展示名注册在 manifest 首次构建前生效（生产由 src/register.ts 在启动链最前注册）
  registerContentLabel("item", "axe", "斧头");
  expected = buildClientManifest(gameDef);

  process.env.SAVE_DIR = mkdtempSync(join(tmpdir(), "manifest-endpoint-saves-"));

  const serverModule = await import("framework/net/colyseus/server");
  colyseus = serverModule.startColyseusServer({ logger: stubLogger });
  await waitForListen(colyseus.httpServer);

  const addr = colyseus.httpServer.address();
  if (!addr || typeof addr === "string") throw new Error("测试服务器未监听任何端口");
  baseUrl = `http://127.0.0.1:${addr.port}`;
}, 60_000);

afterAll(async () => {
  resetContentLabels();
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

describe("GET /client/manifest", () => {
  it("200 + JSON，ETag 为强版本标签，Cache-Control: no-cache", async () => {
    const res = await fetch(`${baseUrl}/client/manifest`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");
    expect(res.headers.get("cache-control")).toBe("no-cache");

    const etag = res.headers.get("etag");
    expect(etag).toMatch(/^"[0-9a-f]{8}"$/);

    const body = (await res.json()) as ClientManifest;
    expect(body.contentVersion).toBe(etag!.slice(1, -1));
    expect(body.protocolVersion).toBe(PROTOCOL_VERSION);
    expect(body.schemaVersion).toBe(expected.schemaVersion);
    expect(body.maps.map((map) => map.id)).toEqual(expected.maps.map((map) => map.id));
    expect(body.entities).toHaveLength(expected.entities.length);
    // labels 在首次构建前注册 → manifest 的物品标签使用登记名
    expect(body.items.find((item) => item.kind === "axe")!.label).toBe("斧头");
  });

  it("首次构建后缓存：重复 200 响应体完全一致", async () => {
    const first = await fetch(`${baseUrl}/client/manifest`);
    const firstText = await first.text();
    const second = await fetch(`${baseUrl}/client/manifest`);
    const secondText = await second.text();
    expect(second.status).toBe(200);
    expect(secondText).toBe(firstText);
    expect(second.headers.get("etag")).toBe(first.headers.get("etag"));
  });

  it("If-None-Match 命中（精确 / 弱前缀 / 列表 / *）→ 304 无 body", async () => {
    const first = await fetch(`${baseUrl}/client/manifest`);
    const etag = first.headers.get("etag")!;
    await first.text();

    for (const header of [etag, `W/${etag}`, `"deadbeef", ${etag}`, "*"]) {
      const res = await fetch(`${baseUrl}/client/manifest`, {
        headers: { "if-none-match": header },
      });
      expect(res.status, header).toBe(304);
      expect(await res.text()).toBe("");
      // 304 也带 ETag/Cache-Control，便于客户端继续复用
      expect(res.headers.get("etag")).toBe(etag);
      expect(res.headers.get("cache-control")).toBe("no-cache");
    }
  });

  it("If-None-Match 未命中 → 200 全量", async () => {
    const res = await fetch(`${baseUrl}/client/manifest`, {
      headers: { "if-none-match": '"deadbeef"' },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as ClientManifest;
    expect(body.contentVersion).toMatch(/^[0-9a-f]{8}$/);
  });
});
