/**
 * client-schema 一致性测试（F-42 / 批次 C）。
 *
 * 用 `@colyseus/schema` 的 schema-codegen 对服务端 schema 重新生成客户端副本，
 * 与已提交的 `src/network/colyseus/client-schema/schema.ts` 逐行（忽略注释）
 * 比较：字段名、顺序、类型、装饰器任何差异即失败。实现见 tools/schemaCheck.ts，
 * 与 `pnpm schema:check` 同源，避免测试与 CI 两套逻辑漂移。
 *
 * 文件头/行内注释不参与比较——副本保留协议变更记录与生成命令说明。
 */
import { describe, it, expect } from "vitest";

import { checkClientSchema, normalizeSchemaSource } from "../../tools/schemaCheck";

describe("client-schema 一致性（codegen）", () => {
  it("已提交副本与 schema-codegen 生成物一致（字段名/顺序/类型）", () => {
    const result = checkClientSchema();
    expect(
      result.ok,
      `client-schema 与服务端 schema 不一致，运行 \`pnpm schema:gen\` 重新生成：\n${result.diff}`,
    ).toBe(true);
  });

  it("归一化只去掉空行与注释（保留字段声明用于比较）", () => {
    const text = [
      "// 注释",
      "",
      "export class A extends Schema {",
      "    @type(\"uint8\") public x!: number;",
      "}",
    ].join("\n");
    expect(normalizeSchemaSource(text)).toBe(
      ["export class A extends Schema {", "@type(\"uint8\") public x!: number;", "}"].join("\n"),
    );
  });
});
