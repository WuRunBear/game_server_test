/**
 * HTTP 端点测试：`GET /content`（内容目录）与 `/maps/runtime` / `/maps/meta`
 * （读**活动房间的 live 几何**）。
 *
 * 覆盖：
 * - /content：六段结构齐全（items/recipes/quests/achievements/phases/skills），
 *   内容与当前 game/ 配置逐项一致（抽样比对：物品字段、配方输入产出、成就
 *   标题描述、相位时长与天气候选、技能清单）；
 * - /content 的展示名兜底：配置无名称字段时回退 id 原文；注册展示名后即生效；
 * - /maps/runtime：写回（terrainWriteback 的 setGround）后 version 与 tiles
 *   变化——即端点读的是 live 几何，而非「按配置重建」的视图；
 * - /maps/meta：version 与 live 几何一致。
 *
 * 服务器启动：vi.hoisted 先于静态导入把 PORT 置 0（serverConfig 于导入时
 * 固化端口），SAVE_DIR 指向空目录（避免读到旧存档——旧存档格式已废弃，会让
 * 常驻房间创建失败，从而拿不到 live 几何）。
 */
import http from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { matchMaker } from "@colyseus/core";

import { bootstrapFramework } from "framework/bootstrap";
import { loadGameDefinition } from "framework/bootstrap/loadGameDefinition";
import { registerContentLabel, resetContentLabels } from "framework/content/labels";
import type { ColyseusServer } from "framework/net/colyseus/server";
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

/** /content 响应形状（服务端契约）。 */
interface ContentResponse {
  items: Array<Record<string, unknown>>;
  recipes: Array<Record<string, unknown>>;
  quests: Array<Record<string, unknown>>;
  achievements: Array<Record<string, unknown>>;
  phases: Array<Record<string, unknown>>;
  skills: Array<Record<string, unknown>>;
}

let colyseus: ColyseusServer | undefined;
let baseUrl = "";
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

