/**
 * room-corridor 生成积木测试（framework/__tests__/map-block-room-corridor.test.ts）。
 *
 * 覆盖计划 todo 5 验收：
 * - U1 确定性：同 seed 两次生成 tiles/walkable 深相等，异 seed 不同；
 * - 连通性：全部 floorTile 格构成单一 4-连通分量（积木自身契约，
 *   validate 层不查）；
 * - 房间尺寸：planRooms 纯函数直接单测——每房间边长 ∈
 *   [minRoomSize, maxRoomSize]、落在地图内、两两间距 ≥ 1 格；
 * - 雕挖不变量：floorTile 格恒 walkable=1；房间外存在走廊格
 *   （floorTile 且 walkable=1）；
 * - roomCount=0：输出与未雕挖草稿完全一致；
 * - 未定尺寸草稿：抛错点名地图 key；
 * - 参数收窄：每个非法参数抛含参数名与地图 key 的清晰错误。
 *
 * 管道用假 sizing 积木先铺 48×48 实心草稿（tiles=SOLID、walkable=0），
 * room-corridor 在其后叠用——与洞穴类地图「noise-terrain → room-corridor」
 * 的真实叠层顺序一致。
 */
import { describe, expect, it } from "vitest";

import type { MapGeometry } from "map/geometry/types";
import { parseRoomCorridorParams, planRooms, roomCorridor, type RoomCorridorParams, type RoomRect } from "map/generate/blocks/roomCorridor";
import { createGeneratorRegistry, type GeneratorRegistry } from "map/generate/generatorRegistry";
import { buildMapGeometry } from "map/generate/pipeline";
import { createRng, deriveStream } from "map/generate/rng";
import type { MapGenerator } from "map/generate/types";

/** 测试地图尺寸（tile 数）。 */
const MAP_W = 48;
const MAP_H = 48;

/** 语义 id：岩体（未雕挖底色）与地面（雕挖目标）。 */
const SOLID = 1;
const FLOOR = 2;

/** 主测试参数：8 个 3–6 号房间、1 格宽走廊。 */
const BASE_PARAMS: RoomCorridorParams = {
  roomCount: 8,
  minRoomSize: 3,
  maxRoomSize: 6,
  corridorWidth: 1,
  floorTile: FLOOR,
  solidTile: SOLID,
};

/** 假 sizing 积木：铺满实心岩体、walkable 全 0（尺寸可经 params 覆盖）。 */
const sizingBlock: MapGenerator = (ctx) => {
  const size = ctx.params as { width?: number; height?: number };
  const width = size.width ?? MAP_W;
  const height = size.height ?? MAP_H;
  const draft = ctx.geometry;
  draft.width = width;
  draft.height = height;
  draft.tileWidth = 16;
  draft.tileHeight = 16;
  draft.tiles = new Uint8Array(width * height).fill(SOLID);
  draft.walkable = new Uint8Array(width * height);
  draft.regions.set("region-a", { name: "region-a", meta: {} });
  draft.regionOfTile = new Uint16Array(width * height);
};

/** 构造注册了 sizing + room-corridor 的注册表。 */
function makeRegistry(): GeneratorRegistry {
  const registry = createGeneratorRegistry();
  registry.register("sizing", sizingBlock);
  registry.register("room-corridor", roomCorridor);
  return registry;
}

/** 把收窄参数展开为管道步骤的 params 切片（框架侧类型为 Record<string, unknown>）。 */
function stepParams(params: RoomCorridorParams): Record<string, unknown> {
  return {
    roomCount: params.roomCount,
    minRoomSize: params.minRoomSize,
    maxRoomSize: params.maxRoomSize,
    corridorWidth: params.corridorWidth,
    floorTile: params.floorTile,
    solidTile: params.solidTile,
  };
}

