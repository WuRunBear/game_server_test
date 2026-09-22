/**
 * tile-units 单位归一化测试（framework/__tests__/tile-units.test.ts）。
 *
 * 覆盖 TILE-UNITS-PLAN §3.5 全部用例：
 * 1. 距离换算：wTiles 0.5 → w 8（tilePx=16），Tiles 键被删除；
 * 2. 速度换算：maxMoveSpeedTiles 2 → maxMoveSpeed 32（格/秒 → px/秒，同一换算规则）；
 * 3. 冲突抛错：同一对象内 px 裸键与 Tiles 键并存 → 抛错含路径，嵌套对象与
 *    数组元素内同样生效；
 * 4. 非法值（负数/非有限数/非数值）抛错含路径；
 * 5. px 裸键透传不变；无 Tiles 键的结构原样通过（原地转换，引用不变）；
 * 6. 端到端：wTiles 0.5 的原型经 loadGameDefinition → createGameInstance →
 *    spawnEntity 后 Size.w[eid] === 8。
 *
 * 另附 world.tile schema（A1）的最小校验：非方形 refine 抛错、缺省 16×16。
 */
import { describe, it, expect, beforeAll, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  bootstrapFramework,
  loadGameDefinition,
  createGameInstance,
  spawnEntity,
  getRegistries,
  normalizeTileUnits,
  GameDefinitionSchema,
} from "framework/index";
import { Size } from "framework/components/size";

beforeAll(() => {
  bootstrapFramework();
});

describe("normalizeTileUnits（tile-units 归一化）", () => {
  it("距离换算：wTiles 0.5 → w 8（tilePx=16），Tiles 键被删除（嵌套与数组深度遍历）", () => {
    const config = {
      wTiles: 0.5,
      nested: { hTiles: 0.25 },
      list: [{ wTiles: 2 }, { wTiles: 0 }],
    };
    normalizeTileUnits(config, 16);

    expect(config).toEqual({
      w: 8,
      nested: { h: 4 },
      list: [{ w: 32 }, { w: 0 }],
    });
    expect(config).not.toHaveProperty("wTiles");
    expect(config.nested).not.toHaveProperty("hTiles");
    expect(config.list[0]).not.toHaveProperty("wTiles");
    expect(config.list[1]).not.toHaveProperty("wTiles");
  });

  it("速度换算：maxMoveSpeedTiles 2 → maxMoveSpeed 32（格/秒 → px/秒，同一换算规则）", () => {
    const config = { maxMoveSpeedTiles: 2 };
    normalizeTileUnits(config, 16);

    expect(config).toEqual({ maxMoveSpeed: 32 });
    expect(config).not.toHaveProperty("maxMoveSpeedTiles");
  });

  it("冲突抛错：同一对象内 px 裸键与 Tiles 键并存 → 抛错含路径", () => {
    expect(() => normalizeTileUnits({ w: 16, wTiles: 0.5 }, 16)).toThrowError(
      /conflicting keys "w" and "wTiles"/,
    );
    // 与键序无关（px 裸键在后声明同样抛错）
    expect(() => normalizeTileUnits({ wTiles: 0.5, w: 16 }, 16)).toThrowError(
      /conflicting keys "w" and "wTiles"/,
    );
  });

  it("冲突抛错：嵌套对象与数组元素内同样生效（错误含路径）", () => {
    expect(() => normalizeTileUnits({ outer: { inner: { w: 16, wTiles: 0.5 } } }, 16)).toThrowError(
      /conflicting keys "w" and "wTiles" at "outer\.inner"/,
    );
    expect(() => normalizeTileUnits({ list: [{ w: 16, wTiles: 0.5 }] }, 16)).toThrowError(
      /conflicting keys "w" and "wTiles" at "list\[0\]"/,
    );
  });

  it("非法值（负数/非有限数/非数值）抛错且错误含路径", () => {
    expect(() => normalizeTileUnits({ wTiles: -1 }, 16)).toThrowError(/"wTiles".*finite number >= 0/);
    expect(() => normalizeTileUnits({ wTiles: Number.NaN }, 16)).toThrowError(/"wTiles"/);
    expect(() => normalizeTileUnits({ wTiles: Number.POSITIVE_INFINITY }, 16)).toThrowError(/"wTiles"/);
    expect(() => normalizeTileUnits({ wTiles: "5" }, 16)).toThrowError(/"wTiles"/);
    // 嵌套路径：错误消息定位到完整键路径
    expect(() => normalizeTileUnits({ a: { bTiles: -1 } }, 16)).toThrowError(/"a\.bTiles"/);
    expect(() => normalizeTileUnits({ list: [{ wTiles: -1 }] }, 16)).toThrowError(/"list\[0\]\.wTiles"/);
  });

  it("0 为合法值（≥ 0 下界）", () => {
    const config = { wTiles: 0 };
    expect(() => normalizeTileUnits(config, 16)).not.toThrow();
    expect(config).toEqual({ w: 0 });
  });

  it("px 裸键透传不变；无 Tiles 键的结构原样通过（原地转换，不复制不改引用）", () => {
    const nested = { w: 16 };
    const listItem = { x: 1 };
    const config = { w: 16, maxMoveSpeed: 200, nested, list: [listItem] };
    normalizeTileUnits(config, 16);

    expect(config).toEqual({ w: 16, maxMoveSpeed: 200, nested: { w: 16 }, list: [{ x: 1 }] });
    expect(config.nested).toBe(nested);
    expect(config.list[0]).toBe(listItem);
  });
});

