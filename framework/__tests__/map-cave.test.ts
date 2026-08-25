/**
 * cave 内置地图生成器（元胞自动机）测试。
 *
 * 覆盖 buildMapRuntime 通过 generatorId="cave" 走生成器注册表产出地图：
 * - 同种子可复现（blocked 字节一致 + 玩家坐标一致）；
 * - 玩家出生在地面格，且位于最大地面连通分量内；
 * - 边界一圈恒为墙；
 * - 玩家像素坐标在界内且对齐 tile 网格；
 * - npcSpawns 可选透传（缺省为空数组）；
 * - 内建覆盖内侧的默认区域（id 1, name "default"）。
 */
import { beforeAll, describe, expect, it } from "vitest";
import { bootstrapFramework } from "framework/index";
import { buildMapRuntime } from "map";
import type { GeneratedMapSource, MapRuntime } from "map";

beforeAll(() => {
  // 全局引导一次：注册表是幂等单例，buildMapRuntime 依赖内置生成器
  bootstrapFramework();
});

const WIDTH = 32;
const HEIGHT = 32;
const TILE = 16;

/** 构造一个指向 "cave" 生成器的生成地图来源（可追加额外字段如 npcSpawns）。 */
function caveSource(seed: number, extra: Record<string, unknown> = {}): GeneratedMapSource {
  return {
    kind: "generated",
    generatorId: "cave",
    id: "cave",
    name: "cave",
    seed,
    width: WIDTH,
    height: HEIGHT,
    tileWidth: TILE,
    tileHeight: TILE,
    ...extra,
  } as GeneratedMapSource;
}

/** 4 向连通分量统计：返回各地面连通分量（成员格索引 + 大小），遍历序按 idx 升序。 */
function floorComponents(blocked: Uint8Array, w: number, h: number): Array<{ size: number; cells: number[] }> {
  const visited = new Uint8Array(blocked.length);
  const components: Array<{ size: number; cells: number[] }> = [];
  for (let idx = 0; idx < blocked.length; idx++) {
    if (blocked[idx] !== 0 || visited[idx]) continue;
    const stack = [idx];
    visited[idx] = 1;
    const cells: number[] = [];
    while (stack.length) {
      const cur = stack.pop()!;
      cells.push(cur);
      const cx = cur % w;
      const cy = Math.floor(cur / w);
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
        const nx = cx + dx;
        const ny = cy + dy;
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
        const ni = ny * w + nx;
        if (blocked[ni] === 0 && !visited[ni]) {
          visited[ni] = 1;
          stack.push(ni);
        }
      }
    }
    components.push({ size: cells.length, cells });
  }
  return components;
}

describe("cave 生成器（元胞自动机）", () => {
  it("同种子（seed=2）可复现：blocked 字节一致，玩家坐标一致", () => {
    const a = buildMapRuntime(caveSource(2));
    const b = buildMapRuntime(caveSource(2));
    expect(Array.from(a.blocked)).toEqual(Array.from(b.blocked));
    expect(a.spawns.player).toEqual(b.spawns.player);
  });

  it("玩家出生在地面格，且所在连通分量大小 = 最大分量大小", () => {
    const runtime: MapRuntime = buildMapRuntime(caveSource(2));
    const { blocked, grid } = runtime;
    const player = runtime.spawns.player!;
    const tx = Math.floor(player.x / grid.tileWidth);
    const ty = Math.floor(player.y / grid.tileHeight);
    const idx = ty * grid.width + tx;
    // 出生点所在格必须是地面（0）
    expect(blocked[idx]).toBe(0);

    const components = floorComponents(blocked, grid.width, grid.height);
    const maxSize = Math.max(...components.map((c) => c.size));
    const playerComponent = components.find((c) => c.cells.includes(idx))!;
    expect(playerComponent.size).toBe(maxSize);
  });

  it("边界一圈恒为墙", () => {
    const runtime = buildMapRuntime(caveSource(2));
    const { blocked, grid } = runtime;
    for (const x of [0, grid.width - 1]) {
      for (let y = 0; y < grid.height; y++) {
        expect(blocked[y * grid.width + x]).toBe(1);
      }
    }
    for (const y of [0, grid.height - 1]) {
      for (let x = 0; x < grid.width; x++) {
        expect(blocked[y * grid.width + x]).toBe(1);
      }
    }
  });

  it("玩家像素坐标在界内，且对齐 tile 网格（32×32 / tile16）", () => {
    const runtime = buildMapRuntime(caveSource(2));
    const player = runtime.spawns.player!;
    const mapPixelW = WIDTH * TILE;
    const mapPixelH = HEIGHT * TILE;
    expect(player.x).toBeGreaterThan(0);
    expect(player.x).toBeLessThan(mapPixelW);
    expect(player.y).toBeGreaterThan(0);
    expect(player.y).toBeLessThan(mapPixelH);
    // tile 中心对齐：tile16 时中心 ≡ 8 (mod 16)
    expect(player.x % TILE).toBe(TILE / 2);
    expect(player.y % TILE).toBe(TILE / 2);
  });

  it("npcSpawns 可选：传入时锚定到玩家出生点，缺省为空数组", () => {
    const withNpc = buildMapRuntime(
      caveSource(2, { npcSpawns: [{ kind: "guard", offsetTiles: [1, 0], zoneId: 1 }] }),
    );
    expect(withNpc.spawns.npcs).toHaveLength(1);
    const npc = withNpc.spawns.npcs[0];
    expect(npc.kind).toBe("guard");
    expect(npc.pos.x).toBe(withNpc.spawns.player!.x + TILE * 1);
    expect(npc.pos.y).toBe(withNpc.spawns.player!.y + TILE * 0);
    expect(npc.zoneId).toBe(1);

    const noNpc = buildMapRuntime(caveSource(2));
    expect(noNpc.spawns.npcs).toEqual([]);
  });

  it("包含一个覆盖地图内侧的默认区域（id 1, name default）", () => {
    const runtime = buildMapRuntime(caveSource(2));
    expect(runtime.zones).toHaveLength(1);
    expect(runtime.zones[0].id).toBe(1);
    expect(runtime.zones[0].name).toBe("default");
  });
});
