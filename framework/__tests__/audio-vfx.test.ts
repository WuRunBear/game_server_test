/**
 * CC-11 Audio / VFX 测试。
 *
 * 覆盖：
 * - 表现 schema：audio/vfx 段解析、查询、深度冻结、事件引用完整性（未知
 *   sfx/effect id 加载期报错）、禁止资源字段（assets/files 等严格报错）；
 * - `loadGameDefinition` 按约定加载 `presentation/audio.json` / `vfx.json`
 *   并与其它表现文件合并（跨文件重复 id 报错）；
 * - manifest 的 audio/vfx 形状与 id 集合、无配置空结构、contentVersion 随
 *   audio/vfx 变化；
 * - `emitClientEvent` 按事件 type 把 `sfx`/`vfx` 并入 data（无映射不加键、
 *   不改调用方数据、不外泄 eid/资源路径）。
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { bootstrapFramework } from "framework/bootstrap";
import {
  createDefaultGameDefinition,
  loadGameDefinition,
} from "framework/bootstrap/loadGameDefinition";
import {
  audioIdsForEvent,
  clearPresentation,
  getAudioPresentation,
  getVfxPresentation,
  loadPresentation,
  validateAudioVfxReferences,
  vfxIdsForEvent,
} from "framework/content/presentation";
import {
  buildClientManifest,
  type ClientManifest,
} from "framework/content/manifest";
import type { LoadedGameDefinition } from "framework/config/schema/GameDefinitionSchema";
import type { PresentationConfig } from "framework/config/schema/PresentationSchema";
import {
  collectEventsForClient,
  drainClientEventOutbox,
  emitClientEvent,
} from "framework/simulation/clientEvents";
import { createGameWorld } from "framework/world";

/* -------------------------------------------------------------------------- */
/* 最小音频/VFX 配置 fixture（框架测试不依赖具体游戏名词）                       */
/* -------------------------------------------------------------------------- */

const VALID_AUDIO = {
  music: { bgm_a: {} },
  ambient: { amb_a: {} },
  sfx: { hit_a: {}, hit_b: {} },
  events: { hit: ["hit_a", "hit_b"] },
};

const VALID_VFX = {
  effects: { fx_a: {} },
  events: { hit: ["fx_a"] },
};

afterEach(() => {
  clearPresentation();
});

describe("audio/vfx presentation: 解析与查询", () => {
  it("合法配置深度冻结；按事件 type 查询 id 数组，未知 type 返回空数组", () => {
    const config = loadPresentation({ audio: VALID_AUDIO, vfx: VALID_VFX });

    expect(Object.isFrozen(config)).toBe(true);
    expect(Object.isFrozen(config.audio)).toBe(true);
    expect(Object.isFrozen(config.audio!.sfx)).toBe(true);
    expect(Object.isFrozen(config.vfx)).toBe(true);

    expect(getAudioPresentation()?.sfx).toEqual({ hit_a: {}, hit_b: {} });
    expect(getVfxPresentation()?.effects).toEqual({ fx_a: {} });
    expect(audioIdsForEvent("hit")).toEqual(["hit_a", "hit_b"]);
    expect(vfxIdsForEvent("hit")).toEqual(["fx_a"]);
    expect(audioIdsForEvent("no-such-event")).toEqual([]);
    expect(vfxIdsForEvent("no-such-event")).toEqual([]);

    // 返回值是副本：调用方修改不影响已登记配置
    audioIdsForEvent("hit").push("mutated");
    expect(audioIdsForEvent("hit")).toEqual(["hit_a", "hit_b"]);
  });

  it("事件引用未知 sfx id 即加载报错，且不登记半成品配置", () => {
    expect(() =>
      loadPresentation({
        audio: {
          sfx: { known: {} },
          events: { hit: ["known", "ghost_sfx"] },
        },
      }),
    ).toThrow(/audio event "hit" references unknown sfx "ghost_sfx"/);

    expect(getAudioPresentation()).toBeUndefined();
  });

  it("事件引用未知 effect id 即加载报错", () => {
    expect(() =>
      loadPresentation({
        vfx: {
          effects: { known: {} },
          events: { death: ["ghost_vfx"] },
        },
      }),
    ).toThrow(/vfx event "death" references unknown effect "ghost_vfx"/);
  });

  it("资源字段（assets/files/path）被严格 schema 拒绝", () => {
    expect(() => loadPresentation({ audio: { assets: {} } })).toThrow();
    expect(() => loadPresentation({ audio: { files: [] } })).toThrow();
    expect(() =>
      loadPresentation({
        audio: { sfx: { hit_a: { assets: ["res://hit.wav"] } } },
      }),
    ).toThrow();
    expect(() =>
      loadPresentation({
        vfx: { effects: { fx_a: { path: "res://fx.tscn" } } },
      }),
    ).toThrow();
  });

  it("validateAudioVfxReferences 纯函数返回全部引用错误（不抛）", () => {
    const errors = validateAudioVfxReferences({
      tileSemantics: {},
      maps: {},
      audio: {
        music: {},
        ambient: {},
        sfx: { known: {} },
        events: { hit: ["known", "missing"], gather: ["missing2"] },
      },
      vfx: {
        effects: {},
        events: { hit: ["missing_fx"] },
      },
    });

    expect(errors).toEqual([
      'presentation: audio event "hit" references unknown sfx "missing"',
      'presentation: audio event "gather" references unknown sfx "missing2"',
      'presentation: vfx event "hit" references unknown effect "missing_fx"',
    ]);
  });

  it("无 audio/vfx 段时查询返回 undefined / 空数组", () => {
    loadPresentation({});
    expect(getAudioPresentation()).toBeUndefined();
    expect(getVfxPresentation()).toBeUndefined();
    expect(audioIdsForEvent("hit")).toEqual([]);
    expect(vfxIdsForEvent("hit")).toEqual([]);
    expect(validateAudioVfxReferences({ tileSemantics: {}, maps: {} })).toEqual([]);
  });
});

