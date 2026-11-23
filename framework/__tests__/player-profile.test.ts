/**
 * CC-10 Player Profile：组件规范化 / join 写入 / 重连保留 / 入档恢复 / schema 顺序。
 *
 * 覆盖：
 * - normalizePlayerProfile：空白 trim、长度上限、非字符串/超长回退空串、
 *   appearance 原样保留；
 * - addPlayer join options 写入 PlayerProfile；无 options 回退空串不崩；
 * - 断线保留 + 同 networkId 重连：同一实体、已有非空资料不被覆盖，只补空字段；
 * - serializeWorld → 新仿真读档：资料仍在（AoS 组件不在运行时黑名单）；
 * - PlayerState 新字段追加在末尾（字段顺序即线协议索引）。
 */
import { describe, it, expect, beforeAll } from "vitest";

import {
  bootstrapFramework,
  createDefaultGameDefinition,
  createGameSimulation,
  serializeWorld,
} from "framework/index";
import type { LoadedGameDefinition } from "framework/config/schema/GameDefinitionSchema";
import type { GameWorld } from "framework/world";
import type { SimulationPort } from "simulation";
import {
  PLAYER_PROFILE_APPEARANCE_MAX,
  PLAYER_PROFILE_CHARACTER_ID_MAX,
  PLAYER_PROFILE_DISPLAY_NAME_MAX,
  PlayerProfile,
  emptyPlayerProfile,
  normalizePlayerProfile,
  playerProfileOf,
} from "framework/components/playerProfile";
import { NetworkId } from "framework/components/network";
import { PlayerState } from "network/colyseus/state/PlayerState";
import { memoryRepository } from "./helpers/persistence";

beforeAll(() => {
  bootstrapFramework();
});

/** 取仿真内部的 GameWorld（私有访问器模式，同其他测试）。 */
function simWorld(sim: SimulationPort): GameWorld {
  return (sim as unknown as { world: GameWorld }).world;
}

/**
 * 会话 → eid（私有映射）。
 *
 * 不用 query 反查：bitecs legacy 组件掩码是进程级共享的，同一进程内建第二个
 * world 时旧实体可能仍命中 query（测试环境已知污染）。
 */
function playerEidOf(sim: SimulationPort, sessionId: string): number {
  const map = (sim as unknown as { playerEidBySessionId: Map<string, number> })
    .playerEidBySessionId;
  const eid = map.get(sessionId);
  if (typeof eid !== "number") throw new Error(`session "${sessionId}" 未绑定玩家实体`);
  return eid;
}

function profileOf(sim: SimulationPort, networkId: number) {
  return sim.getPlayerProfile?.(networkId);
}

/** 带断线保留窗口的最小定义（默认 5 分钟对测试太长，这里用 100 tick）。 */
function retentionDef(): LoadedGameDefinition {
  const def = createDefaultGameDefinition();
  def.resolvedRules["server"] = { offlineRetentionTicks: 100 };
  return def;
}

// ─── 规范化 ──────────────────────────────────────────────────────────────

describe("PlayerProfile 规范化", () => {
  it("trim、上限内保留、超长/非字符串回退空串（永不抛错）", () => {
    expect(normalizePlayerProfile(undefined)).toEqual(emptyPlayerProfile());
    expect(normalizePlayerProfile(null)).toEqual(emptyPlayerProfile());
    expect(normalizePlayerProfile("not-an-object")).toEqual(emptyPlayerProfile());

    const atLimitName = "名".repeat(PLAYER_PROFILE_DISPLAY_NAME_MAX);
    const atLimitId = "c".repeat(PLAYER_PROFILE_CHARACTER_ID_MAX);
    const atLimitAppearance = "x".repeat(PLAYER_PROFILE_APPEARANCE_MAX);
    expect(
      normalizePlayerProfile({
        displayName: `  ${atLimitName}  `,
        characterId: ` ${atLimitId} `,
        appearance: atLimitAppearance,
      }),
    ).toEqual({
      displayName: atLimitName,
      characterId: atLimitId,
      appearance: atLimitAppearance,
    });

    // 空白 → 空串
    expect(normalizePlayerProfile({ displayName: "   ", characterId: " \t " })).toEqual({
      displayName: "",
      characterId: "",
      appearance: "",
    });

    // 超长 → 空串（不截断、不抛错）
    expect(
      normalizePlayerProfile({
        displayName: "名".repeat(PLAYER_PROFILE_DISPLAY_NAME_MAX + 1),
        characterId: "c".repeat(PLAYER_PROFILE_CHARACTER_ID_MAX + 1),
        appearance: "x".repeat(PLAYER_PROFILE_APPEARANCE_MAX + 1),
      }),
    ).toEqual(emptyPlayerProfile());

    // 非字符串 → 空串
    expect(
      normalizePlayerProfile({
        displayName: 42,
        characterId: { id: "hero" },
        appearance: ["{}"],
      }),
    ).toEqual(emptyPlayerProfile());
  });

  it("appearance 是不透明 JSON 字符串：原样保留（不 trim/不解析/不重排）", () => {
    const appearance = ' {"skin":"red","layers":[{"id":"hat","tint":"#fff"}]} ';
    const normalized = normalizePlayerProfile({ displayName: " Alice ", appearance });
    expect(normalized.displayName).toBe("Alice");
    expect(normalized.appearance).toBe(appearance);
  });
});

// ─── join options 写入 ───────────────────────────────────────────────────

