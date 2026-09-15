/**
 * slot-rooms 生成积木测试（framework/__tests__/map-block-slot-rooms.test.ts）。
 *
 * 覆盖地图系统设计文档提案 7 验收：
 * - 端到端：经 buildMapGeometry 产出合法 MapGeometry，整图尺寸 =
 *   slotsX × cellW / slotsY × cellH；
 * - 确定性：同 seed 两次生成逐位一致（tiles/walkable/regions/version），
 *   异 seed 不同；
 * - 连通性：全部 walkable=1 格构成单一 4-连通分量（构造保证，BFS 断言），
 *   任意房中心可达全部门格；
 * - 房间结构：矩形两两不重叠、落在图内（槽位划分 + 房尺寸 ≤ 槽-1）；
 * - 每房 meta：center/halfW/halfH/doors/type 齐全，中心像素在房间内，
 *   门非空、门格 walkable=1 且位于房间外环（Chebyshev 距 = 1）；
 * - 区域结构：regions 含全部房间区域 + walls，type 缺省为结构名、
 *   roomTypes 配置映射生效（branch 循环取用）；
 * - 参数校验：slotsX/slotsY/branchCount/roomMaxW/floorTile=solidTile/
 *   roomTypes.branch 各自抛错点名；
 * - 首积木约束：草稿已初始化时抛错。
 */
import { describe, expect, it } from "vitest";

import type { MapGeometry } from "map/geometry/types";
import { SLOT_ROOMS, slotRooms, WALLS_REGION, type SlotRoomInfo } from "map/generate/blocks/slotRooms";
import { createGeneratorRegistry } from "map/generate/generatorRegistry";
import { buildMapGeometry } from "map/generate/pipeline";
import { createRng } from "map/generate/rng";
import { createGeometryDraft, getAux, type GenerationContext, type GeometryDraft } from "map/generate/types";

/** 测试地图 key。 */
const KEY = "slots-map";

/** 基准参数：5×4 槽位、15×12 槽尺寸（整图 75×48），语义 1 墙 / 2 地面。 */
const BASE_PARAMS: Record<string, unknown> = {
  floorTile: 2,
  solidTile: 1,
  tileWidth: 16,
  tileHeight: 16,
};

/** 构造注册了 slot-rooms 的注册表。 */
function makeRegistry() {
  const registry = createGeneratorRegistry();
  registry.register("slot-rooms", slotRooms);
  return registry;
}

/** 经真实管道以给定参数与 seed 生成。 */
function generate(params: Record<string, unknown> = BASE_PARAMS, seed = 42, mapKey = KEY): MapGeometry {
  return buildMapGeometry(
    { key: mapKey, seed, pipeline: [{ generator: "slot-rooms", params }] },
    makeRegistry(),
  );
}

/** 直接调用积木（不经冻结），返回草稿与 aux 房间列表。 */
function runBlock(params: unknown, seed = 42): { draft: GeometryDraft; rooms: SlotRoomInfo[] } {
  const draft = createGeometryDraft(KEY);
  const ctx: GenerationContext = { key: KEY, rng: createRng(seed), geometry: draft, params };
  slotRooms(ctx);
  const rooms = getAux(draft, SLOT_ROOMS);
  if (!rooms) throw new Error("slot-rooms did not write SLOT_ROOMS aux slot");
  return { draft, rooms };
}

/** walkable=1 格的 4-连通分量数（BFS 迭代染色）。 */
function countWalkableDomains(walkable: Uint8Array, width: number, height: number): number {
  const seen = new Uint8Array(walkable.length);
  const stack: number[] = [];
  let domains = 0;
  for (let start = 0; start < walkable.length; start++) {
    if (walkable[start] !== 1 || seen[start] === 1) continue;
    domains++;
    seen[start] = 1;
    stack.push(start);
    while (stack.length > 0) {
      const index = stack.pop() as number;
      const x = index % width;
      const y = (index - x) / width;
      if (x > 0 && walkable[index - 1] === 1 && seen[index - 1] === 0) {
        seen[index - 1] = 1;
        stack.push(index - 1);
      }
      if (x < width - 1 && walkable[index + 1] === 1 && seen[index + 1] === 0) {
        seen[index + 1] = 1;
        stack.push(index + 1);
      }
      if (y > 0 && walkable[index - width] === 1 && seen[index - width] === 0) {
        seen[index - width] = 1;
        stack.push(index - width);
      }
      if (y < height - 1 && walkable[index + width] === 1 && seen[index + width] === 0) {
        seen[index + width] = 1;
        stack.push(index + width);
      }
    }
  }
  return domains;
}

