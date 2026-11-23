/**
 * CC-05 地图客户端通道 HTTP 集成测试（真实 game/ 配置 + 活动房间 live 几何）。
 *
 * 覆盖：
 * - `/maps/runtime` 三路径：无 sinceVersion 全量（旧形状不变）、与当前版本相同
 *   → `{unchanged:true}`、已知基线/历史版本 → 稀疏终态增量；
 * - 写回一格后增量只含该格；同格二次写回只保留最后值（last-write-wins）；
 * - 未知 sinceVersion → 回退全量（200，不是 404）；
 * - 所有 `/maps/runtime` 响应（全量/未变/增量/回退）都带 `x-map-version` 且与
 *   body.version 一致；
 * - `/maps/render`：有效地面长度/派生字段/renderVersion；写回格在有效地面中
 *   反映 live 底板；非覆盖语义格与底板一致；
 * - `/maps/collision`：walkable 长度、建造物占用（地图静态房屋的墙/楼板），
 *   实体只用 networkId（无 eid）；
 * - `/world/map-graph`：registry 8 图 + presentation 展示名/连接。
 *
 * 服务器启动方式同 maps-http / http-content-maps：vi.hoisted 置 PORT=0；
 * SAVE_DIR 指向空临时目录（避免读到旧存档导致常驻房间创建失败）。
 */
import http from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { matchMaker } from "@colyseus/core";

import { bootstrapFramework } from "framework/bootstrap";
import { loadGameDefinition } from "framework/bootstrap/loadGameDefinition";
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

/** /maps/runtime 全量响应（既有形状）。 */
interface RuntimeFull {
  key: string;
  grid: { width: number; height: number; tileWidth: number; tileHeight: number };
  tiles: number[];
  walkable: number[];
  level: number[];
  regions: Record<string, { name: string; meta: Record<string, unknown> }>;
  regionOfTile: number[];
  version: string;
}

/** /maps/runtime 未变响应。 */
interface RuntimeUnchanged {
  key: string;
  version: string;
  unchanged: true;
}

/** /maps/runtime 增量响应。 */
interface RuntimeDelta {
  key: string;
  version: string;
  baseVersion: string;
  modifications: Array<{ tileIndex: number; field: "tiles" | "walkable" | "level"; value: number }>;
}

/** /maps/render 响应。 */
interface RenderView {
  key: string;
  baseVersion: string;
  renderVersion: string;
  phaseId: string;
  phaseProgress: number;
  tiles: number[];
}

/** /maps/collision 响应。 */
interface CollisionView {
  key: string;
  version: string;
  level: number;
  grid: { width: number; height: number; tileWidth: number; tileHeight: number };
  walkable: number[];
  occupants: Array<{
    networkId: number;
    kind: string;
    cells: number[];
    level: number;
    role: string;
  }>;
}

/** /world/map-graph 响应。 */
interface WorldMapGraph {
  maps: Array<{
    id: string;
    displayName: string;
    connections: Array<{ to: string; kind: string; x?: number; y?: number }>;
  }>;
}

let colyseus: ColyseusServer | undefined;
let baseUrl = "";
let roomId = "";
let gameDef: ReturnType<typeof loadGameDefinition>;

/** 增量测试使用的写回格（island 192×192，索引有效）。 */
const WRITE_TILE = 12345;

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
    const room = rooms.find((r) => r.roomId);
    if (room) return room.roomId;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error("常驻房间未创建");
}

/** GET /maps/runtime（可带 sinceVersion），返回解析体 + 版本响应头。 */
async function getRuntime(
  mapId: string,
  sinceVersion?: string,
): Promise<{ status: number; body: unknown; versionHeader: string | null }> {
  const params = new URLSearchParams({ mapId });
  if (sinceVersion !== undefined) params.set("sinceVersion", sinceVersion);
  const res = await fetch(`${baseUrl}/maps/runtime?${params.toString()}`);
  return {
    status: res.status,
    body: (await res.json()) as unknown,
    versionHeader: res.headers.get("x-map-version"),
  };
}