describe("world.tile schema（A1）", () => {
  it("非方形 tile（width !== height）→ refine 抛错，错误说明非方形暂不支持", () => {
    const result = GameDefinitionSchema.safeParse({
      id: "x",
      tickRate: 20,
      world: { tile: { width: 16, height: 32 } },
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.message).toMatch(/non-square tile .* is not supported yet/);
    }
  });

  it("world 段缺省 → tile 默认 16×16（兼容旧配置）", () => {
    const result = GameDefinitionSchema.safeParse({ id: "x", tickRate: 20 });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.world).toEqual({ tile: { width: 16, height: 16 } });
    }
  });
});

// ---------------------------------------------------------------------------
// 端到端（§3.5 #6）：临时 game 目录走真实加载链 → spawnEntity
// ---------------------------------------------------------------------------

const E2E_GAME_JSON = {
  id: "tile-units-e2e",
  tickRate: 20,
  world: { tile: { width: 16, height: 16 } },
  entities: "./entities/*.json",
  systems: [],
};

/** 组装最小 game 目录：单原型 Size 走 Tiles 表达（wTiles 0.5 / hTiles 0.25）。 */
function writeE2eGameDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "tile-units-e2e-"));
  mkdirSync(join(dir, "entities"), { recursive: true });
  writeFileSync(join(dir, "game.json"), JSON.stringify(E2E_GAME_JSON));
  writeFileSync(
    join(dir, "entities", "sized.json"),
    JSON.stringify({
      kind: "tu-sized",
      components: { Size: { wTiles: 0.5, hTiles: 0.25 } },
    }),
  );
  return dir;
}

describe("tile-units 端到端（loadGameDefinition → spawnEntity）", () => {
  const dirs: string[] = [];

  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it("wTiles 0.5 的原型经 spawnEntity 后 Size.w[eid] === 8", () => {
    const dir = writeE2eGameDir();
    dirs.push(dir);

    const def = loadGameDefinition({ gameJsonPath: join(dir, "game.json") });

    // 加载期已换算：原型配置为 px 形态，Tiles 键已删除
    expect(def.resolvedEntities[0].components["Size"]).toEqual({ w: 8, h: 4 });

    const instance = createGameInstance(def);
    const archetype = instance.world.archetypes.get("tu-sized");
    const eid = spawnEntity(instance.world, archetype, getRegistries().componentRegistry);

    expect(Size.w[eid]).toBe(8);
    expect(Size.h[eid]).toBe(4);
  });
});