describe("slot-rooms 端到端与确定性", () => {
  it("POSITIVE：默认参数产出合法 MapGeometry，整图尺寸 = 槽位网格换算", () => {
    const geometry = generate();
    expect(geometry.key).toBe(KEY);
    expect(geometry.grid).toEqual({ width: 75, height: 48, tileWidth: 16, tileHeight: 16 });
    expect(geometry.tiles).toHaveLength(75 * 48);
    expect(geometry.walkable).toHaveLength(75 * 48);
    expect(geometry.version).not.toBe("");
    // 区域 = 主路径房（slotsX=5）+ 支线房（≥0）+ walls
    expect(geometry.regions.size).toBeGreaterThanOrEqual(5 + 1);
    expect(geometry.regions.has(WALLS_REGION)).toBe(true);
  });

  it("U1：同 seed 两次生成逐位一致（tiles/walkable/regions/version）", () => {
    const a = generate(BASE_PARAMS, 42);
    const b = generate(BASE_PARAMS, 42);
    expect(b.tiles).toEqual(a.tiles);
    expect(b.walkable).toEqual(a.walkable);
    expect(b.regionOfTile).toEqual(a.regionOfTile);
    expect(b.regions).toEqual(a.regions);
    expect(b.version).toBe(a.version);
  });

  it("U1：异 seed 生成不同 tiles", () => {
    const a = generate(BASE_PARAMS, 42);
    const b = generate(BASE_PARAMS, 43);
    expect(b.tiles).not.toEqual(a.tiles);
  });
});

describe("slot-rooms 连通性与房间结构", () => {
  it("U1：全部 walkable 格构成单一 4-连通分量（构造保证）", () => {
    const geometry = generate();
    expect(countWalkableDomains(geometry.walkable, geometry.grid.width, geometry.grid.height)).toBe(1);
  });

  it("POSITIVE：多 seed 抽查连通域恒为 1（支线挂接与走廊方向随机组合）", () => {
    for (const seed of [1, 7, 99, 1234, 20240915]) {
      const geometry = generate(BASE_PARAMS, seed);
      expect(countWalkableDomains(geometry.walkable, geometry.grid.width, geometry.grid.height)).toBe(1);
    }
  });

  it("POSITIVE：房间矩形两两不重叠且全部落在图内", () => {
    const { draft, rooms } = runBlock(BASE_PARAMS);
    expect(rooms.length).toBeGreaterThanOrEqual(5);
    for (const room of rooms) {
      expect(room.x).toBeGreaterThanOrEqual(0);
      expect(room.y).toBeGreaterThanOrEqual(0);
      expect(room.x + room.width).toBeLessThanOrEqual(draft.width);
      expect(room.y + room.height).toBeLessThanOrEqual(draft.height);
    }
    for (let i = 0; i < rooms.length; i++) {
      for (let j = i + 1; j < rooms.length; j++) {
        const a = rooms[i];
        const b = rooms[j];
        const overlaps =
          a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
        expect(overlaps).toBe(false);
      }
    }
  });

  it("POSITIVE：区域数 = 房间数 + walls；roomOfTile 覆盖每格", () => {
    const { draft, rooms } = runBlock(BASE_PARAMS);
    expect(draft.regions.size).toBe(rooms.length + 1);
    for (const index of draft.regionOfTile) {
      expect(index).toBeLessThanOrEqual(rooms.length);
    }
  });
});