/** 经房间写回单格地面语义（terrainWriteback 唯一入口）。 */
async function writeGround(tileIndex: number, semanticId: number): Promise<boolean> {
  // 与 http-content-maps 同款远程调用形态（GameRoom 方法按字符串名暴露）。
  const room = matchMaker as unknown as {
    remoteRoomCall<T>(roomId: string, method: string, args?: unknown[]): Promise<T>;
  };
  return room.remoteRoomCall<boolean>(roomId, "debugWriteGround", [
    "island",
    tileIndex,
    semanticId,
  ]);
}

beforeAll(async () => {
  bootstrapFramework();
  gameDef = loadGameDefinition({ gameJsonPath: "game/game.json" });

  // 空存档目录：房间从出厂几何启动，增量基线与测试侧预期一致。
  process.env.SAVE_DIR = mkdtempSync(join(tmpdir(), "maps-delta-http-saves-"));

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

describe("GET /maps/runtime：全量 / 未变 / 增量", () => {
  it("无 sinceVersion → 旧全量形状；x-map-version = body.version", async () => {
    const { status, body, versionHeader } = await getRuntime("island");
    expect(status).toBe(200);
    const full = body as RuntimeFull;
    expect(full.key).toBe("island");
    expect(full.grid).toEqual({ width: 192, height: 192, tileWidth: 16, tileHeight: 16 });
    expect(full.tiles).toHaveLength(192 * 192);
    expect(full.walkable).toHaveLength(192 * 192);
    expect(full.level).toHaveLength(192 * 192);
    expect(Object.keys(full.regions).length).toBeGreaterThan(0);
    expect(full.regionOfTile).toHaveLength(192 * 192);
    expect(full.version).toMatch(/^[0-9a-f]{8}$/);
    expect(versionHeader).toBe(full.version);
    // 旧客户端依赖的顶层字段确实还在（增量/未变响应不破坏此路径）
    expect(full).not.toHaveProperty("modifications");
    expect(full).not.toHaveProperty("unchanged");
  });

  it("sinceVersion === 当前版本 → {key,version,unchanged:true}", async () => {
    const full = (await getRuntime("island")).body as RuntimeFull;
    const { status, body, versionHeader } = await getRuntime("island", full.version);
    expect(status).toBe(200);
    expect(body).toEqual({ key: "island", version: full.version, unchanged: true });
    expect((body as RuntimeUnchanged).unchanged).toBe(true);
    expect(versionHeader).toBe(full.version);
  });

  it("已知基线版本 → 稀疏终态增量；多次写回只保留最后值（last-write-wins）", async () => {
    const before = (await getRuntime("island")).body as RuntimeFull;
    const baseVersion = before.version;
    const baseTile = before.tiles[WRITE_TILE];
    expect(baseTile).not.toBe(42);

    // 第一次写回：增量只含该格
    expect(await writeGround(WRITE_TILE, 42)).toBe(true);
    const first = await getRuntime("island", baseVersion);
    expect(first.status).toBe(200);
    const delta1 = first.body as RuntimeDelta;
    expect(delta1.key).toBe("island");
    expect(delta1.baseVersion).toBe(baseVersion);
    expect(delta1.version).not.toBe(baseVersion);
    expect(first.versionHeader).toBe(delta1.version);
    expect(delta1.modifications).toEqual([
      { tileIndex: WRITE_TILE, field: "tiles", value: 42 },
    ]);
    for (const mod of delta1.modifications) {
      expect(["tiles", "walkable", "level"]).toContain(mod.field);
    }

    // 同格二次写回：相对基线仍只输出该格终值 43（不是两条记录）
    expect(await writeGround(WRITE_TILE, 43)).toBe(true);
    const second = await getRuntime("island", baseVersion);
    const delta2 = second.body as RuntimeDelta;
    expect(delta2.baseVersion).toBe(baseVersion);
    expect(delta2.modifications).toEqual([
      { tileIndex: WRITE_TILE, field: "tiles", value: 43 },
    ]);
    expect(second.versionHeader).toBe(delta2.version);

    // 历史版本（第一次写回后的版本）→ 只含其后的第二次写回
    const historical = await getRuntime("island", delta1.version);
    expect(historical.status).toBe(200);
    const deltaHist = historical.body as RuntimeDelta;
    expect(deltaHist.baseVersion).toBe(delta1.version);
    expect(deltaHist.modifications).toEqual([
      { tileIndex: WRITE_TILE, field: "tiles", value: 43 },
    ]);
    expect(historical.versionHeader).toBe(deltaHist.version);

    // 全量路径反映 live 终态
    const full = (await getRuntime("island")).body as RuntimeFull;
    expect(full.tiles[WRITE_TILE]).toBe(43);
    expect(full.version).toBe(delta2.version);
  });

  it("未知 sinceVersion → 回退全量（200，不 404）；响应头一致", async () => {
    const { status, body, versionHeader } = await getRuntime("island", "not-a-real-version");
    expect(status).toBe(200);
    const full = body as RuntimeFull;
    expect(full.key).toBe("island");
    expect(full.tiles).toHaveLength(192 * 192);
    expect(full).not.toHaveProperty("modifications");
    expect(full).not.toHaveProperty("unchanged");
    expect(versionHeader).toBe(full.version);
  });

  it("未知 mapId 仍 404（增量参数不改变地图解析口径）", async () => {
    const res = await fetch(`${baseUrl}/maps/runtime?mapId=does-not-exist&sinceVersion=x`);
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string; available: string[] };
    expect(body.error).toBe("unknown map");
    expect(body.available).toContain("island");
  });
});

describe("GET /maps/render：有效地面", () => {
  it("形状/长度/renderVersion；live 写回格进入有效地面，非覆盖语义格与底板一致", async () => {
    const runtime = (await getRuntime("island")).body as RuntimeFull;
    const res = await fetch(`${baseUrl}/maps/render?mapId=island`);
    expect(res.status).toBe(200);
    const view = (await res.json()) as RenderView;

    expect(view.key).toBe("island");
    expect(view.baseVersion).toBe(runtime.version);
    expect(view.renderVersion).toMatch(/^[0-9a-f]{8}$/);
    expect(typeof view.phaseId).toBe("string");
    expect(view.phaseProgress).toBeGreaterThanOrEqual(0);
    expect(view.phaseProgress).toBeLessThanOrEqual(1);
    expect(view.tiles).toHaveLength(192 * 192);
    expect(res.headers.get("x-map-version")).toBe(view.baseVersion);

    // 写回格在有效地面中同样反映 live 底板（42 不在 groundOverrides 的 from 集内）。
    expect(runtime.tiles[WRITE_TILE]).toBe(43);
    expect(view.tiles[WRITE_TILE]).toBe(43);

    // 抽样：不走覆盖的底板语义（2/3/4 之外的 id）有效地面 = 底板值。
    let sampled = 0;
    for (let i = 0; i < runtime.tiles.length && sampled < 25; i += 1777) {
      const base = runtime.tiles[i]!;
      if (base === 2 || base === 3 || base === 4) continue;
      expect(view.tiles[i]).toBe(base);
      sampled += 1;
    }
    expect(sampled).toBeGreaterThan(0);
  });

  it("缺省 mapId → 默认图；未知 mapId → 404", async () => {
    const res = await fetch(`${baseUrl}/maps/render`);
    expect(res.status).toBe(200);
    expect(((await res.json()) as RenderView).key).toBe(gameDef.map?.default ?? "island");

    const unknown = await fetch(`${baseUrl}/maps/render?mapId=no-such-map`);
    expect(unknown.status).toBe(404);
    expect(((await unknown.json()) as { error: string }).error).toBe("unknown map");
  });
});

describe("GET /maps/collision：正式碰撞/占用", () => {
  it("walkable 长度与取值；房屋墙/楼板进入 occupants，实体只用 networkId", async () => {
    // 地图静态房屋由 entity-rules 刷出；房间首 tick 后即存在，短暂轮询兜底。
    let view: CollisionView | undefined;
    let versionHeader: string | null = null;
    for (let attempt = 0; attempt < 40; attempt += 1) {
      const res = await fetch(`${baseUrl}/maps/collision?mapId=island&level=0`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as CollisionView;
      if (body.occupants.length > 0) {
        view = body;
        versionHeader = res.headers.get("x-map-version");
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    expect(view, "island 上应有 entity-rules 刷出的房屋墙/楼板").toBeDefined();

    const collision = view!;
    expect(collision.key).toBe("island");
    expect(collision.level).toBe(0);
    expect(collision.grid).toEqual({ width: 192, height: 192, tileWidth: 16, tileHeight: 16 });
    expect(collision.walkable).toHaveLength(192 * 192);
    expect(collision.walkable.every((v) => v === 0 || v === 1)).toBe(true);
    expect(versionHeader).toBe(collision.version);
    expect(collision.version).toMatch(/^[0-9a-f]{8}$/);

    // 占用包含墙/楼板（house 模板），每项都是 networkId 引用 + 格列表 + 层号。
    const kinds = new Set(collision.occupants.map((occupant) => occupant.kind));
    expect(kinds.has("wall") || kinds.has("floor")).toBe(true);
    for (const occupant of collision.occupants) {
      expect(Number.isInteger(occupant.networkId)).toBe(true);
      expect(occupant.networkId).toBeGreaterThan(0);
      expect(typeof occupant.kind).toBe("string");
      expect(occupant.kind.length).toBeGreaterThan(0);
      expect(occupant.level).toBe(0);
      expect(occupant.cells.length).toBeGreaterThan(0);
      for (const tileIndex of occupant.cells) {
        expect(Number.isInteger(tileIndex)).toBe(true);
        expect(tileIndex).toBeGreaterThanOrEqual(0);
        expect(tileIndex).toBeLessThan(192 * 192);
      }
      // 绝不泄露 eid
      expect(occupant).not.toHaveProperty("eid");
    }
  });

  it("level 缺省为 0；非法 level 按 0；未知 mapId 404", async () => {
    const defaultLevel = (await (
      await fetch(`${baseUrl}/maps/collision?mapId=island`)
    ).json()) as CollisionView;
    expect(defaultLevel.level).toBe(0);

    const weird = (await (
      await fetch(`${baseUrl}/maps/collision?mapId=island&level=not-a-number`)
    ).json()) as CollisionView;
    expect(weird.level).toBe(0);

    const unknown = await fetch(`${baseUrl}/maps/collision?mapId=no-such-map`);
    expect(unknown.status).toBe(404);
  });
});

describe("GET /world/map-graph", () => {
  it("registry 8 图 + presentation 展示名/连接", async () => {
    const res = await fetch(`${baseUrl}/world/map-graph`);
    expect(res.status).toBe(200);
    const graph = (await res.json()) as WorldMapGraph;
    expect(graph.maps.map((map) => map.id)).toEqual([
      "island",
      "cave",
      "tiled-demo",
      "swamp",
      "ruins",
      "highlands",
      "island-v2",
      "building-demo",
    ]);

    const island = graph.maps.find((map) => map.id === "island")!;
    expect(island.displayName).toBe("荒岛");
    expect(island.connections).toEqual(
      expect.arrayContaining([
        { to: "cave", kind: "portal", x: 96, y: 96 },
        { to: "swamp", kind: "portal", x: 140, y: 166 },
      ]),
    );
    // 无 presentation 条目时至少回退 registry id（当前配置每图都有条目）。
    expect(graph.maps.every((map) => map.displayName.length > 0)).toBe(true);
  });
});
