/**
 * 实体演化规则引用完整性校验测试（loadGameDefinition.validateIntegrity 增补段）。
 *
 * 校验对象（只查配置引用存在性，exact 落点合法性归开机全局校验）：
 * - kind（含 template 条目）∈ 原型（entities 配置或 archetype 注册表）；
 * - condition ∈ spawnConditions 注册表；
 * - region ∈ 生成后将存在的区域集合（climate-regions names ∪ 隐式
 *   wilderness ∪ tiled-source zones 产出名，任一来源合法即可）。
 *
 * 失败分支用临时 game 目录驱动真实加载链路（zod → resolveMapConfigs 内联
 * tiled → validateIntegrity），断言错误消息点名违规引用。
 */
import { describe, it, expect, beforeAll, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bootstrapFramework, loadGameDefinition } from "framework/index";
import type { EntityRule } from "map/evolution/schema";

beforeAll(() => {
  bootstrapFramework();
});

const GAME_JSON = {
  id: "validate-integrity-fixture",
  tickRate: 20,
  map: { registry: "./maps/registry.json", entityRules: "./maps/entity-rules.json" },
  entities: "./entities/*.json",
  systems: [],
};

const REGISTRY_JSON = {
  maps: {
    m1: {
      kind: "pipeline",
      seed: 1,
      initialAgeTicks: 0,
      pipeline: [
        { generator: "climate-regions", params: { names: ["alpha", "beta"], style: "noise" } },
      ],
    },
    tm: { kind: "tiled", path: "tiled.json", initialAgeTicks: 0 },
  },
};

const TILED_JSON = {
  layers: [
    {
      type: "objectgroup",
      name: "zones",
      objects: [
        {
          id: 1,
          type: "zone",
          x: 0,
          y: 0,
          width: 8,
          height: 8,
          properties: [
            { name: "zoneId", type: "int", value: 1 },
            { name: "name", type: "string", value: "z1" },
          ],
        },
      ],
    },
  ],
};

/** 在临时目录组装一份最小 game 配置（原型 kind_a + 双图注册表 + 给定规则）。 */
function writeGameDir(rules: EntityRule[]): string {
  const dir = mkdtempSync(join(tmpdir(), "validate-integrity-"));
  mkdirSync(join(dir, "entities"), { recursive: true });
  mkdirSync(join(dir, "maps"), { recursive: true });
  writeFileSync(join(dir, "game.json"), JSON.stringify(GAME_JSON));
  writeFileSync(join(dir, "entities", "kind.json"), JSON.stringify({ kind: "kind_a", components: {} }));
  writeFileSync(join(dir, "maps", "registry.json"), JSON.stringify(REGISTRY_JSON));
  writeFileSync(join(dir, "maps", "tiled.json"), JSON.stringify(TILED_JSON));
  writeFileSync(join(dir, "maps", "entity-rules.json"), JSON.stringify({ rules }));
  return dir;
}

function loadFrom(dir: string): unknown {
  return loadGameDefinition({ gameJsonPath: join(dir, "game.json") });
}

describe("validateIntegrity：实体演化规则引用校验", () => {
  const dirs: string[] = [];
  const makeDir = (rules: EntityRule[]): string => {
    const dir = writeGameDir(rules);
    dirs.push(dir);
    return dir;
  };

  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it("U5：kind 不在原型中 → 抛错并点名 kind", () => {
    const dir = makeDir([
      { mode: "density", map: "m1", region: "alpha", kind: "no_such_kind", max: 1, every: 10 },
    ]);
    expect(() => loadFrom(dir)).toThrow(/no_such_kind/);
  });

  it("U5：template 条目 kind 不在原型中 → 抛错并点名该 kind", () => {
    const dir = makeDir([
      {
        mode: "template",
        map: "m1",
        region: "alpha",
        kind: "kind_a",
        max: 1,
        every: 10,
        template: [{ kind: "ghost_kind", dx: 1, dy: 0 }],
      },
    ]);
    expect(() => loadFrom(dir)).toThrow(/ghost_kind/);
  });

  it("U5：condition 未注册 → 抛错并点名条件名", () => {
    const dir = makeDir([
      { mode: "density", map: "m1", region: "alpha", kind: "kind_a", max: 1, every: 10, condition: "notACondition" },
    ]);
    expect(() => loadFrom(dir)).toThrow(/notACondition/);
  });

  it("U5：region 不由任何来源产出 → 抛错并点名 map 与 region", () => {
    const dir = makeDir([
      { mode: "density", map: "m1", region: "nowhere", kind: "kind_a", max: 1, every: 10 },
    ]);
    expect(() => loadFrom(dir)).toThrow(/"m1".*"nowhere"/);
  });

  it("region 为隐式 wilderness → 通过", () => {
    const dir = makeDir([
      { mode: "density", map: "m1", region: "wilderness", kind: "kind_a", max: 1, every: 10 },
    ]);
    expect(() => loadFrom(dir)).not.toThrow();
  });

  it("region 为 climate-regions 声明名 → 通过", () => {
    const dir = makeDir([
      { mode: "density", map: "m1", region: "beta", kind: "kind_a", max: 1, every: 10 },
    ]);
    expect(() => loadFrom(dir)).not.toThrow();
  });

  it("region 为 tiled zones 产出名 → 通过", () => {
    const dir = makeDir([
      { mode: "density", map: "tm", region: "z1", kind: "kind_a", max: 1, every: 10 },
    ]);
    expect(() => loadFrom(dir)).not.toThrow();
  });
});