/** 经真实管道生成：sizing 先行，room-corridor 按给定参数雕挖。 */
function generate(params: RoomCorridorParams, seed: number, mapKey = "cave-test"): MapGeometry {
  return buildMapGeometry(
    {
      key: mapKey,
      seed,
      pipeline: [{ generator: "sizing" }, { generator: "room-corridor", params: stepParams(params) }],
    },
    makeRegistry(),
  );
}

/** room-corridor 步骤（管道序号 1）的派生随机流——planRooms 复现用。 */
function blockRng(seed: number) {
  return deriveStream(seed, 1);
}

/** floorTile 格子的 4-连通分量数（BFS/DFS 迭代染色）。 */
function countFloorComponents(tiles: Uint8Array, width: number, height: number, floorTile: number): number {
  const seen = new Uint8Array(tiles.length);
  const stack: number[] = [];
  let components = 0;
  for (let start = 0; start < tiles.length; start++) {
    if (tiles[start] !== floorTile || seen[start] === 1) {
      continue;
    }
    components++;
    seen[start] = 1;
    stack.push(start);
    while (stack.length > 0) {
      const index = stack.pop();
      if (index === undefined) {
        break;
      }
      const x = index % width;
      const y = Math.floor(index / width);
      const neighbors = [
        x > 0 ? index - 1 : -1,
        x < width - 1 ? index + 1 : -1,
        y > 0 ? index - width : -1,
        y < height - 1 ? index + width : -1,
      ];
      for (const neighbor of neighbors) {
        if (neighbor >= 0 && tiles[neighbor] === floorTile && seen[neighbor] === 0) {
          seen[neighbor] = 1;
          stack.push(neighbor);
        }
      }
    }
  }
  return components;
}

/** 统计满足谓词的格子数。 */
function countTiles(tiles: Uint8Array, predicate: (tile: number) => boolean): number {
  let count = 0;
  for (let i = 0; i < tiles.length; i++) {
    if (predicate(tiles[i])) {
      count++;
    }
  }
  return count;
}

/** 判断格子是否落在任一房间矩形内。 */
function inAnyRoom(rooms: RoomRect[], x: number, y: number): boolean {
  return rooms.some((room) => x >= room.x && x < room.x + room.width && y >= room.y && y < room.y + room.height);
}

describe("room-corridor U1 确定性", () => {
  it("POSITIVE：同 seed 两次生成 tiles/walkable 深相等", () => {
    const first = generate(BASE_PARAMS, 7);
    const second = generate(BASE_PARAMS, 7);
    expect(second.tiles).toEqual(first.tiles);
    expect(second.walkable).toEqual(first.walkable);
  });

  it("POSITIVE：异 seed 生成结果不同", () => {
    const a = generate(BASE_PARAMS, 7);
    const b = generate(BASE_PARAMS, 8);
    expect(b.tiles).not.toEqual(a.tiles);
  });
});

describe("room-corridor 连通性（积木自身契约）", () => {
  it("POSITIVE：全部 floorTile 格构成单一 4-连通分量（多 seed、多走廊宽度）", () => {
    for (const seed of [7, 8, 42]) {
      for (const corridorWidth of [1, 2]) {
        const geometry = generate({ ...BASE_PARAMS, corridorWidth }, seed);
        const floorCount = countTiles(geometry.tiles, (tile) => tile === FLOOR);
        expect(floorCount).toBeGreaterThan(0);
        expect(countFloorComponents(geometry.tiles, MAP_W, MAP_H, FLOOR)).toBe(1);
      }
    }
  });
});

