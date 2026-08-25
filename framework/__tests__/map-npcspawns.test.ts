/**
 * npcSpawns 参数化测试：map 的 "simple" 生成器应从可选 `npcSpawns` 配置构建
 * NPC 出生点，而非硬编码一个 NPC 出生点。
 *
 * 语义（必须与 framework/map 的 npcSpawns 契约一致）：
 * - 玩家出生点固定在地图中心（mapPixelW * 0.5, mapPixelH * 0.5）；
 * - 每个 npcSpawn 的 `offsetTiles` 是相对玩家出生点、以 tile 为单位的偏移；
 * - `kind` always 来自配置（数据），框架不硬编码任何 kind；
 * - 未配置 npcSpawns 或为空数组 → 不生成任何 NPC 出生点（npcs: []）。
 *
 * 验证：
 * - 路由：给定 offsetTiles 时，npcs[i].pos = 玩家中心 + offsetTiles * tile 尺寸；
 * - 铁律：npcSpawns 缺省 / 为空 → npcs 长度为 0（无硬编码 NPC）。
 */
import { describe, it, expect, beforeAll } from "vitest";
import { buildMapRuntime } from "map";
import type { GeneratedMapSource } from "map";
import type { NpcSpawnSpec } from "map/types";
import { generateSimpleMap } from "map/generated/simple";
import type { SimpleGeneratorOptions } from "map/generated/simple";
import { bootstrapFramework } from "framework/bootstrap";

beforeAll(() => {
  // 注册内置生成器（buildMapRuntime 依赖 generatorRegistry 中的 "simple"）。
  bootstrapFramework();
});

const WIDTH = 64;
const HEIGHT = 64;
const TILE_W = 16;
const TILE_H = 16;

/** 玩家出生点：地图中心。 */
const PLAYER_X = WIDTH * TILE_W * 0.5; // 512
const PLAYER_Y = HEIGHT * TILE_H * 0.5; // 512

function makeSource(npcSpawns?: NpcSpawnSpec[]): GeneratedMapSource {
  const base: GeneratedMapSource = {
    kind: "generated",
    id: "generated",
    name: "generated",
    generatorId: "simple",
    seed: 1,
    width: WIDTH,
    height: HEIGHT,
    tileWidth: TILE_W,
    tileHeight: TILE_H,
  };
  return npcSpawns === undefined ? base : { ...base, npcSpawns };
}

/** 构建 simple 生成器参数（单个 npcSpawn）。 */
function makeOptions(offsetTiles: [number, number], zoneId?: number): SimpleGeneratorOptions {
  const npcSpawn: NpcSpawnSpec = { kind: "npc", offsetTiles };
  if (zoneId !== undefined) npcSpawn.zoneId = zoneId;
  return {
    id: "generated",
    name: "generated",
    seed: 1,
    width: WIDTH,
    height: HEIGHT,
    tileWidth: TILE_W,
    tileHeight: TILE_H,
    npcSpawns: [npcSpawn],
  };
}

describe("map simple generator npcSpawns parameterization", () => {
  it("照 npcSpawns（offsetTiles [2,0]）从玩家中心构建单个 NPC 出生点", () => {
    const rt = generateSimpleMap(makeOptions([2, 0], 1));
    expect(rt.spawns.npcs).toHaveLength(1);
    expect(rt.spawns.npcs[0]!.kind).toBe("npc");
    expect(rt.spawns.npcs[0]!.pos).toEqual({
      x: PLAYER_X + 2 * TILE_W, // 544
      y: PLAYER_Y, // 512
    });
    expect(rt.spawns.npcs[0]!.zoneId).toBe(1);
  });

  it("应用任意 offsetTiles（证明是配置驱动，非硬编码）", () => {
    const rt = generateSimpleMap(makeOptions([3, -2]));
    expect(rt.spawns.npcs).toHaveLength(1);
    expect(rt.spawns.npcs[0]!.pos).toEqual({
      x: PLAYER_X + 3 * TILE_W, // 560
      y: PLAYER_Y + -2 * TILE_H, // 480
    });
  });

  it("npcSpawns 为空数组时不生成任何 NPC（buildMapRuntime 路径）", () => {
    const rt = buildMapRuntime(makeSource([]));
    expect(rt.spawns.npcs).toHaveLength(0);
  });

  it("缺省（无 npcSpawns 键）时不生成任何 NPC（buildMapRuntime 路径）", () => {
    const rt = buildMapRuntime(makeSource());
    expect(rt.spawns.npcs).toHaveLength(0);
  });

  it("buildMapRuntime 端到端：非空 npcSpawns 经生成器注册表路由到 simple 生成器", () => {
    const rt = buildMapRuntime(makeSource([{ kind: "npc", offsetTiles: [2, 0], zoneId: 1 }]));
    expect(rt.spawns.npcs).toHaveLength(1);
    expect(rt.spawns.npcs[0]!.kind).toBe("npc");
    expect(rt.spawns.npcs[0]!.pos).toEqual({
      x: PLAYER_X + 2 * TILE_W, // 544
      y: PLAYER_Y, // 512
    });
    expect(rt.spawns.npcs[0]!.zoneId).toBe(1);
  });
});
