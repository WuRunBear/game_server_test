/**
 * GDScript schema codegen 测试（CC-08）。
 *
 * 用临时目录跑 `generateGdscriptSchema`，断言 GDScript 产物存在且包含
 * Godot addon 可识别的 schema 定义；同时验证已提交副本（若存在）与
 * codegen 产物一致——与 `pnpm schema:check` 同一实现。
 */
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  checkGdscriptSchema,
  generateGdscriptSchema,
  normalizeSchemaSource,
} from "../../tools/schemaCheck";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("GDScript schema codegen", () => {
  it("生成 schema.gd，包含 RoomState/PlayerState/EntityState 定义", () => {
    const dir = mkdtempSync(join(tmpdir(), "schema-gdscript-"));
    tempDirs.push(dir);

    const generated = generateGdscriptSchema(dir);

    expect(generated.path).toBe(join(dir, "schema.gd"));
    expect(existsSync(generated.path)).toBe(true);
    expect(generated.text).toContain("class EntityState extends Colyseus.Schema:");
    expect(generated.text).toContain("class PlayerState extends Colyseus.Schema:");
    expect(generated.text).toContain("class RoomState extends Colyseus.Schema:");
    expect(generated.text).toContain('Colyseus.Schema.Field.new("tick", Colyseus.Schema.UINT32)');
    expect(generated.text).toContain('Colyseus.Schema.Field.new("players", Colyseus.Schema.MAP, PlayerState)');
    // 生成命令注释头（比较时忽略，但文件里应可见）
    expect(generated.text).toContain("schema-codegen");
    expect(generated.text).toContain("--gdscript");
  });

  it("归一化忽略 # 注释与空行，保留字段声明", () => {
    const text = [
      "# 生成命令：schema-codegen ... --gdscript",
      "",
      "class A extends Colyseus.Schema:",
      '\t\t\tColyseus.Schema.Field.new("x", Colyseus.Schema.NUMBER),',
      "",
    ].join("\n");
    expect(normalizeSchemaSource(text)).toBe(
      [
        "class A extends Colyseus.Schema:",
        'Colyseus.Schema.Field.new("x", Colyseus.Schema.NUMBER),',
      ].join("\n"),
    );
  });

  it("已提交的 ../godot-client/generated/schema.gd 与 codegen 一致（不存在则跳过）", () => {
    const result = checkGdscriptSchema();
    if (result.skipped) {
      expect(result.ok).toBe(true);
      return;
    }
    expect(result.ok, `GDScript schema 不一致，运行 \`pnpm schema:gen\`：\n${result.diff}`).toBe(true);
  });

  it("副本不存在时跳过（ok:true, skipped:true），不视为失败", () => {
    const missing = join(tmpdir(), `schema-gdscript-missing-${process.pid}.gd`);
    const result = checkGdscriptSchema(missing);
    expect(result).toEqual({ ok: true, skipped: true, committed: "", generated: "", diff: "" });
  });
});