/* -------------------------------------------------------------------------- */
/* loadGameDefinition：约定路径加载与跨文件合并                                 */
/* -------------------------------------------------------------------------- */

describe("loadGameDefinition: audio.json / vfx.json 约定路径", () => {
  const dirs: string[] = [];

  function makeGameDir(files: {
    maps?: unknown;
    entities?: unknown;
    audio?: unknown;
    vfx?: unknown;
  }): string {
    const dir = mkdtempSync(join(tmpdir(), "audio-vfx-fixture-"));
    dirs.push(dir);
    mkdirSync(join(dir, "maps"), { recursive: true });
    mkdirSync(join(dir, "presentation"), { recursive: true });
    writeFileSync(
      join(dir, "game.json"),
      JSON.stringify({ id: "audio-vfx-fixture", tickRate: 20, map: { registry: "./maps/registry.json" } }),
    );
    writeFileSync(join(dir, "maps", "registry.json"), JSON.stringify({ maps: {} }));
    for (const [name, content] of Object.entries(files)) {
      if (content === undefined) continue;
      writeFileSync(join(dir, "presentation", `${name}.json`), JSON.stringify(content));
    }
    return dir;
  }

  afterAll(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it("按约定加载 audio.json / vfx.json 并合并进 resolvedPresentation", () => {
    const dir = makeGameDir({
      maps: { maps: {} },
      audio: { audio: VALID_AUDIO },
      vfx: { vfx: VALID_VFX },
    });
    const loaded = loadGameDefinition({ gameJsonPath: join(dir, "game.json") });

    expect(loaded.resolvedPresentation?.audio?.sfx).toEqual({ hit_a: {}, hit_b: {} });
    expect(loaded.resolvedPresentation?.vfx?.effects).toEqual({ fx_a: {} });
    expect(audioIdsForEvent("hit")).toEqual(["hit_a", "hit_b"]);
    expect(vfxIdsForEvent("hit")).toEqual(["fx_a"]);
  });

  it("audio.json 中的未知 sfx 引用在加载期报错", () => {
    const dir = makeGameDir({
      audio: { audio: { sfx: { known: {} }, events: { hit: ["unknown"] } } },
    });
    expect(() => loadGameDefinition({ gameJsonPath: join(dir, "game.json") })).toThrow(
      /references unknown sfx "unknown"/,
    );
  });

  it("跨文件重复音频 id / 事件映射即加载报错", () => {
    const dir = makeGameDir({
      maps: { audio: { sfx: { dup: {} } } },
      audio: { audio: { sfx: { dup: {} } } },
    });
    expect(() => loadGameDefinition({ gameJsonPath: join(dir, "game.json") })).toThrow(
      /duplicate audio sfx "dup"/,
    );

    const dir2 = makeGameDir({
      maps: { audio: { sfx: { hit: {} }, events: { hit: ["hit"] } } },
      audio: { audio: { events: { hit: ["hit"] } } },
    });
    expect(() => loadGameDefinition({ gameJsonPath: join(dir2, "game.json") })).toThrow(
      /duplicate audio event "hit"/,
    );
  });

  it("无表现配置时 manifest 的 audio/vfx 为空结构，事件挂接不崩", () => {
    const dir = makeGameDir({});
    const loaded = loadGameDefinition({ gameJsonPath: join(dir, "game.json") });
    expect(loaded.resolvedPresentation).toBeUndefined();

    const manifest = buildClientManifest(loaded);
    expect(manifest.audio).toEqual({ music: [], ambient: [], sfx: [], events: {} });
    expect(manifest.vfx).toEqual({ effects: [], events: {} });
    expect(manifest.animations).toEqual({});

    const world = createGameWorld(50);
    expect(emitClientEvent(world, "hit", { damage: 1 }, "world")).toBeDefined();
    const [event] = drainClientEventOutbox(world);
    expect(event?.data).toEqual({ damage: 1 });
    expect(event?.data).not.toHaveProperty("sfx");
    expect(event?.data).not.toHaveProperty("vfx");
  });

  it("默认游戏定义（无表现配置）的 manifest 段仍为固定空结构", () => {
    const manifest = buildClientManifest(createDefaultGameDefinition());
    expect(manifest.audio).toEqual({ music: [], ambient: [], sfx: [], events: {} });
    expect(manifest.vfx).toEqual({ effects: [], events: {} });
  });
});

/* -------------------------------------------------------------------------- */
/* 真实 game/ 配置：manifest 形状与 contentVersion                              */
/* -------------------------------------------------------------------------- */

describe("manifest: 真实 game/ 的 audio/vfx 段", () => {
  let gameDef: LoadedGameDefinition;
  let manifest: ClientManifest;

  beforeAll(() => {
    bootstrapFramework();
    gameDef = loadGameDefinition({ gameJsonPath: "game/game.json" });
    manifest = buildClientManifest(gameDef);
  });

  it("audio 段提供 music/ambient/sfx id 数组与事件映射", () => {
    expect(Object.isFrozen(gameDef.resolvedPresentation?.audio)).toBe(true);
    expect(manifest.audio.music).toContain("island_bgm");
    expect(manifest.audio.ambient).toContain("island_day");
    expect(manifest.audio.sfx).toEqual(
      expect.arrayContaining(["sfx_hit", "sfx_chop", "sfx_death", "sfx_craft"]),
    );
    expect(manifest.audio.events).toMatchObject({
      hit: ["sfx_hit"],
      gather: ["sfx_chop"],
      death: ["sfx_death"],
      "craft-complete": ["sfx_craft"],
      "action-start": ["sfx_chop"],
    });
    // id 数组稳定排序（字典序），便于 ETag/跨进程比较
    expect(manifest.audio.sfx).toEqual([...manifest.audio.sfx].sort());
    expect(manifest.audio.events.hit).toEqual(["sfx_hit"]);
  });

  it("vfx 段提供 effect id 数组与事件映射，animations 仍为空", () => {
    expect(manifest.vfx.effects).toEqual(expect.arrayContaining(["vfx_hit", "vfx_death", "vfx_chop"]));
    expect(manifest.vfx.events).toMatchObject({
      hit: ["vfx_hit"],
      death: ["vfx_death"],
      gather: ["vfx_chop"],
    });
    expect(manifest.vfx.effects).toEqual([...manifest.vfx.effects].sort());
    expect(manifest.animations).toEqual({});
  });

  it("maps 的 ambientId / musicId 都能在 audio 清单中解析", () => {
    for (const map of manifest.maps) {
      if (map.musicId !== undefined) {
        expect(manifest.audio.music, map.id).toContain(map.musicId);
      }
      if (map.ambientId !== undefined) {
        expect(manifest.audio.ambient, map.id).toContain(map.ambientId);
      }
    }
  });

  it("manifest 中只有不透明 id（无资源路径 / eid）", () => {
    const audioIds = [
      ...manifest.audio.music,
      ...manifest.audio.ambient,
      ...manifest.audio.sfx,
      ...Object.values(manifest.audio.events).flat(),
    ];
    const vfxIds = [
      ...manifest.vfx.effects,
      ...Object.values(manifest.vfx.events).flat(),
    ];
    for (const id of [...audioIds, ...vfxIds]) {
      expect(id).not.toMatch(/[/\\.]|^res:|^eid/);
    }
    expect(JSON.stringify(manifest.audio)).not.toContain("eid");
    expect(JSON.stringify(manifest.vfx)).not.toContain("eid");
  });

  it("contentVersion 随 audio/vfx 配置变化", () => {
    const base = structuredClone(gameDef.resolvedPresentation!) as PresentationConfig;

    const addedSfx = structuredClone(base);
    addedSfx.audio!.sfx["sfx_extra"] = {};
    expect(buildClientManifest(gameDef, { presentation: addedSfx }).contentVersion).not.toBe(
      manifest.contentVersion,
    );

    const changedEvent = structuredClone(base);
    changedEvent.audio!.events["hit"] = ["sfx_hit", "sfx_chop"];
    expect(buildClientManifest(gameDef, { presentation: changedEvent }).contentVersion).not.toBe(
      manifest.contentVersion,
    );

    const addedVfx = structuredClone(base);
    addedVfx.vfx!.effects["vfx_extra"] = {};
    expect(buildClientManifest(gameDef, { presentation: addedVfx }).contentVersion).not.toBe(
      manifest.contentVersion,
    );

    const changedVfxEvent = structuredClone(base);
    changedVfxEvent.vfx!.events["hit"] = ["vfx_death"];
    expect(buildClientManifest(gameDef, { presentation: changedVfxEvent }).contentVersion).not.toBe(
      manifest.contentVersion,
    );
  });
});

/* -------------------------------------------------------------------------- */
/* emitClientEvent：按 type 挂 sfx/vfx                                         */
/* -------------------------------------------------------------------------- */

describe("emitClientEvent: 音频/VFX id 挂接", () => {
  it("hit 事件带 sfx/vfx；无映射事件不加键；不修改调用方 data", () => {
    loadPresentation({ audio: VALID_AUDIO, vfx: VALID_VFX });
    const world = createGameWorld(50);
    const original = { attacker: 7, target: 8, damage: 3 };

    emitClientEvent(world, "hit", original, "world");
    emitClientEvent(world, "quest-complete", { player: 7 }, "world");

    const events = drainClientEventOutbox(world);
    expect(events).toHaveLength(2);
    expect(events[0]!.data).toEqual({
      attacker: 7,
      target: 8,
      damage: 3,
      sfx: ["hit_a", "hit_b"],
      vfx: ["fx_a"],
    });
    expect(events[1]!.data).toEqual({ player: 7 });
    expect(events[1]!.data).not.toHaveProperty("sfx");
    expect(events[1]!.data).not.toHaveProperty("vfx");

    // 原始载荷不被就地修改（调用方可能复用）
    expect(original).toEqual({ attacker: 7, target: 8, damage: 3 });
  });

  it("过滤/出网后的 data 仍只含 networkId 与不透明 id", () => {
    loadPresentation({ audio: VALID_AUDIO, vfx: VALID_VFX });
    const world = createGameWorld(50);
    emitClientEvent(world, "hit", { attacker: 7, target: 8 }, "world");

    const viewer = { eid: 1, mapId: "map-a", x: 0, y: 0 };
    const [event] = collectEventsForClient(drainClientEventOutbox(world), viewer);

    expect(event?.data).toEqual({
      attacker: 7,
      target: 8,
      sfx: ["hit_a", "hit_b"],
      vfx: ["fx_a"],
    });
    const serialized = JSON.stringify(event);
    expect(serialized).not.toContain("eid");
    expect(serialized).not.toContain("res://");
    expect(serialized).not.toContain(".png");
    expect(serialized).not.toContain(".wav");
  });

  it("调用方显式提供的 sfx 优先于配置映射", () => {
    loadPresentation({ audio: VALID_AUDIO, vfx: VALID_VFX });
    const world = createGameWorld(50);

    emitClientEvent(world, "hit", { damage: 1, sfx: ["custom"] }, "world");
    const [event] = drainClientEventOutbox(world);

    expect(event?.data).toEqual({
      damage: 1,
      sfx: ["custom"],
      vfx: ["fx_a"],
    });
  });

  it("无音频/VFX 配置时事件照常入队且无 sfx/vfx 键", () => {
    clearPresentation();
    const world = createGameWorld(50);

    emitClientEvent(world, "hit", { damage: 1 }, "world");
    const [event] = drainClientEventOutbox(world);

    expect(event?.type).toBe("hit");
    expect(event?.data).toEqual({ damage: 1 });
    expect(event?.data).not.toHaveProperty("sfx");
    expect(event?.data).not.toHaveProperty("vfx");
  });
});
