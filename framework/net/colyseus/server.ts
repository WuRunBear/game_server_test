/**
 * Colyseus 服务端装配：创建 WebSocket 传输层、注册单房间类型
 * （game）、启动一个常驻房间，并挂载少量静态/调试 HTTP 端点
 * （/health、/client/manifest、/content、/maps/runtime、/maps/meta、
 * /debug/colliders）。游戏逻辑全部在仿真层，本文件只负责把 Colyseus 接到
 * GameRoom 上。
 */
import http from "node:http";

import { Server, matchMaker } from "@colyseus/core";
import { WebSocketTransport } from "@colyseus/ws-transport";

import { getRegistries } from "framework/bootstrap";
import { loadGameDefinition } from "framework/bootstrap/loadGameDefinition";
import type { MapConfig } from "framework/config/schema/MapRegistrySchema";
import { serverConfig } from "config";
import { buildMapGeometry } from "map/generate/pipeline";
import {
  deserializeGeometry,
  serializeGeometry,
  type SerializedMapGeometry,
} from "map/geometry/snapshot";
import { describeGeometry, type GeometryMetaInfo } from "map/geometry/version";
import type { MapGeometry } from "map/geometry/types";
import {
  buildMapCollisionViewFromGeometry,
  buildMapDecorView,
  buildMapRenderViewForGeometry,
  buildWorldMapGraph,
  type MapCollisionView,
  type MapDecorView,
  type MapRenderView,
} from "map/clientView";
import type { TerrainModificationSet } from "map/runtime/terrainWriteback";
import type { EnvironmentRule } from "framework/config/schema/RuleSchema";
import { buildContentCatalog } from "framework/content/catalog";
import { getPresentationRevision } from "framework/content/presentation";
import { buildClientManifest } from "framework/content/manifest";
import { GameRoom } from "network/colyseus/rooms/GameRoom";
import type { Logger } from "utils/logger";

/**
 * `If-None-Match` 与当前强 ETag 的比较（RFC 7232 weak comparison）。
 *
 * 支持逗号分隔列表与 `*`；忽略客户端带来的 `W/` 弱前缀（服务端 ETag 恒为
 * 强 ETag）。任何候选命中即视为未修改。
 */
function ifNoneMatchHit(header: unknown, etag: string): boolean {
  const raw = Array.isArray(header) ? header.join(",") : header;
  if (typeof raw !== "string" || raw.trim().length === 0) return false;
  if (raw.trim() === "*") return true;

  const target = etag.startsWith("W/") ? etag.slice(2) : etag;
  return raw.split(",").some((candidate) => {
    const trimmed = candidate.trim();
    if (!trimmed) return false;
    return (trimmed.startsWith("W/") ? trimmed.slice(2) : trimmed) === target;
  });
}

/**
 * 查询端点统一结果信封（与 framework/query/types 的 QueryResult 对应）。
 */
type QueryEnvelope =
  | { ok: true; data: unknown }
  | { ok: false; error: string };

/** POST /query/* 的 JSON body 上限（查询参数很小，防滥用）。 */
const QUERY_BODY_LIMIT_BYTES = 64 * 1024;

/**
 * 读取 JSON 请求体（Express 5 的 travel 未挂 body parser，这里手工解析，
 * 不新增依赖）。空体/非 JSON/超限均返回 ok:false（HTTP 400）。
 */
async function readJsonBody(
  req: unknown,
  limit = QUERY_BODY_LIMIT_BYTES,
): Promise<{ ok: true; value: unknown } | { ok: false }> {
  try {
    const stream = req as AsyncIterable<unknown>;
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of stream) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
      size += buffer.length;
      if (size > limit) return { ok: false };
      chunks.push(buffer);
    }
    if (size === 0) return { ok: false };
    return { ok: true, value: JSON.parse(Buffer.concat(chunks).toString("utf8")) };
  } catch {
    return { ok: false };
  }
}

