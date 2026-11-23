/**
 * CC-06 `/query/*` HTTP 契约测试。
 *
 * 覆盖：七个端点的正常响应形状；未知 player/npc/recipe → 404；
 * 非法参数/非法 JSON → 400；空结果（radius=0 / 非商店 NPC）；查询 body
 * 解析不破坏现有端点（顺带 /health）。
 */
import http from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { query } from "bitecs";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import {
  bootstrapFramework,
  getRegistries,
  spawnEntity,
} from "framework/index";
import { matchMaker } from "@colyseus/core";
import { getLocalRoomById } from "@colyseus/core/MatchMaker";
import { Inventory, NetworkId, Player, Transform, entityMapOf } from "components";
import { entityLevelOf } from "framework/components/entityLevel";
import type { ColyseusServer } from "framework/net/colyseus/server";
import type { GameRoom } from "framework/net/colyseus/rooms/GameRoom";
import type { GameWorld } from "world";
import type { SimulationPort } from "framework/simulation/SimulationPort";
import type { Logger } from "utils/logger";

vi.hoisted(() => {
  process.env.PORT = "0";
});

const stubLogger: Logger = {
  info: () => {},
  warn: () => {},
  error: () => {},
};

let colyseus: ColyseusServer | undefined;
let baseUrl = "";
let playerNetworkId = 0;
let treeNetworkId = 0;
let villagerNetworkId = 0;

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

