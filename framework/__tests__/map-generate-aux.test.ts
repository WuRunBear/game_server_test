/**
 * aux 槽位池测试（framework/__tests__/map-generate-aux.test.ts）。
 *
 * 覆盖方案 A（GeometryDraft.aux 暂存池）验收：
 * - 生命周期：积木内 setAux 写入 → 冻结后的 MapGeometry 无 aux
 *   （类型层无该字段 + 运行时无泄漏）；
 * - 传递：aux 在管道积木间上游写、下游读；
 * - branded 槽位：同槽位常量读写往返；跨 T 槽位赋值/传值是编译错误
 *   （@ts-expect-error 断言，由 pnpm build 的 tsc 全量编译兜底验证——
 *   若品牌失效导致不再报错，tsc 会以「未使用的 @ts-expect-error」报错）；
 * - getAux 未写入时返回 undefined；
 * - 确定性：aux 参与与否不改变几何——同 seed 两次生成深相等，
 *   写 aux 与不写 aux 的同几何积木产出相同内容指纹。
 */
import { describe, expect, it } from "vitest";

import { createGeneratorRegistry, type GeneratorRegistry } from "map/generate/generatorRegistry";
import { buildMapGeometry } from "map/generate/pipeline";
import {
  createGeometryDraft,
  defineAuxSlot,
  getAux,
  setAux,
  type AuxSlot,
  type GeometryDraft,
  type MapGenerationConfig,
} from "map/generate/types";

/** 测试槽位 A：承载 string。 */
const NOTES = defineAuxSlot<string>("test:notes");

/** 测试槽位 B：承载 number[]（与 A 跨 T，供编译期防错配断言）。 */
const COUNTS = defineAuxSlot<number[]>("test:counts");

/** 把草稿填充为合法最小图（2×2，单区域全覆盖）。 */
function fillDraft(draft: GeometryDraft): void {
  draft.width = 2;
  draft.height = 2;
  draft.tileWidth = 16;
  draft.tileHeight = 16;
  draft.tiles = new Uint8Array(4);
  draft.walkable = new Uint8Array(4).fill(1);
  draft.regions.set("region-a", { name: "region-a", meta: {} });
  draft.regionOfTile = new Uint16Array(4);
}

/** 构造注册了给定积木的注册表（积木体只拿草稿，屏蔽上下文细节）。 */
function makeRegistry(
  entries: Array<[string, (draft: GeometryDraft) => void]>,
): GeneratorRegistry {
  const registry = createGeneratorRegistry();
  for (const [id, body] of entries) {
    registry.register(id, (ctx) => body(ctx.geometry));
  }
  return registry;
}

describe("aux 生命周期：仅管道执行期，冻结时丢弃", () => {
  it("POSITIVE：积木内写入 aux，冻结后的 MapGeometry 无 aux（类型层 + 运行时）", () => {
    const registry = makeRegistry([
      ["writer", (draft) => {
        fillDraft(draft);
        setAux(draft, NOTES, "midway-artifact");
      }],
    ]);

    const geometry = buildMapGeometry(
      { key: "aux-map", seed: 1, pipeline: [{ generator: "writer" }] },
      registry,
    );

    // 类型层：MapGeometry 无 aux 字段——@ts-expect-error 由 pnpm build
    // （tsc 全量编译）验证；若未来有人给 MapGeometry 加回 aux 字段，
    // 该指令失效会导致 build 失败，守住「冻结丢弃」契约
    // @ts-expect-error MapGeometry 类型层不存在 aux 字段
    expect(geometry.aux).toBeUndefined();
    // 运行时：冻结对象无 aux 自有属性，无泄漏
    expect(Object.hasOwn(geometry, "aux")).toBe(false);
    expect("aux" in geometry).toBe(false);
  });

  it("POSITIVE：aux 在管道积木间传递（上游写、下游读）", () => {
    let seen: string | undefined;
    const registry = makeRegistry([
      ["upstream", (draft) => setAux(draft, NOTES, "shared-artifact")],
      ["downstream", (draft) => {
        seen = getAux(draft, NOTES);
        fillDraft(draft);
      }],
    ]);

    buildMapGeometry(
      {
        key: "relay-map",
        seed: 1,
        pipeline: [{ generator: "upstream" }, { generator: "downstream" }],
      },
      registry,
    );

    expect(seen).toBe("shared-artifact");
  });
});

describe("branded 槽位：编译期类型隔离", () => {
  it("POSITIVE：同槽位常量 setAux → getAux 读写往返，同槽覆盖", () => {
    const draft = createGeometryDraft("roundtrip");
    setAux(draft, NOTES, "payload");
    expect(getAux(draft, NOTES)).toBe("payload");
    setAux(draft, NOTES, "replaced");
    expect(getAux(draft, NOTES)).toBe("replaced");
  });

  it("NEGATIVE：跨 T 的槽位常量相互赋值是编译错误（@ts-expect-error）", () => {
    // @ts-expect-error 不同 T 的 branded 槽位互不兼容（brand 字段类型不匹配）
    const mismatched: AuxSlot<string[]> = COUNTS;
    expect(mismatched.name).toBe("test:counts");
  });

  it("NEGATIVE：跨 T 的槽位值传递是编译错误（@ts-expect-error）", () => {
    const draft = createGeometryDraft("cross-slot");
    setAux(draft, COUNTS, [7]);
    // @ts-expect-error number[] 槽读出的值不可写入 string 槽
    setAux(draft, NOTES, getAux(draft, COUNTS));
  });

  it("NEGATIVE：无品牌标记的裸对象不可充当槽位（@ts-expect-error）", () => {
    // @ts-expect-error 缺少 brand 字段，裸对象不可赋给 branded 槽位
    const bare: AuxSlot<string> = { name: "test:bare" };
    expect(bare.name).toBe("test:bare");
  });
});

describe("getAux 缺省语义与确定性", () => {
  it("POSITIVE：getAux 未写入时返回 undefined", () => {
    const draft = createGeometryDraft("empty-aux");
    expect(getAux(draft, NOTES)).toBeUndefined();
  });

  it("POSITIVE：同 seed 两次 buildMapGeometry 输出一致（积木写 aux 不改变几何）", () => {
    const registry = makeRegistry([
      ["gen", (draft) => {
        fillDraft(draft);
        setAux(draft, NOTES, "aux-payload");
      }],
    ]);
    const config: MapGenerationConfig = {
      key: "det-map",
      seed: 42,
      pipeline: [{ generator: "gen" }],
    };

    const a = buildMapGeometry(config, registry);
    const b = buildMapGeometry(config, registry);
    expect(b).toEqual(a);
  });

  it("POSITIVE：写 aux 与不写 aux 的同几何积木产出相同内容指纹", () => {
    const plain = makeRegistry([["gen", (draft) => fillDraft(draft)]]);
    const withAux = makeRegistry([
      ["gen", (draft) => {
        fillDraft(draft);
        setAux(draft, NOTES, "aux-payload");
      }],
    ]);
    const config: MapGenerationConfig = {
      key: "fp-map",
      seed: 42,
      pipeline: [{ generator: "gen" }],
    };

    const a = buildMapGeometry(config, plain);
    const b = buildMapGeometry(config, withAux);
    expect(b.version).toBe(a.version);
    expect(b).toEqual(a);
  });
});