/** 解析必填正整数 query 参数（缺失/非法 → undefined）。 */
function readPositiveInt(raw: unknown): number | undefined {
  if (typeof raw !== "string" || raw.trim() === "") return undefined;
  const value = Number(raw);
  return Number.isInteger(value) && value > 0 ? value : undefined;
}

/** 解析可选有限数 query 参数（缺失 → undefined；非法 → null）。 */
function readFiniteNumber(raw: unknown): number | undefined | null {
  if (raw === undefined) return undefined;
  if (typeof raw !== "string" || raw.trim() === "") return null;
  const value = Number(raw);
  return Number.isFinite(value) ? value : null;
}

/** 解析可选整数 query 参数（缺失 → undefined；非法 → null）。 */
function readInteger(raw: unknown): number | undefined | null {
  if (raw === undefined) return undefined;
  if (typeof raw !== "string" || raw.trim() === "") return null;
  const value = Number(raw);
  return Number.isInteger(value) ? value : null;
}

/** 普通对象判定（POST body）。 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** POST body 必填正整数。 */
function bodyPositiveInt(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : undefined;
}

/** POST body 必填有限数。 */
function bodyFiniteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** POST body 必填非负整数（slot 等索引）。 */
function bodyNonNegativeInt(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : undefined;
}

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
  /** /maps/decor：live 几何版本不变时复用点集，避免每次请求反序列化全图。 */
  const decorViewCache = new Map<string, { view: MapDecorView; revision: number }>();
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

  // /client/manifest 数据源：启动期配置解析完成后即不可变，首次请求构建一次并
  // 缓存序列化结果（不参与 tick；不阻塞房间）。
  let clientManifestCache: { body: string; etag: string } | undefined;
  const clientManifestOf = (): { body: string; etag: string } => {
    if (!clientManifestCache) {
      const manifest = buildClientManifest(gameDef);
      clientManifestCache = {
        body: JSON.stringify(manifest),
        etag: `"${manifest.contentVersion}"`,
      };
    }
    return clientManifestCache;
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

  /** 环境规则（无 environment 规则 → undefined；回退视图用同一规则派生）。 */
  const environmentRuleOf = (): EnvironmentRule | undefined =>
    gameDef.resolvedRules["environment"] as EnvironmentRule | undefined;

  /** 取常驻房间内某图的当前有效地面视图（房间未就绪/图不存在 → undefined）。 */
  const liveRenderViewOf = async (mapId: string): Promise<MapRenderView | undefined> => {
    if (!persistentRoomId) return undefined;
    try {
      const result = await matchMaker.remoteRoomCall<GameRoom>(
        persistentRoomId,
        "getMapRenderView",
        [mapId],
      );
      return (result as MapRenderView | null | undefined) ?? undefined;
    } catch {
      return undefined;
    }
  };

  /** 取常驻房间内某图某层的碰撞视图（房间未就绪/图不存在 → undefined）。 */
  const liveCollisionViewOf = async (
    mapId: string,
    level: number,
  ): Promise<MapCollisionView | undefined> => {
    if (!persistentRoomId) return undefined;
    try {
      const result = await matchMaker.remoteRoomCall<GameRoom>(
        persistentRoomId,
        "getMapCollisionView",
        [mapId, level],
      );
      return (result as MapCollisionView | null | undefined) ?? undefined;
    } catch {
      return undefined;
    }
  };

  /**
   * 取某图装饰视图（/maps/decor 数据源）。
   *
   * 优先 live 几何（含运行期写回 → version 变化）；同一版本复用点集缓存，
   * 避免每次请求反序列化整图。无房间时回退按配置重建的几何（与
   * /maps/render、/maps/collision 同一回退口径）。
   */
  const decorViewOf = async (config: MapConfig): Promise<MapDecorView> => {
    await waitForRoom();
    const live = await liveGeometryOf(config.key);
    if (live) {
      const revision = getPresentationRevision();
      const cached = decorViewCache.get(config.key);
      if (cached && cached.view.version === live.version && cached.revision === revision) {
        return cached.view;
      }
      const view = buildMapDecorView(deserializeGeometry(live));
      decorViewCache.set(config.key, { view, revision });
      return view;
    }
    return buildMapDecorView(geometryOf(config));
  };

  /** 取常驻房间内某图从已知版本到当前的增量（不可识别/房间未就绪 → undefined）。 */
  const liveMapDeltaOf = async (
    mapId: string,
    sinceVersion: string,
  ): Promise<TerrainModificationSet | undefined> => {
    if (!persistentRoomId) return undefined;
    try {
      const result = await matchMaker.remoteRoomCall<GameRoom>(
        persistentRoomId,
        "getMapRuntimeDelta",
        [mapId, sinceVersion],
      );
      return (result as TerrainModificationSet | null | undefined) ?? undefined;
    } catch {
      return undefined;
    }
  };

  /**
   * CC-06：调用常驻房间的只读查询入口。
   *
   * 房间未就绪（启动 5s 内未创建成功）或远程调用失败 → null（端点 503）。
   * 查询本身不推进 tick、不写状态；这里只是传输层转发。
   */
  const liveQueryOf = async (method: keyof GameRoom, args: unknown[]): Promise<QueryEnvelope | null> => {
    if (!persistentRoomId) await waitForRoom();
    if (!persistentRoomId) return null;
    try {
      const result = await matchMaker.remoteRoomCall<GameRoom>(persistentRoomId, method, args);
      return (result as QueryEnvelope | null | undefined) ?? null;
    } catch {
      return null;
    }
  };

  /** 统一发送查询结果（404 仅用于「对象不存在」；业务不可用原因在 data.reason）。 */
  const sendQueryResult = (res: any, result: QueryEnvelope | null): void => {
    res.setHeader("Cache-Control", "no-store");
    if (!result) {
      res.status(503).json({ error: "room_not_ready" });
      return;
    }
    if (!result.ok) {
      res.status(404).json({ error: result.error });
      return;
    }
    res.status(200).json(result.data);
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

      // 客户端静态契约（一次性拉取地图/图块语义/实体表现/物品/规则/netSync）。
      // 版本即强 ETag（内容哈希）：配置启动后不变，故首次构建后缓存；
      // `Cache-Control: no-cache` 要求客户端每次带 If-None-Match 复验。
      app.get("/client/manifest", (req: any, res: any) => {
        const manifest = clientManifestOf();
        res.setHeader("ETag", manifest.etag);
        res.setHeader("Cache-Control", "no-cache");

        if (ifNoneMatchHit(req.headers?.["if-none-match"], manifest.etag)) {
          res.status(304).end();
          return;
        }

        res.status(200);
        res.setHeader("Content-Type", "application/json; charset=utf-8");
        res.send(manifest.body);
      });

      // 内容目录（静态表的服务端单一来源）：客户端一次拉取即拿到当前
      // game/ 配置的物品/配方/任务/成就/相位/技能清单——不必硬编码。
      app.get("/content", (_req: any, res: any) => {
        res.status(200).json(buildContentCatalog(gameDef));
      });

      /* ---------------------------------------------------------------- */
      /* CC-06 只读查询面（全部经常驻房间的 live ECS 世界求值）              */
      /* ---------------------------------------------------------------- */

      app.get("/query/affordances", async (req: any, res: any) => {
        const player = readPositiveInt(req.query?.player);
        if (player === undefined) {
          res.status(400).json({ error: "invalid" });
          return;
        }

        const x = readFiniteNumber(req.query?.x);
        const y = readFiniteNumber(req.query?.y);
        // 坐标必须成对出现；非法数字/只给一边 → 400
        if (x === null || y === null || (x === undefined) !== (y === undefined)) {
          res.status(400).json({ error: "invalid" });
          return;
        }

        const level = readInteger(req.query?.level);
        if (level === null) {
          res.status(400).json({ error: "invalid" });
          return;
        }

        const radius = readFiniteNumber(req.query?.radius);
        if (radius === null || (radius !== undefined && radius < 0)) {
          res.status(400).json({ error: "invalid" });
          return;
        }

        sendQueryResult(
          res,
          await liveQueryOf("getQueryAffordances", [
            {
              playerNetworkId: player,
              ...(x !== undefined && y !== undefined ? { x, y } : {}),
              ...(level !== undefined ? { level } : {}),
              ...(radius !== undefined ? { radius } : {}),
            },
          ]),
        );
      });

      app.post("/query/place", async (req: any, res: any) => {
        const body = await readJsonBody(req);
        if (!body.ok || !isRecord(body.value)) {
          res.status(400).json({ error: "invalid" });
          return;
        }
        const player = bodyPositiveInt(body.value.player);
        const slot = bodyNonNegativeInt(body.value.slot);
        const x = bodyFiniteNumber(body.value.x);
        const y = bodyFiniteNumber(body.value.y);
        if (player === undefined || slot === undefined || x === undefined || y === undefined) {
          res.status(400).json({ error: "invalid" });
          return;
        }

        sendQueryResult(
          res,
          await liveQueryOf("getQueryPlace", [{ playerNetworkId: player, slot, x, y }]),
        );
      });

      app.post("/query/craft", async (req: any, res: any) => {
        const body = await readJsonBody(req);
        if (!body.ok || !isRecord(body.value)) {
          res.status(400).json({ error: "invalid" });
          return;
        }
        const player = bodyPositiveInt(body.value.player);
        const recipeId = body.value.recipeId;
        if (player === undefined || typeof recipeId !== "string" || recipeId.length === 0) {
          res.status(400).json({ error: "invalid" });
          return;
        }

        sendQueryResult(
          res,
          await liveQueryOf("getQueryCraft", [{ playerNetworkId: player, recipeId }]),
        );
      });

      app.get("/query/shop", async (req: any, res: any) => {
        const player = readPositiveInt(req.query?.player);
        const npc = readPositiveInt(req.query?.npc);
        if (player === undefined || npc === undefined) {
          res.status(400).json({ error: "invalid" });
          return;
        }

        sendQueryResult(
          res,
          await liveQueryOf("getQueryShop", [{ playerNetworkId: player, npcNetworkId: npc }]),
        );
      });

      app.get("/query/quests", async (req: any, res: any) => {
        const player = readPositiveInt(req.query?.player);
        if (player === undefined) {
          res.status(400).json({ error: "invalid" });
          return;
        }
        sendQueryResult(res, await liveQueryOf("getQueryQuests", [player]));
      });

      app.get("/query/achievements", async (req: any, res: any) => {
        const player = readPositiveInt(req.query?.player);
        if (player === undefined) {
          res.status(400).json({ error: "invalid" });
          return;
        }
        sendQueryResult(res, await liveQueryOf("getQueryAchievements", [player]));
      });

      app.get("/query/skills", async (req: any, res: any) => {
        const player = readPositiveInt(req.query?.player);
        if (player === undefined) {
          res.status(400).json({ error: "invalid" });
          return;
        }
        sendQueryResult(res, await liveQueryOf("getQuerySkills", [player]));
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

        // 增量基准：缺省/空串 = 旧全量行为；非字符串（数组等）按缺省处理。
        const rawSinceVersion = req.query?.sinceVersion;
        const sinceVersion =
          typeof rawSinceVersion === "string" && rawSinceVersion.length > 0
            ? rawSinceVersion
            : undefined;

        // 优先读**活动房间的 live 几何**（含运行期写回，如野火焦土）；
        // 无房间（房间未就绪/创建失败）时回退到按配置重建的视图。
        await waitForRoom();
        const live = await liveGeometryOf(config.key);
        const snapshot = live ?? serializeGeometry(geometryOf(config));
        res.setHeader("x-map-version", snapshot.version);

        // 无 sinceVersion：保持旧全量响应形状（HTML 客户端/既有测试不破）。
        if (sinceVersion === undefined) {
          res.status(200).json(snapshot);
          return;
        }

        // 已是最新：只回版本确认，不带 14 万个数。
        if (sinceVersion === snapshot.version) {
          res.status(200).json({
            key: snapshot.key,
            version: snapshot.version,
            unchanged: true,
          });
          return;
        }

        // 已知基线/历史版本 → 稀疏终态增量（tiles|walkable|level）。
        // 只有 live 世界持有出厂底板/写回历史；无房间或版本不可识别时回退全量
        // （不回 404，客户端按全量结果重建缓存即可）。
        const delta = live ? await liveMapDeltaOf(config.key, sinceVersion) : undefined;
        if (delta) {
          // 以增量计算时的当前版本为准（两次远程读取之间若有写回，终态与版本
          // 仍自洽；响应头同步覆盖为同一版本）。
          res.setHeader("x-map-version", delta.version);
          res.status(200).json({
            key: snapshot.key,
            version: delta.version,
            baseVersion: delta.baseVersion,
            modifications: delta.modifications,
          });
          return;
        }

        res.status(200).json(snapshot);
      });

      // 当前 tick 的有效地面（相位/天气派生，查询期计算，不写回底板）。
      // renderVersion = hash(baseVersion + phaseId + 量化进度 + 有效 tiles)，
      // 客户端按此缓存；无 room 时用配置重建几何 + environment 规则（tick 0）。
      app.get("/maps/render", async (req: any, res: any) => {
        const rawMapId = req.query?.mapId;
        const mapId = typeof rawMapId === "string" ? rawMapId : undefined;
        const config = gameDef.resolvedMapConfigs.find(
          (c) => c.key === (mapId !== undefined ? mapId : defaultMapId),
        );
        if (!config) {
          res.status(404).json({ error: "unknown map", available: mapIds });
          return;
        }

        await waitForRoom();
        const view =
          (await liveRenderViewOf(config.key)) ??
          buildMapRenderViewForGeometry(geometryOf(config), environmentRuleOf(), 0);
        res.setHeader("x-map-version", view.baseVersion);
        res.status(200).json(view);
      });

      // 正式碰撞视图：该层静态通行位 + 建造物占用（实体引用 = networkId）。
      // 通行判定与碰撞运行时同源（walkableAtLevel + collectBuiltStructures），
      // 不是 /debug/colliders 的调试形状。
      app.get("/maps/collision", async (req: any, res: any) => {
        const rawMapId = req.query?.mapId;
        const mapId = typeof rawMapId === "string" ? rawMapId : undefined;
        const config = gameDef.resolvedMapConfigs.find(
          (c) => c.key === (mapId !== undefined ? mapId : defaultMapId),
        );
        if (!config) {
          res.status(404).json({ error: "unknown map", available: mapIds });
          return;
        }

        // level 缺省 0；非法/小数按 0（与 /debug/colliders 的宽松口径一致）。
        const rawLevel = req.query?.level;
        const parsed = typeof rawLevel === "string" && rawLevel.trim() !== "" ? Number(rawLevel) : 0;
        const level = Number.isFinite(parsed) ? Math.trunc(parsed) : 0;

        await waitForRoom();
        const view =
          (await liveCollisionViewOf(config.key, level)) ??
          buildMapCollisionViewFromGeometry(geometryOf(config), level);
        res.setHeader("x-map-version", view.version);
        res.status(200).json(view);
      });

      // 世界地图图：registry 图集合 + presentation 的展示名/连接。
      app.get("/world/map-graph", (_req: any, res: any) => {
        res.status(200).json(buildWorldMapGraph(gameDef));
      });

      // 装饰点集（CC-13）：确定性、只读、非实体、不参与碰撞、不写几何。
      // 默认全量（row-major 稳定序）；x-map-version 与 /maps/runtime 同源。
      app.get("/maps/decor", async (req: any, res: any) => {
        const rawMapId = req.query?.mapId;
        const mapId = typeof rawMapId === "string" ? rawMapId : undefined;
        const config = gameDef.resolvedMapConfigs.find(
          (c) => c.key === (mapId !== undefined ? mapId : defaultMapId),
        );
        if (!config) {
          res.status(404).json({ error: "unknown map", available: mapIds });
          return;
        }

        const view = await decorViewOf(config);
        res.setHeader("x-map-version", view.version);
        res.setHeader("Cache-Control", "no-store");
        res.status(200).json(view);
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
