/**
 * 地图 HTTP 端点测试（/maps/runtime 与 /maps/meta，MapGeometry 数据源）。
 *
 * 覆盖：
 * - /maps/meta：列出全部配置图（island/cave/tiled-demo），字段
 *   id/name/kind/width/height/tileWidth/tileHeight/version 齐全，kind 为
 *   生成管道首积木注册名，default = game.json map.default；
 * - /maps/runtime?mapId=<key>：响应体 = serializeGeometry 快照形状
 *   （key/grid/tiles/walkable/regions/regionOfTile/version），与测试侧按
 *   同一配置 + 同一积木注册表确定性重建的几何逐字段一致（即与仿真
 *   world.maps 同源同内容）；x-map-version 响应头 = geometry.version；
 * - version 稳定性：同图两次请求一致，且与 /maps/meta 一致；
 * - 未知 mapId（含空串）→ 404 {error, available}，不静默顶替默认图；
 * - 请求 key 决定响应：不同图数据互不串扰；缺省 mapId → 默认图。
 *
 * 服务器启动方式：vi.hoisted 先于本文件全部静态导入执行，把 PORT 置为 0
 * （config/server.ts 的 serverConfig 在模块导入时读取 process.env.PORT），
 * 因此服务器绑定临时端口，与开发端口 3000 无冲突；实际端口从
 * httpServer.address() 读取，请求走 127.0.0.1。
 */
import http from "node:http";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { bootstrapFramework, getRegistries } from "framework/bootstrap";
import { loadGameDefinition } from "framework/bootstrap/loadGameDefinition";
import type { MapConfig } from "framework/config/schema/MapRegistrySchema";
import { serverConfig } from "config";
import { buildMapGeometry } from "map/generate/pipeline";
import {
  deserializeGeometry,
  serializeGeometry,
  type SerializedMapGeometry,
} from "map/geometry/snapshot";
import { computeGeometryVersion } from "map/geometry/version";
import type { ColyseusServer } from "framework/net/colyseus/server";
import type { Logger } from "utils/logger";

// 必须在任何 config 模块求值之前生效（serverConfig 于导入时固化端口）。
vi.hoisted(() => {
  process.env.PORT = "0";
});