describe("room-corridor 雕挖不变量", () => {
  it("U6：floorTile 格恒 walkable=1，且房间外存在走廊格", () => {
    const seed = 7;
    const geometry = generate(BASE_PARAMS, seed);
    const rooms = planRooms(blockRng(seed), BASE_PARAMS, MAP_W, MAP_H);

    for (let i = 0; i < geometry.tiles.length; i++) {
      if (geometry.tiles[i] === FLOOR) {
        expect(geometry.walkable[i]).toBe(1);
      }
    }

    // 走廊格 = 房间矩形外的 floorTile 格（房间间距 ≥ 1 格，走廊必穿房间外空间）
    let corridorCells = 0;
    for (let y = 0; y < MAP_H; y++) {
      for (let x = 0; x < MAP_W; x++) {
        const index = y * MAP_W + x;
        if (geometry.tiles[index] === FLOOR && !inAnyRoom(rooms, x, y)) {
          corridorCells++;
          expect(geometry.walkable[index]).toBe(1);
        }
      }
    }
    expect(corridorCells).toBeGreaterThan(0);
  });

  it("U6：未雕挖格保持上游输出（tiles=SOLID、walkable=0）", () => {
    const geometry = generate(BASE_PARAMS, 7);
    for (let i = 0; i < geometry.tiles.length; i++) {
      if (geometry.tiles[i] !== FLOOR) {
        expect(geometry.tiles[i]).toBe(SOLID);
        expect(geometry.walkable[i]).toBe(0);
      }
    }
  });
});

describe("planRooms 纯函数（房间尺寸契约）", () => {
  it("POSITIVE：每房间边长 ∈ [minRoomSize, maxRoomSize] 且落在地图内", () => {
    for (const seed of [1, 7, 8, 42, 99]) {
      const rooms = planRooms(createRng(seed), BASE_PARAMS, MAP_W, MAP_H);
      expect(rooms.length).toBe(BASE_PARAMS.roomCount);
      for (const room of rooms) {
        expect(room.width).toBeGreaterThanOrEqual(BASE_PARAMS.minRoomSize);
        expect(room.width).toBeLessThanOrEqual(BASE_PARAMS.maxRoomSize);
        expect(room.height).toBeGreaterThanOrEqual(BASE_PARAMS.minRoomSize);
        expect(room.height).toBeLessThanOrEqual(BASE_PARAMS.maxRoomSize);
        expect(room.x).toBeGreaterThanOrEqual(0);
        expect(room.y).toBeGreaterThanOrEqual(0);
        expect(room.x + room.width).toBeLessThanOrEqual(MAP_W);
        expect(room.y + room.height).toBeLessThanOrEqual(MAP_H);
      }
    }
  });

  it("POSITIVE：两房间间距至少 1 格（外扩 1 格后不相交）", () => {
    const rooms = planRooms(createRng(7), BASE_PARAMS, MAP_W, MAP_H);
    for (let i = 0; i < rooms.length; i++) {
      for (let j = i + 1; j < rooms.length; j++) {
        const a = rooms[i];
        const b = rooms[j];
        const separated = a.x > b.x + b.width || b.x > a.x + a.width
          || a.y > b.y + b.height || b.y > a.y + a.height;
        expect(separated).toBe(true);
      }
    }
  });

  it("POSITIVE：同 seed 序列确定复现", () => {
    expect(planRooms(createRng(7), BASE_PARAMS, MAP_W, MAP_H)).toEqual(planRooms(createRng(7), BASE_PARAMS, MAP_W, MAP_H));
  });

  it("POSITIVE：roomCount=0 → 空数组", () => {
    expect(planRooms(createRng(7), { ...BASE_PARAMS, roomCount: 0 }, MAP_W, MAP_H)).toEqual([]);
  });
});

describe("room-corridor roomCount=0 恒等", () => {
  it("POSITIVE：输出与未雕挖草稿完全一致", () => {
    const untouched = buildMapGeometry(
      { key: "cave-test", seed: 7, pipeline: [{ generator: "sizing" }] },
      makeRegistry(),
    );
    const carved = generate({ ...BASE_PARAMS, roomCount: 0 }, 7);
    expect(carved.tiles).toEqual(untouched.tiles);
    expect(carved.walkable).toEqual(untouched.walkable);
  });
});