async function waitForRoom(): Promise<GameRoom> {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    const rooms = await matchMaker.query({});
    if (rooms.length > 0) {
      const room = getLocalRoomById(rooms[0]!.roomId) as GameRoom | undefined;
      if (room && (room as unknown as { sim?: SimulationPort }).sim) return room;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error("常驻房间未创建");
}

async function getJson(path: string): Promise<{ status: number; body: any }> {
  const res = await fetch(`${baseUrl}${path}`);
  return { status: res.status, body: await res.json() };
}

async function postJson(path: string, body: unknown): Promise<{ status: number; body: any }> {
  const res = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

beforeAll(async () => {
  bootstrapFramework();
  process.env.SAVE_DIR = mkdtempSync(join(tmpdir(), "query-http-saves-"));

  const serverModule = await import("framework/net/colyseus/server");
  colyseus = serverModule.startColyseusServer({ logger: stubLogger });
  await waitForListen(colyseus.httpServer);
  const addr = colyseus.httpServer.address();
  if (!addr || typeof addr === "string") throw new Error("测试服务器未监听任何端口");
  baseUrl = `http://127.0.0.1:${addr.port}`;

  const room = await waitForRoom();
  const sim = (room as unknown as { sim: SimulationPort }).sim;
  const world = (sim as unknown as { world: GameWorld }).world;

  const joined = sim.addPlayer("http-s1");
  playerNetworkId = joined.networkId;
  const playerEid = query(world, [Player])[0]!;
  Inventory[playerEid] = {
    capacity: 8,
    slots: [
      { kind: "campfire_kit", count: 1 },
      { kind: "wood", count: 2 },
      null,
      null,
      null,
      null,
      null,
      null,
    ],
  };

  const mapId = entityMapOf(world, playerEid);
  const level = entityLevelOf(playerEid);
  const px = Transform.x[playerEid];
  const py = Transform.y[playerEid];
  const registry = getRegistries().componentRegistry;
  const tree = spawnEntity(world, world.archetypes.get("berry_bush"), registry, {
    x: px + 8,
    y: py,
    mapId,
    level,
  });
  treeNetworkId = NetworkId.value[tree];
  const villager = spawnEntity(world, world.archetypes.get("villager"), registry, {
    x: px + 10,
    y: py,
    mapId,
    level,
  });
  villagerNetworkId = NetworkId.value[villager];
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

describe("GET /query/affordances", () => {
  it("正常路径：候选实体 + 动作（gather 可用）；radius=0 空结果", async () => {
    const res = await getJson(`/query/affordances?player=${playerNetworkId}&radius=256`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.entities)).toBe(true);
    const tree = res.body.entities.find((entity: any) => entity.networkId === treeNetworkId);
    expect(tree).toBeDefined();
    expect(tree.actions.find((action: any) => action.id === "gather")).toMatchObject({
      available: true,
    });
    expect(JSON.stringify(res.body)).not.toContain("eid");

    const empty = await getJson(`/query/affordances?player=${playerNetworkId}&radius=0`);
    expect(empty.status).toBe(200);
    expect(empty.body).toEqual({ entities: [] });
  });

  it("未知玩家 → 404；缺 player / 非法坐标 → 400", async () => {
    expect(await getJson("/query/affordances?player=999999")).toEqual({
      status: 404,
      body: { error: "player_not_found" },
    });
    expect((await getJson("/query/affordances")).status).toBe(400);
    expect((await getJson(`/query/affordances?player=${playerNetworkId}&x=abc`)).status).toBe(400);
    expect((await getJson(`/query/affordances?player=${playerNetworkId}&x=1`)).status).toBe(400);
    expect(
      (await getJson(`/query/affordances?player=${playerNetworkId}&level=1.5`)).status,
    ).toBe(400);
    expect(
      (await getJson(`/query/affordances?player=${playerNetworkId}&radius=-1`)).status,
    ).toBe(400);
  });
});

describe("POST /query/place", () => {
  it("正常路径：footprint/cells/occupiedBy；未知玩家 404；非法参数/JSON 400", async () => {
    const res = await postJson("/query/place", {
      player: playerNetworkId,
      slot: 0,
      x: 0,
      y: 0,
    });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ footprint: { w: 24, h: 24 } });
    expect(Array.isArray(res.body.cells)).toBe(true);
    expect(Array.isArray(res.body.occupiedBy)).toBe(true);
    expect(JSON.stringify(res.body)).not.toContain("eid");

    expect(
      await postJson("/query/place", { player: 999999, slot: 0, x: 0, y: 0 }),
    ).toEqual({ status: 404, body: { error: "player_not_found" } });
    expect((await postJson("/query/place", { player: playerNetworkId })).status).toBe(400);
    expect(
      (await postJson("/query/place", { player: playerNetworkId, slot: -1, x: 0, y: 0 })).status,
    ).toBe(400);

    const badJson = await fetch(`${baseUrl}/query/place`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{not-json",
    });
    expect(badJson.status).toBe(400);
    const emptyBody = await fetch(`${baseUrl}/query/place`, { method: "POST" });
    expect(emptyBody.status).toBe(400);
  });
});

describe("POST /query/craft", () => {
  it("正常路径（缺料/可用）+ 未知配方/玩家 404 + 非法参数 400", async () => {
    const missing = await postJson("/query/craft", {
      player: playerNetworkId,
      recipeId: "stone_axe",
    });
    expect(missing.status).toBe(200);
    expect(missing.body.available).toBe(false);
    expect(missing.body.reason).toBe("no_item");
    expect(missing.body.missing.length).toBeGreaterThan(0);

    const available = await postJson("/query/craft", {
      player: playerNetworkId,
      recipeId: "wood_axe",
    });
    expect(available.status).toBe(200);
    expect(available.body).toMatchObject({ available: true, unlocked: true, durationTicks: 0 });

    expect(
      await postJson("/query/craft", { player: playerNetworkId, recipeId: "nope" }),
    ).toEqual({ status: 404, body: { error: "recipe_not_found" } });
    expect(
      await postJson("/query/craft", { player: 999999, recipeId: "wood_axe" }),
    ).toEqual({ status: 404, body: { error: "player_not_found" } });
    expect((await postJson("/query/craft", { player: playerNetworkId })).status).toBe(400);
  });
});

describe("GET /query/shop", () => {
  it("正常路径（实价/库存）；非商店 NPC 空结果；未知 NPC/玩家 404；非法参数 400", async () => {
    const res = await getJson(
      `/query/shop?npc=${villagerNetworkId}&player=${playerNetworkId}`,
    );
    expect(res.status).toBe(200);
    expect(res.body.currency).toBe("shell");
    expect(res.body.items.length).toBeGreaterThan(0);
    expect(res.body.items[0]).toMatchObject({ kind: expect.any(String), currency: "shell" });
    expect(typeof res.body.items[0].price).toBe("number");
    expect(typeof res.body.items[0].count).toBe("number");

    const empty = await getJson(`/query/shop?npc=${treeNetworkId}&player=${playerNetworkId}`);
    expect(empty).toEqual({ status: 200, body: { currency: "", items: [] } });

    expect(
      await getJson(`/query/shop?npc=999999&player=${playerNetworkId}`),
    ).toEqual({ status: 404, body: { error: "npc_not_found" } });
    expect(await getJson(`/query/shop?npc=${villagerNetworkId}&player=999999`)).toEqual({
      status: 404,
      body: { error: "player_not_found" },
    });
    expect((await getJson("/query/shop")).status).toBe(400);
  });
});

describe("GET /query/quests|achievements|skills", () => {
  it("正常路径 + 未知玩家 404 + 非法参数 400", async () => {
    const quests = await getJson(`/query/quests?player=${playerNetworkId}`);
    expect(quests.status).toBe(200);
    expect(quests.body.quests).toHaveLength(2);
    expect(quests.body.quests[0]).toMatchObject({ id: "collect_axe", state: 0, count: 0 });

    const achievements = await getJson(`/query/achievements?player=${playerNetworkId}`);
    expect(achievements.status).toBe(200);
    expect(achievements.body.achievements.length).toBeGreaterThan(0);
    expect(achievements.body.achievements[0]).toMatchObject({
      id: expect.any(String),
      condition: expect.any(String),
      unlocked: false,
    });

    const skills = await getJson(`/query/skills?player=${playerNetworkId}`);
    expect(skills.status).toBe(200);
    expect(skills.body.curve).toEqual({ baseXp: 100, growth: 1.5, maxLevel: 20 });
    expect(skills.body.skills.length).toBeGreaterThan(0);
    expect(skills.body.skills[0]).toHaveProperty("xp");
    expect(skills.body.skills[0]).toHaveProperty("level");

    for (const path of ["quests", "achievements", "skills"]) {
      expect(await getJson(`/query/${path}?player=999999`)).toEqual({
        status: 404,
        body: { error: "player_not_found" },
      });
      expect((await getJson(`/query/${path}`)).status).toBe(400);
    }
  });
});

describe("既有端点不受影响", () => {
  it("/health 仍 200", async () => {
    const res = await fetch(`${baseUrl}/health`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });
});