/** /maps/meta 单图条目形状（服务端契约，字段自本切片起定死）。 */
interface MetaMapEntry {
  id: string;
  name: string;
  kind: string;
  width: number;
  height: number;
  tileWidth: number;
  tileHeight: number;
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
let gameDef: ReturnType<typeof loadGameDefinition>;

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
 * 测试侧按同一配置 + 同一积木注册表确定性重建几何并序列化——与端点数据源
 * （服务端同配置重建）及仿真 world.maps（bootMaps 同配置构建）同源同内容。
 */
function expectedSnapshot(config: MapConfig): SerializedMapGeometry {
  return serializeGeometry(buildMapGeometry(config, getRegistries().mapGeneratorRegistry));
}

/** 请求 /maps/runtime（mapId 省略则不拼查询参数），附 x-map-version 响应头。 */
async function getRuntime(mapId?: string): Promise<{
  status: number;
  body: SerializedMapGeometry;
  versionHeader: string | null;
}> {
  const url =
    mapId === undefined
      ? `${baseUrl}/maps/runtime`
      : `${baseUrl}/maps/runtime?mapId=${encodeURIComponent(mapId)}`;
  const res = await fetch(url);
  return {
    status: res.status,
    body: (await res.json()) as SerializedMapGeometry,
    versionHeader: res.headers.get("x-map-version"),
  };
}

/** 请求 /maps/meta。 */
async function getMeta(): Promise<MetaResponse> {
  const res = await fetch(`${baseUrl}/maps/meta`);
  expect(res.status).toBe(200);
  return (await res.json()) as MetaResponse;
}

beforeAll(async () => {
  // 全局引导一次：注册表是幂等单例，端点几何重建依赖内置积木注册表
  bootstrapFramework();

  // PORT=0 已在文件顶部（vi.hoisted）生效——此处断言防静默回退到 3000 端口冲突
  expect(serverConfig.port).toBe(0);

  // 测试侧独立加载同一份配置，作为端点响应的期望值来源
  gameDef = loadGameDefinition({ gameJsonPath: "game/game.json" });

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
  it("/maps/meta：列出全部配置图，字段齐全，kind 为管道首积木名", async () => {
    const meta = await getMeta();
    expect(meta.default).toBe("island");
    expect(meta.maps.map((m) => m.id)).toEqual(["island", "cave", "tiled-demo"]);
    expect(meta.maps).toHaveLength(gameDef.resolvedMapConfigs.length);

    // 与测试侧重建几何逐字段一致（顺序 = 配置声明序）
    meta.maps.forEach((entry, i) => {
      const config = gameDef.resolvedMapConfigs[i];
      const expected = expectedSnapshot(config);
      expect(entry.id).toBe(config.key);
      expect(entry.name).toBe(config.key);
      expect(entry.kind).toBe(config.pipeline[0].generator);
      expect(entry.width).toBe(expected.grid.width);
      expect(entry.height).toBe(expected.grid.height);
      expect(entry.tileWidth).toBe(expected.grid.tileWidth);
      expect(entry.tileHeight).toBe(expected.grid.tileHeight);
      expect(entry.version).toBe(expected.version);
      expect(entry.version).toMatch(/^[0-9a-f]{8}$/);
    });

    // 真实配置的已知尺寸与 kind 钉死
    expect(meta.maps.find((m) => m.id === "island")).toMatchObject({
      kind: "noise-terrain",
      width: 96,
      height: 96,
      tileWidth: 16,
      tileHeight: 16,
    });
    expect(meta.maps.find((m) => m.id === "cave")).toMatchObject({
      kind: "noise-terrain",
      width: 64,
      height: 64,
      tileWidth: 16,
      tileHeight: 16,
    });
    expect(meta.maps.find((m) => m.id === "tiled-demo")).toMatchObject({
      kind: "tiled-source",
      width: 8,
      height: 8,
      tileWidth: 16,
      tileHeight: 16,
    });
  });

  it("/maps/runtime?mapId=<key>：响应体 = 同配置重建几何的 serializeGeometry 快照，x-map-version 头 = version", async () => {
    for (const config of gameDef.resolvedMapConfigs) {
      const { status, body, versionHeader } = await getRuntime(config.key);
      expect(status).toBe(200);
      expect(body.key).toBe(config.key);
      // 全快照深相等：key/grid/tiles/walkable/regions/regionOfTile/version
      expect(body).toEqual(expectedSnapshot(config));
      expect(versionHeader).toBe(body.version);
    }
  });

  it("version 稳定：同图两次请求一致，且与 /maps/meta 一致", async () => {
    const first = await getRuntime("island");
    const second = await getRuntime("island");
    expect(second.status).toBe(200);
    expect(second.body.version).toBe(first.body.version);
    expect(second.body).toEqual(first.body);

    const meta = await getMeta();
    for (const entry of meta.maps) {
      const { body } = await getRuntime(entry.id);
      expect(body.version).toBe(entry.version);
    }
  });

  it("未知 mapId → 404 {error, available}（含空串），不静默顶替默认图", async () => {
    const res = await fetch(`${baseUrl}/maps/runtime?mapId=does-not-exist`);
    expect(res.status).toBe(404);
    const body = (await res.json()) as ErrorBody;
    expect(body.error).toBe("unknown map");
    expect(body.available).toEqual(["island", "cave", "tiled-demo"]);

    // 空串视为显式 id（清单中不存在）→ 同样 404
    const empty = await fetch(`${baseUrl}/maps/runtime?mapId=`);
    expect(empty.status).toBe(404);
    const emptyBody = (await empty.json()) as ErrorBody;
    expect(emptyBody.error).toBe("unknown map");
  });

  it("请求 key 决定响应：不同图数据互不串扰；缺省 mapId → 默认图", async () => {
    const island = await getRuntime("island");
    const cave = await getRuntime("cave");
    expect(island.body.key).toBe("island");
    expect(island.body.grid).toEqual({ width: 96, height: 96, tileWidth: 16, tileHeight: 16 });
    expect(cave.body.key).toBe("cave");
    expect(cave.body.grid).toEqual({ width: 64, height: 64, tileWidth: 16, tileHeight: 16 });
    expect(island.body.version).not.toBe(cave.body.version);
    expect(island.body.tiles).not.toEqual(cave.body.tiles);

    // 缺省 mapId → 默认图（game.json map.default = island）
    const fallback = await getRuntime();
    expect(fallback.status).toBe(200);
    expect(fallback.body.key).toBe("island");
  });

  it("geometry version：同配置重建恒定，内容变化即变（纯函数直测）", () => {
    for (const config of gameDef.resolvedMapConfigs) {
      const snapshot = expectedSnapshot(config);
      expect(snapshot.version).toMatch(/^[0-9a-f]{8}$/);

      // 确定性管道（固定 seed）重建 → 内容一致 → 版本一致
      expect(expectedSnapshot(config).version).toBe(snapshot.version);

      // 内容变化（翻转一个通行字节）→ 版本变化
      const modified: SerializedMapGeometry = { ...snapshot, walkable: snapshot.walkable.slice() };
      modified.walkable[0] = modified.walkable[0] === 1 ? 0 : 1;
      const modifiedVersion = computeGeometryVersion(deserializeGeometry(modified));
      expect(modifiedVersion).not.toBe(snapshot.version);
      expect(modifiedVersion).toMatch(/^[0-9a-f]{8}$/);
    }
  });
});