describe("room-corridor 前置与参数校验", () => {
  it("NEGATIVE：未定尺寸草稿 → 抛错点名地图 key", () => {
    const registry = createGeneratorRegistry();
    registry.register("room-corridor", roomCorridor);
    expect(() =>
      buildMapGeometry(
        { key: "unsized-map", seed: 1, pipeline: [{ generator: "room-corridor", params: stepParams(BASE_PARAMS) }] },
        registry,
      ),
    ).toThrowError(/map "unsized-map": room-corridor requires a sized draft/);
  });

  it("NEGATIVE：地图小于 minRoomSize → 抛错点名地图 key 与 minRoomSize", () => {
    expect(() =>
      buildMapGeometry(
        {
          key: "tiny-map",
          seed: 1,
          pipeline: [
            { generator: "sizing", params: { width: 4, height: 4 } },
            { generator: "room-corridor", params: { ...BASE_PARAMS, minRoomSize: 6, maxRoomSize: 8 } },
          ],
        },
        makeRegistry(),
      ),
    ).toThrowError(/map "tiny-map": room-corridor cannot place any room: grid 4x4 is smaller than minRoomSize 6/);
  });

  it("NEGATIVE：params 非对象 → 抛错点名地图 key", () => {
    expect(() => parseRoomCorridorParams(null, "cave")).toThrowError(/map "cave": room-corridor params must be an object/);
    expect(() => parseRoomCorridorParams(42, "cave")).toThrowError(/params must be an object with roomCount\/minRoomSize\/maxRoomSize\/corridorWidth\/floorTile\/solidTile, got 42/);
  });

  it("NEGATIVE：roomCount 非法（负数/非整数/缺失）→ 抛错点名参数", () => {
    expect(() => parseRoomCorridorParams({ ...BASE_PARAMS, roomCount: -1 }, "cave")).toThrowError(/params\.roomCount must be an integer >= 0, got -1/);
    expect(() => parseRoomCorridorParams({ ...BASE_PARAMS, roomCount: 1.5 }, "cave")).toThrowError(/params\.roomCount must be an integer, got 1\.5/);
    expect(() => parseRoomCorridorParams({ ...BASE_PARAMS, roomCount: "3" }, "cave")).toThrowError(/params\.roomCount must be an integer, got "3"/);
    const missing: Record<string, unknown> = { ...BASE_PARAMS, roomCount: undefined };
    expect(() => parseRoomCorridorParams(missing, "cave")).toThrowError(/params\.roomCount must be an integer, got undefined/);
  });

  it("NEGATIVE：minRoomSize < 1 或 maxRoomSize < minRoomSize → 抛错点名参数", () => {
    expect(() => parseRoomCorridorParams({ ...BASE_PARAMS, minRoomSize: 0 }, "cave")).toThrowError(/params\.minRoomSize must be an integer >= 1, got 0/);
    expect(() => parseRoomCorridorParams({ ...BASE_PARAMS, maxRoomSize: 2 }, "cave")).toThrowError(/params\.maxRoomSize must be an integer >= 3, got 2/);
  });

  it("NEGATIVE：corridorWidth < 1 → 抛错点名参数", () => {
    expect(() => parseRoomCorridorParams({ ...BASE_PARAMS, corridorWidth: 0 }, "cave")).toThrowError(/params\.corridorWidth must be an integer >= 1, got 0/);
  });

  it("NEGATIVE：语义 id 越界或相同 → 抛错点名参数", () => {
    expect(() => parseRoomCorridorParams({ ...BASE_PARAMS, floorTile: 256 }, "cave")).toThrowError(/params\.floorTile must be an integer in \[0, 255\], got 256/);
    expect(() => parseRoomCorridorParams({ ...BASE_PARAMS, solidTile: -1 }, "cave")).toThrowError(/params\.solidTile must be an integer in \[0, 255\], got -1/);
    expect(() => parseRoomCorridorParams({ ...BASE_PARAMS, solidTile: FLOOR }, "cave")).toThrowError(/params\.floorTile and params\.solidTile must be different semantic ids, both are 2/);
  });

  it("POSITIVE：合法参数收窄通过且原样保留", () => {
    expect(parseRoomCorridorParams(BASE_PARAMS, "cave")).toEqual(BASE_PARAMS);
  });
});
