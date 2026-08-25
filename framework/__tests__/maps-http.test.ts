/**
 * 地图 HTTP 端点测试（framework/__tests__/maps-http.test.ts）。
 *
 * 覆盖 /maps/runtime 与 /maps/meta 两个调试端点：
 * - ?mapId=cave 返回 cave 数据（32×32，chunks 解码后共 1024 字节）；
 * - 缺省 mapId 回退注册表默认图 generated-map（64×64）；
 * - 未知 mapId → 404 {error:"unknown map", available:[...]}；
 * - version 稳定性（同内容恒定、内容变化即变，直接测 computeMapVersion 纯函数）；
 * - /maps/meta 与 /maps/runtime 的 version 一致（两张图都验）；
 * - chunks 解码总字节数 = width×height；
 * - /maps/meta 响应形状（default / maps 字段）。
 *
 * 服务器启动方式：vi.hoisted 先于本文件全部静态导入执行，把 PORT 置为 0
 * （config/server.ts 的 serverConfig 在模块导入时读取 process.env.PORT），
 * 因此服务器绑定临时端口，与开发端口 3000 无冲突；实际端口从
 * httpServer.address() 读取，请求走 127.0.0.1。
 */
import http from "node:http";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { bootstrapFramework } from "framework/index";
import { buildMapRuntime, computeMapVersion, MAP_CHUNK_SIZE } from "map";
import { getMapSourceFromConfig, listMapIdsFromConfig, serverConfig } from "config";
import type { MapChunk, MapRuntime } from "map";
import type { ColyseusServer } from "framework/net/colyseus/server";
import type { Logger } from "utils/logger";

// 必须在任何 config 模块求值之前生效（serverConfig 于导入时固化端口）。
vi.hoisted(() => {
  process.env.PORT = "0";
});

/** /maps/runtime 响应形状（服务端契约）。 */
interface RuntimeResponse {
  id: string;
  name: string;
  grid: { width: number; height: number; tileWidth: number; tileHeight: number };
  version: string;
  chunks: MapChunk[];
}

/** /maps/meta 单图条目形状（generated kind 的 width/height/seed 等必在）。 */
interface MetaMapEntry {
  id: string;
  name: string;
  kind: string;
  width?: number;
  height?: number;
  tileWidth?: number;
  tileHeight?: number;
  generatorId?: string;
  seed?: number;
  version: string;
}

/** /maps/meta 响应形状。 */
interface MetaResponse {
  default: string;
  maps: MetaMapEntry[];
}

/** 404 错误体形状。 */
interface ErrorBody {
  error: string;
  available: string[];
}

/** 静默日志器：测试不落日志文件（winston 惰性初始化同样被绕过）。 */
const stubLogger: Logger = {
  info: () => {},
  warn: () => {},
  error: () => {},
};

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

/** 解码单个块的 base64 data 为原始字节。 */
function decodeChunk(chunk: MapChunk): Uint8Array {
  return new Uint8Array(Buffer.from(chunk.data, "base64"));
}

/** 解码全部块并求和字节数（契约：总字节数 = width×height）。 */
function totalChunkBytes(chunks: MapChunk[]): number {
  return chunks.reduce((sum, chunk) => sum + decodeChunk(chunk).length, 0);
}

/** 请求 /maps/runtime（mapId 省略则不拼查询参数）。 */
async function getRuntime(mapId?: string): Promise<{ status: number; body: RuntimeResponse }> {
  const url =
    mapId === undefined
      ? `${baseUrl}/maps/runtime`
      : `${baseUrl}/maps/runtime?mapId=${encodeURIComponent(mapId)}`;
  const res = await fetch(url);
  return { status: res.status, body: (await res.json()) as RuntimeResponse };
}

/** 请求 /maps/meta。 */
async function getMeta(): Promise<MetaResponse> {
  const res = await fetch(`${baseUrl}/maps/meta`);
  expect(res.status).toBe(200);
  return (await res.json()) as MetaResponse;
}