/** 取常驻房间 id（房间创建完成后可查）。 */
async function persistentRoomId(): Promise<string> {
  for (let attempt = 0; attempt < 60; attempt++) {
    const rooms = await matchMaker.query({});
    const room = rooms.find((r) => r.roomId);
    if (room) return room.roomId;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error("常驻房间未创建");
}

beforeAll(async () => {
  bootstrapFramework();
  gameDef = loadGameDefinition({ gameJsonPath: "game/game.json" });

  // 存档目录指向空临时目录：避免读到旧存档（旧格式存档已废弃，会让常驻房间
  // 创建失败 → 拿不到 live 几何）。房间在 startColyseusServer 内部创建，
  // 故此处设置对房间创建生效。
  process.env.SAVE_DIR = mkdtempSync(join(tmpdir(), "content-endpoint-saves-"));

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

describe("GET /content（内容目录：消除客户端硬编码静态表）", () => {
  it("六段结构齐全，内容与当前 game/ 配置一致", async () => {
    const res = await fetch(`${baseUrl}/content`);
    expect(res.status).toBe(200);
    const content = (await res.json()) as ContentResponse;

    // --- 物品：与 game/items/*.json 一一对应 ---
    expect(content.items.map((item) => item.kind)).toEqual(
      gameDef.resolvedItems.map((item) => item.kind),
    );
    const axe = content.items.find((item) => item.kind === "axe")!;
    expect(axe).toMatchObject({
      kind: "axe",
      maxStack: 1,
      maxDurability: 60,
      toolType: "axe",
      value: 5,
      equip: { slot: "tool" },
    });
    // 未配置的字段省略（不出现 undefined 键）
    expect("consume" in axe).toBe(false);
    expect("place" in axe).toBe(false);
    expect("throw" in axe).toBe(false);

    const berry = content.items.find((item) => item.kind === "berry")!;
    expect(berry.spoilTicks).toBe(3600);
    expect(berry.consume).toEqual([{ need: "hunger", amount: 20 }]);

    const throwingSpear = content.items.find((item) => item.kind === "throwing_spear")!;
    expect(throwingSpear.throw).toMatchObject({ speed: 320, lifeMs: 1000 });

    // --- 配方：与 crafting 规则一致（输入/产出归一为 [kind, 数量]） ---
    const crafting = gameDef.resolvedRules["crafting"] as {
      recipes: Array<{ id: string; inputs: { kind: string; count: number }[]; outputs: { kind: string; count: number }[] }>;
    };
    expect(content.recipes.map((recipe) => recipe.id)).toEqual(crafting.recipes.map((r) => r.id));
    const woodAxe = content.recipes.find((recipe) => recipe.id === "wood_axe")!;
    expect(woodAxe.inputs).toEqual([["wood", 2]]);
    expect(woodAxe.outputs).toEqual([["axe", 1]]);
    const shellSpear = content.recipes.find((recipe) => recipe.id === "shell_spear")!;
    expect(shellSpear.stationType).toBe(1);
    expect(shellSpear.durationTicks).toBe(40);
    expect(shellSpear.unlock).toEqual({ condition: "inPhase:storm" });

    // --- 任务：id 与配置一致；无标题配置 → 展示名兜底 ---
    expect(content.quests.map((quest) => quest.id)).toEqual(
      gameDef.resolvedQuests.map((quest) => quest.id),
    );
    const collectAxe = content.quests.find((quest) => quest.id === "collect_axe")!;
    expect(collectAxe.state).toBe(0);
    expect(collectAxe.count).toBe(0);
    expect(typeof collectAxe.title).toBe("string");
    expect(typeof collectAxe.desc).toBe("string");
    expect((collectAxe.desc as string).length).toBeGreaterThan(0);

    // --- 成就：标题/描述取配置字段 ---
    expect(content.achievements.map((a) => a.id)).toEqual(["village_friend", "boss_slayer"]);
    const villageFriend = content.achievements.find((a) => a.id === "village_friend")!;
    expect(villageFriend.title).toBe("渔村的熟人");
    expect(villageFriend.desc).toBe("与渔村势力声望达到 10。");
    expect(villageFriend.condition).toBe("factionRepAtLeast:village:10");
    expect(villageFriend.reward).toMatchObject({ items: [{ kind: "shell", count: 10 }] });

    // --- 相位：时长/天气候选/修饰值 ---
    expect(content.phases.map((phase) => phase.id)).toEqual(["mild", "dry", "wet", "storm"]);
    const mild = content.phases[0]!;
    expect(mild.durationTicks).toBe(24000);
    expect(mild.weather).toEqual([
      { id: "clear", weight: 5, intensity: 0 },
      { id: "rain", weight: 2, intensity: 0.4 },
      { id: "fog", weight: 1, intensity: 0.2 },
    ]);
    expect(mild.modifiers).toMatchObject({ temperatureOffset: 0, growthScale: 1 });

    // --- 技能：id 来自 progression 规则 ---
    expect(content.skills.map((skill) => skill.id)).toEqual(["combat", "gathering"]);
    expect(typeof content.skills[0]!.label).toBe("string");
  });

  it("展示名兜底：未注册时用 id 原文；注册后即生效", async () => {
    const before = (await (await fetch(`${baseUrl}/content`)).json()) as ContentResponse;
    const questBefore = before.quests.find((quest) => quest.id === "collect_axe")!;
    expect(questBefore.title).toBe("collect_axe");

    registerContentLabel("quest", "collect_axe", "带来一把斧头");
    registerContentLabel("skill", "combat", "战斗");

    const after = (await (await fetch(`${baseUrl}/content`)).json()) as ContentResponse;
    expect(after.quests.find((quest) => quest.id === "collect_axe")!.title).toBe("带来一把斧头");
    expect(after.skills.find((skill) => skill.id === "combat")!.label).toBe("战斗");

    resetContentLabels();
  });
});

describe("GET /maps/runtime 与 /maps/meta（读活动房间的 live 几何）", () => {
  it("写回地形后：/maps/runtime 的 tiles 与 version 变化，/maps/meta 的 version 同步", async () => {
    const roomId = await persistentRoomId();

    const before = await (await fetch(`${baseUrl}/maps/runtime?mapId=island`)).json() as {
      version: string;
      tiles: number[];
    };
    const metaBefore = await (await fetch(`${baseUrl}/maps/meta`)).json() as {
      maps: Array<{ id: string; version: string }>;
    };

    // 经房间写回单格地面语义（terrainWriteback 唯一入口）
    const written = await matchMaker.remoteRoomCall<{ debugWriteGround: (...args: unknown[]) => unknown }>(
      roomId,
      "debugWriteGround",
      ["island", 0, 42],
    );
    expect(written).toBe(true);

    const after = await (await fetch(`${baseUrl}/maps/runtime?mapId=island`)).json() as {
      version: string;
      tiles: number[];
    };
    const metaAfter = await (await fetch(`${baseUrl}/maps/meta`)).json() as {
      maps: Array<{ id: string; version: string }>;
    };

    // live 几何反映写回：tiles 变化 + version 指纹变化
    expect(after.tiles[0]).toBe(42);
    expect(after.version).not.toBe(before.version);

    // /maps/meta 的 version 与 live 几何同值
    const islandMeta = metaAfter.maps.find((m) => m.id === "island")!;
    expect(islandMeta.version).toBe(after.version);
    expect(metaBefore.maps.find((m) => m.id === "island")!.version).toBe(before.version);
  }, 60_000);
});