describe("slot-rooms 房间元数据与门", () => {
  it("POSITIVE：每房 meta 齐全——中心像素在房间内、doors 非空且为房外环地板格", () => {
    const { draft, rooms } = runBlock(BASE_PARAMS);
    rooms.forEach((room, index) => {
      const meta = draft.regions.get(`${room.type}#${index}`)?.meta as {
        center: number[];
        halfW: number;
        halfH: number;
        doors: number[][];
        type: string;
      };
      // 结构字段齐全
      expect(Array.isArray(meta.center)).toBe(true);
      expect(meta.center).toHaveLength(2);
      expect(typeof meta.halfW).toBe("number");
      expect(typeof meta.halfH).toBe("number");
      expect(Array.isArray(meta.doors)).toBe(true);
      expect(meta.type).toBe(room.type);
      // 中心像素落在房间矩形内
      const [cx, cy] = meta.center;
      expect(cx).toBeGreaterThanOrEqual(room.x * 16);
      expect(cx).toBeLessThanOrEqual((room.x + room.width) * 16);
      expect(cy).toBeGreaterThanOrEqual(room.y * 16);
      expect(cy).toBeLessThanOrEqual((room.y + room.height) * 16);
      expect(meta.halfW).toBe((room.width * 16) / 2);
      expect(meta.halfH).toBe((room.height * 16) / 2);
      // 门非空（每房至少一条走廊连接 → 至少一段门）
      expect(meta.doors.length).toBeGreaterThanOrEqual(1);
      for (const [tx, ty] of meta.doors) {
        // 门格可通行
        expect(draft.walkable[ty * draft.width + tx]).toBe(1);
        // 门格位于房间外环（Chebyshev 距恰为 1）
        const inX = tx >= room.x && tx < room.x + room.width;
        const inY = ty >= room.y && ty < room.y + room.height;
        const adjacent =
          (inX && (ty === room.y - 1 || ty === room.y + room.height)) ||
          (inY && (tx === room.x - 1 || tx === room.x + room.width));
        expect(adjacent).toBe(true);
      }
    });
  });

  it("POSITIVE：任意房中心可达全部门格（BFS 从房 0 中心出发覆盖全部 walkable）", () => {
    const geometry = generate();
    const { width, height } = geometry.grid;
    // 从首个 walkable 格 BFS，覆盖全部 walkable（单连通域的等价断言 + 门全可达）
    let start = geometry.walkable.indexOf(1);
    const seen = new Uint8Array(geometry.walkable.length);
    const stack = [start];
    seen[start] = 1;
    while (stack.length > 0) {
      const index = stack.pop() as number;
      const x = index % width;
      const y = (index - x) / width;
      if (x > 0 && geometry.walkable[index - 1] === 1 && seen[index - 1] === 0) {
        seen[index - 1] = 1;
        stack.push(index - 1);
      }
      if (x < width - 1 && geometry.walkable[index + 1] === 1 && seen[index + 1] === 0) {
        seen[index + 1] = 1;
        stack.push(index + 1);
      }
      if (y > 0 && geometry.walkable[index - width] === 1 && seen[index - width] === 0) {
        seen[index - width] = 1;
        stack.push(index - width);
      }
      if (y < height - 1 && geometry.walkable[index + width] === 1 && seen[index + width] === 0) {
        seen[index + width] = 1;
        stack.push(index + width);
      }
    }
    for (let i = 0; i < geometry.walkable.length; i++) {
      if (geometry.walkable[i] === 1) expect(seen[i]).toBe(1);
    }
    expect(start).toBeGreaterThanOrEqual(0);
  });

  it("POSITIVE：类型缺省输出结构名；roomTypes 配置映射生效（branch 循环取用）", () => {
    // 缺省：类型 ∈ 结构名集合
    const { draft, rooms } = runBlock(BASE_PARAMS);
    const structural = new Set(["path-first", "path-mid", "path-last", "branch"]);
    for (const room of rooms) {
      expect(structural.has(room.type)).toBe(true);
    }
    // 配置映射：首/末/中房语义名 + 支线类型循环取用
    const mapped = runBlock({
      ...BASE_PARAMS,
      roomTypes: { pathFirst: "alpha", pathLast: "omega", pathMid: "mid-name", branch: ["beta", "gamma"] },
    });
    const types = mapped.rooms.map((room) => room.type);
    expect(types[0]).toBe("alpha");
    expect(types[4]).toBe("omega");
    for (let i = 1; i < 4; i++) {
      expect(types[i]).toBe("mid-name");
    }
    // 5 主路径房 + ≤3 支线：支线类型按序循环 beta/gamma/beta…
    const branchTypes = types.slice(5);
    branchTypes.forEach((type, i) => {
      expect(type).toBe(["beta", "gamma"][i % 2]);
    });
    // meta.type 与 region 名一致携带
    mapped.rooms.forEach((room, index) => {
      const meta = mapped.draft.regions.get(`${room.type}#${index}`)?.meta as { type: string };
      expect(meta.type).toBe(room.type);
    });
  });
});