beforeAll(async () => {
  // 全局引导一次：注册表是幂等单例，/maps/runtime 的 buildMapRuntime 依赖内置生成器
  bootstrapFramework();

  // PORT=0 已在文件顶部（vi.hoisted）生效——此处断言防静默回退到 3000 端口冲突
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
});

afterAll(async () => {
  const server = colyseus;
  if (!server) return;

  // 常驻房间（matchMaker.createRoom）在测试环境可能创建失败——stop 兜底超时，
  // 之后强制关闭监听，避免 worker 因遗留句柄挂起
  await Promise.race([
    server.stop().catch(() => {}),
    new Promise((resolve) => setTimeout(resolve, 5000)),
  ]);
  if (server.httpServer.listening) {
    await new Promise<void>((resolve) => server.httpServer.close(() => resolve()));
  }
});

describe("地图 HTTP 端点（/maps/runtime 与 /maps/meta）", () => {
  it("/maps/runtime?mapId=cave：200 返回 cave 数据（32×32，chunks 解码共 1024 字节）", async () => {
    const { status, body } = await getRuntime("cave");
    expect(status).toBe(200);
    expect(body.id).toBe("cave");
    expect(typeof body.name).toBe("string");
    expect(body.grid).toEqual({ width: 32, height: 32, tileWidth: 16, tileHeight: 16 });
    expect(body.version).toMatch(/^[0-9a-f]{8}$/);

    // 32×32 → 2×2 = 4 块；行主序（cy 外层、cx 内层）
    expect(body.chunks).toHaveLength(4);
    expect(body.chunks.map((c) => [c.cx, c.cy])).toEqual([
      [0, 0],
      [1, 0],
      [0, 1],
      [1, 1],
    ]);
    // 每块满 16×16 = 256 字节；总字节数 = 32×32 = 1024
    for (const chunk of body.chunks) {
      expect(decodeChunk(chunk)).toHaveLength(MAP_CHUNK_SIZE * MAP_CHUNK_SIZE);
    }
    expect(totalChunkBytes(body.chunks)).toBe(32 * 32);
  });

  it("/maps/runtime 缺省 mapId：回退注册表默认图 generated-map（64×64）", async () => {
    const { status, body } = await getRuntime();
    expect(status).toBe(200);
    expect(body.id).toBe("generated-map");
    expect(body.grid).toEqual({ width: 64, height: 64, tileWidth: 16, tileHeight: 16 });
    // 64×64 → 4×4 = 16 块，总字节数 = 4096
    expect(body.chunks).toHaveLength(16);
    expect(totalChunkBytes(body.chunks)).toBe(64 * 64);
    expect(body.version).toMatch(/^[0-9a-f]{8}$/);
  });

  it("/maps/runtime?mapId=tiled-demo：200，chunks 非空，meta 已列出", async () => {
    const { status, body } = await getRuntime("tiled-demo");
    expect(status).toBe(200);
    expect(body.id).toBe("tiled-demo");
    expect(body.grid).toEqual({ width: 8, height: 8, tileWidth: 16, tileHeight: 16 });
    expect(body.chunks.length).toBeGreaterThan(0);
    expect(body.version).toMatch(/^[0-9a-f]{8}$/);
    const meta = await getMeta();
    expect(meta.maps.some((m) => m.id === "tiled-demo")).toBe(true);
  });

  it("未知 mapId → 404 {error, available}（含空串 mapId）", async () => {
    const res = await fetch(`${baseUrl}/maps/runtime?mapId=does-not-exist`);
    expect(res.status).toBe(404);
    const body = (await res.json()) as ErrorBody;
    expect(body.error).toBe("unknown map");
    expect(body.available).toEqual(listMapIdsFromConfig());
    expect(body.available).toContain("generated-map");
    expect(body.available).toContain("cave");
    expect(body.available).toContain("tiled-demo");

    // 空串视为显式 id（清单中不存在）→ 同样 404
    const empty = await fetch(`${baseUrl}/maps/runtime?mapId=`);
    expect(empty.status).toBe(404);
    const emptyBody = (await empty.json()) as ErrorBody;
    expect(emptyBody.error).toBe("unknown map");
  });

  it("computeMapVersion：同内容恒定，内容变化即变（纯函数直测）", () => {
    const source = getMapSourceFromConfig("cave");
    expect(source).not.toBeNull();
    const runtime = buildMapRuntime(source!);

    const v1 = computeMapVersion(runtime);
    expect(v1).toMatch(/^[0-9a-f]{8}$/);

    // 确定性生成器（seed=2）重建同一来源 → 内容一致 → 版本一致
    const rebuilt = buildMapRuntime(getMapSourceFromConfig("cave")!);
    expect(computeMapVersion(rebuilt)).toBe(v1);

    // 内容变化（翻转一个阻挡字节）→ 版本变化
    const modified: MapRuntime = { ...runtime, blocked: runtime.blocked.slice() };
    modified.blocked[0] = modified.blocked[0] === 1 ? 0 : 1;
    expect(computeMapVersion(modified)).not.toBe(v1);
    expect(computeMapVersion(modified)).toMatch(/^[0-9a-f]{8}$/);
  });

  it("/maps/meta 与 /maps/runtime 的 version 一致（两张图都验）", async () => {
    const meta = await getMeta();
    expect(meta.maps).toHaveLength(3);

    for (const entry of meta.maps) {
      const { status, body } = await getRuntime(entry.id);
      expect(status).toBe(200);
      expect(body.id).toBe(entry.id);
      // meta 每次现算（不缓存），runtime 走服务端缓存——两侧结果必须一致
      expect(body.version).toBe(entry.version);
    }
  });

  it("chunks 解码总字节数 = width×height，块尺寸符合 16×16 约定（两张图都验）", async () => {
    const meta = await getMeta();
    for (const entry of meta.maps) {
      const { status, body } = await getRuntime(entry.id);
      expect(status).toBe(200);

      const { width, height } = body.grid;
      const expectedChunkCount =
        Math.ceil(width / MAP_CHUNK_SIZE) * Math.ceil(height / MAP_CHUNK_SIZE);
      expect(body.chunks).toHaveLength(expectedChunkCount);
      expect(totalChunkBytes(body.chunks)).toBe(width * height);

      // 每块尺寸 = min(16, 剩余列数) × min(16, 剩余行数)
      for (const chunk of body.chunks) {
        const expectW = Math.min(MAP_CHUNK_SIZE, width - chunk.cx * MAP_CHUNK_SIZE);
        const expectH = Math.min(MAP_CHUNK_SIZE, height - chunk.cy * MAP_CHUNK_SIZE);
        expect(decodeChunk(chunk)).toHaveLength(expectW * expectH);
      }
    }
  });

  it("/maps/meta 响应形状：default=generated-map，两张图字段齐全", async () => {
    const meta = await getMeta();
    expect(meta.default).toBe("generated-map");
    expect(meta.maps).toHaveLength(3);

    const generatedMap = meta.maps.find((m) => m.id === "generated-map");
    const cave = meta.maps.find((m) => m.id === "cave");
    expect(generatedMap).toBeDefined();
    expect(cave).toBeDefined();

    const tiledDemo = meta.maps.find((m) => m.id === "tiled-demo");
    expect(tiledDemo).toBeDefined();
    expect(tiledDemo).toMatchObject({ kind: "tiled", width: 8, height: 8, tileWidth: 16, tileHeight: 16 });

    expect(generatedMap).toMatchObject({
      kind: "generated",
      width: 64,
      height: 64,
      tileWidth: 16,
      tileHeight: 16,
      generatorId: "simple",
      seed: 1,
    });
    expect(cave).toMatchObject({
      kind: "generated",
      width: 32,
      height: 32,
      tileWidth: 16,
      tileHeight: 16,
      generatorId: "cave",
      seed: 2,
    });

    // 每张图：id/name 非空字符串，version 为 8 位小写十六进制
    for (const entry of meta.maps) {
      expect(typeof entry.id).toBe("string");
      expect(entry.id.length).toBeGreaterThan(0);
      expect(typeof entry.name).toBe("string");
      expect(entry.name.length).toBeGreaterThan(0);
      expect(entry.version).toMatch(/^[0-9a-f]{8}$/);
    }
  });
});