describe("PlayerProfile join 写入", () => {
  it("新玩家用 join options 写入资料；无 options 时为空串且不崩", async () => {
    const sim = await createGameSimulation(createDefaultGameDefinition());

    const joined = sim.addPlayer("s1", {
      displayName: "  Alice  ",
      characterId: " hero_1 ",
      appearance: '{"skin":"red"}',
    });
    expect(profileOf(sim, joined.networkId)).toEqual({
      displayName: "Alice",
      characterId: "hero_1",
      appearance: '{"skin":"red"}',
    });

    // 无 options：空串占位，不抛错、不返回 undefined
    const bare = sim.addPlayer("s2");
    expect(profileOf(sim, bare.networkId)).toEqual(emptyPlayerProfile());

    // 畸形类型/超长：规范化后空串，join 不崩
    const malformed = sim.addPlayer("s3", {
      displayName: 7 as unknown as string,
      characterId: "c".repeat(PLAYER_PROFILE_CHARACTER_ID_MAX + 1),
      appearance: null as unknown as string,
    });
    expect(profileOf(sim, malformed.networkId)).toEqual(emptyPlayerProfile());

    // 不存在的 networkId → undefined（传输层可跳过）
    expect(profileOf(sim, 999_999)).toBeUndefined();
  });

  it("PlayerProfile 随实体写到 AoS 存储（不是仅挂在 PlayerState DTO 上）", async () => {
    const sim = await createGameSimulation(createDefaultGameDefinition());
    const joined = sim.addPlayer("s1", {
      displayName: "Alice",
      characterId: "hero_1",
      appearance: '{"skin":"red"}',
    });
    const eid = playerEidOf(sim, "s1");
    expect(PlayerProfile[eid]).toEqual({
      displayName: "Alice",
      characterId: "hero_1",
      appearance: '{"skin":"red"}',
    });
    expect(playerProfileOf(eid)).toEqual(PlayerProfile[eid]);
    expect(NetworkId.value[eid]).toBe(joined.networkId);
  });
});

// ─── 断线保留 + 重连 ─────────────────────────────────────────────────────

describe("PlayerProfile 断线保留与重连", () => {
  it("保留期内重连同 networkId：同一实体，既有非空资料不被覆盖", async () => {
    const sim = await createGameSimulation(retentionDef());
    const original = {
      displayName: "Alice",
      characterId: "hero_1",
      appearance: '{"skin":"red"}',
    };
    const nid = sim.addPlayer("s1", original).networkId;
    const eid = playerEidOf(sim, "s1");
    sim.tick(50);

    sim.removePlayer("s1");
    expect(PlayerProfile[eid]).toEqual(original);

    // 新会话自报旧 networkId + 冒领资料 → 复用同一实体，但资料保持原值
    const rejoin = sim.addPlayer("s2", {
      networkId: nid,
      displayName: "Mallory",
      characterId: "villain",
      appearance: '{"skin":"blue"}',
    });
    expect(rejoin.networkId).toBe(nid);
    expect(playerEidOf(sim, "s2")).toBe(eid);
    expect(profileOf(sim, nid)).toEqual(original);
  });

  it("重连只补空字段：已有 characterId 保留，空 displayName/appearance 被填充", async () => {
    const sim = await createGameSimulation(retentionDef());
    const nid = sim.addPlayer("s1", { characterId: "hero_1" }).networkId;
    const eid = playerEidOf(sim, "s1");

    sim.removePlayer("s1");
    sim.addPlayer("s2", {
      networkId: nid,
      displayName: "  Alice  ",
      characterId: "villain",
      appearance: '{"skin":"green"}',
    });

    expect(playerEidOf(sim, "s2")).toBe(eid);
    expect(profileOf(sim, nid)).toEqual({
      displayName: "Alice",
      characterId: "hero_1",
      appearance: '{"skin":"green"}',
    });
  });
});

// ─── 入档 / 读档 ─────────────────────────────────────────────────────────

describe("PlayerProfile 持久化", () => {
  it("serializeWorld 写入 PlayerProfile；新仿真读档后资料仍在且重连不覆盖", async () => {
    const def = retentionDef();
    const sim1 = await createGameSimulation(def);
    const original = {
      displayName: "Alice",
      characterId: "hero_1",
      appearance: '{"skin":"red","hat":"straw"}',
    };
    const nid = sim1.addPlayer("s1", original).networkId;

    const record = serializeWorld(simWorld(sim1), "save-cc10");
    const saved = record.entities.find((entity) => entity.networkId === nid);
    expect(saved).toBeDefined();
    expect(saved!.components.PlayerProfile).toEqual(original);

    // 存档必须可 JSON 往返（文件仓储前提）
    const revived = JSON.parse(JSON.stringify(record)) as typeof record;
    const sim2 = await createGameSimulation(def, {
      repository: memoryRepository(revived),
      saveId: "save-cc10",
    });

    // 读档恢复的玩家实体仍带资料（此时处于离线保留状态，尚未绑定会话）
    expect(profileOf(sim2, nid)).toEqual(original);

    const rejoin = sim2.addPlayer("s2", {
      networkId: nid,
      displayName: "Mallory",
      characterId: "villain",
      appearance: '{"skin":"blue"}',
    });
    expect(rejoin.networkId).toBe(nid);
    expect(profileOf(sim2, nid)).toEqual(original);
  });
});

// ─── schema 顺序 ─────────────────────────────────────────────────────────

describe("PlayerState 字段顺序（线协议索引）", () => {
  it("CC-10 三个字段追加在 mapVersion 之后，旧字段索引不变", () => {
    expect(Object.getOwnPropertyNames(PlayerState.prototype)).toEqual([
      "constructor",
      "sessionId",
      "entityId",
      "mapId",
      "visibleEntities",
      "mapVersion",
      "displayName",
      "characterId",
      "appearance",
      "lastProcessedSeq",
    ]);
  });
});