describe("slot-rooms 参数校验与首积木约束", () => {
  it("NEGATIVE：slotsX=1 / slotsY=1 → 抛错点名 params.slotsX/slotsY", () => {
    expect(() => runBlock({ ...BASE_PARAMS, slotsX: 1 })).toThrowError(
      /map "slots-map": slot-rooms params\.slotsX must be an integer >= 2, got 1/,
    );
    expect(() => runBlock({ ...BASE_PARAMS, slotsY: 1 })).toThrowError(
      /params\.slotsY must be an integer >= 2, got 1/,
    );
  });

  it("NEGATIVE：branchCount=5 → 抛错点名 params.branchCount", () => {
    expect(() => runBlock({ ...BASE_PARAMS, branchCount: 5 })).toThrowError(
      /params\.branchCount must be an integer in \[0, 4\], got 5/,
    );
  });

  it("NEGATIVE：roomMaxW 超出槽宽上界 → 抛错点名 params.roomMaxW", () => {
    expect(() => runBlock({ ...BASE_PARAMS, cellW: 10, roomMaxW: 10 })).toThrowError(
      /params\.roomMaxW must be an integer in \[9, 9\], got 10/,
    );
  });

  it("NEGATIVE：floorTile === solidTile → 抛错点名两个语义 id", () => {
    expect(() => runBlock({ ...BASE_PARAMS, floorTile: 2, solidTile: 2 })).toThrowError(
      /params\.floorTile and params\.solidTile must be different semantic ids, both are 2/,
    );
  });

  it("NEGATIVE：roomTypes.branch 非字符串数组 → 抛错", () => {
    expect(() => runBlock({ ...BASE_PARAMS, roomTypes: { branch: "x" } })).toThrowError(
      /params\.roomTypes\.branch must be a non-empty array of strings/,
    );
    expect(() => runBlock({ ...BASE_PARAMS, roomTypes: { branch: [1, 2] } })).toThrowError(
      /params\.roomTypes entries must be non-empty strings, got 1/,
    );
  });

  it("NEGATIVE：tileWidth 非正数 → 抛错点名 params.tileWidth", () => {
    expect(() => runBlock({ ...BASE_PARAMS, tileWidth: 0 })).toThrowError(
      /params\.tileWidth must be a positive number, got 0/,
    );
  });

  it("NEGATIVE：草稿已初始化（非首积木）→ 抛错点名管道顺序约束", () => {
    const draft = createGeometryDraft(KEY);
    draft.width = 10;
    draft.height = 10;
    draft.tiles = new Uint8Array(100);
    const ctx: GenerationContext = { key: KEY, rng: createRng(1), geometry: draft, params: BASE_PARAMS };
    expect(() => slotRooms(ctx)).toThrowError(/slot-rooms must be the first pipeline block/);
  });
});

describe("slot-rooms 全参数化尺寸", () => {
  it("POSITIVE：自定义槽位网格/房间尺寸/走廊宽按配置换算整图", () => {
    const params = {
      ...BASE_PARAMS,
      slotsX: 3,
      slotsY: 3,
      cellW: 20,
      cellH: 16,
      roomMinW: 4,
      roomMinH: 4,
      roomMaxW: 6,
      roomMaxH: 6,
      lastRoomW: 6,
      lastRoomH: 6,
      corridorWidth: 1,
      branchCount: 0,
    };
    const geometry = generate(params);
    expect(geometry.grid).toEqual({ width: 60, height: 48, tileWidth: 16, tileHeight: 16 });
    // branchCount=0 → 只有主路径房 + walls
    expect(geometry.regions.size).toBe(3 + 1);
    expect(countWalkableDomains(geometry.walkable, 60, 48)).toBe(1);
  });

  it("POSITIVE：自定义参数直接复现房尺寸区间（房宽 ∈ [roomMinW, roomMaxW]、末房 = lastRoomW）", () => {
    // 房宽区间经 aux 房间列表断言
    const { rooms } = runBlock({ ...BASE_PARAMS, roomMinW: 5, roomMaxW: 7, lastRoomW: 8 });
    for (const room of rooms) {
      if (room.type === "path-last") {
        expect(room.width).toBe(8);
      } else if (room.type !== "path-first") {
        expect(room.width).toBeGreaterThanOrEqual(5);
        expect(room.width).toBeLessThanOrEqual(7);
      }
    }
  });
});
