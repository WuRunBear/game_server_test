/**
 * client-schema 一致性校验（F-42 / CC-08）。
 *
 * 服务端 Colyseus schema（`framework/net/colyseus/state/*.ts`）变更时，
 * 客户端副本必须逐字段同步——schema 字段索引即线上格式，错位会让客户端
 * 解码错乱。当前维护两份产物：
 *
 * 1. TypeScript 副本 `src/network/colyseus/client-schema/schema.ts`；
 * 2. GDScript 副本 `../godot-client/generated/schema.gd`（Godot 4.7 客户端）。
 *
 * 两份都由 `@colyseus/schema` 自带的 `schema-codegen`（已在 node_modules，
 * 不新增依赖）从服务端入口 `RoomState.ts` 生成（codegen 会跟随 import 打包
 * EntityState/PlayerState），再与已提交副本按「去除注释与空行后的代码行」
 * 逐行比较：字段名/顺序/类型/装饰器任何差异都会失败。
 * 文件头/行内注释不参与比较，便于在副本里保留协议变更记录与生成命令。
 *
 * 用法：
 * - `pnpm schema:check` —— 校验 TS 与 GDScript 副本（GDScript 不存在则跳过）
 * - `pnpm schema:gen`   —— 重新生成两份副本（GDScript 仅在 `../godot-client`
 *   存在时生成）
 * - `tsx tools/schemaCheck.ts --gdscript [--out <dir>]` —— 只生成 GDScript
 *
 * 也可被测试直接 import（client-schema-consistency.test.ts /
 * schema-gdscript.test.ts / protocol-version.test.ts 复用同一实现）。
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** 仓库根（本文件位于 tools/ 下）。 */
export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** 服务端 schema 入口：codegen 从此文件跟随 import 打包全部 schema。 */
export const SERVER_SCHEMA_ENTRY = "framework/net/colyseus/state/RoomState.ts";

/** 已提交的客户端 schema 副本（相对仓库根）。 */
export const CLIENT_SCHEMA_PATH = "src/network/colyseus/client-schema/schema.ts";

/**
 * Godot 客户端目录（本仓库的兄弟目录，非 git 子树）。
 *
 * 不存在时 `schema:gen` 跳过 GDScript 生成；`schema:check` 跳过校验。
 */
export const GODOT_CLIENT_DIR = resolve(REPO_ROOT, "../godot-client");

/** GDScript schema 默认输出目录。 */
export const GODOT_SCHEMA_DIR = join(GODOT_CLIENT_DIR, "generated");

/** GDScript schema 默认文件路径。 */
export const GODOT_SCHEMA_PATH = join(GODOT_SCHEMA_DIR, "schema.gd");

/** schema-codegen 可执行入口（package.json bin，随 @colyseus/schema 安装）。 */
const SCHEMA_CODEGEN_BIN = "node_modules/@colyseus/schema/bin/schema-codegen";

/** GDScript 生成物文件名（schema-codegen `--bundle --gdscript` 的固定输出）。 */
const GDSCRIPT_SCHEMA_FILENAME = "schema.gd";

/** GDScript 生成命令（写入生成物头部，便于人工复现）。 */
export const GDSCRIPT_GEN_COMMAND =
  `node ${SCHEMA_CODEGEN_BIN} ${SERVER_SCHEMA_ENTRY} --output <dir> --gdscript --bundle`;

/**
 * 调 codegen 生成 TS 客户端 schema，返回生成的文件内容。
 *
 * @param outDir 输出目录（缺省用临时目录；调用方负责清理）
 */
export function generateClientSchema(outDir?: string): { text: string; cleanup: () => void } {
  const ownsDir = outDir === undefined;
  const target = outDir ?? mkdtempSync(join(tmpdir(), "client-schema-"));
  const cleanup = ownsDir ? () => rmSync(target, { recursive: true, force: true }) : () => {};
  try {
    execFileSync(
      process.execPath,
      [join(REPO_ROOT, SCHEMA_CODEGEN_BIN), SERVER_SCHEMA_ENTRY, "--output", target, "--ts", "--bundle"],
      { cwd: REPO_ROOT, stdio: "pipe" },
    );
  } catch (err) {
    cleanup();
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error(`schema-codegen 执行失败：${detail}`);
  }
  return { text: readFileSync(join(target, "schema.ts"), "utf8"), cleanup };
}

/** `generateGdscriptSchema` 的产物：文本 + 落盘路径（调用方按需清理）。 */
export interface GeneratedGdscriptSchema {
  /** 生成物完整文本（含生成命令注释头）。 */
  text: string;
  /** 生成物路径（`<outDir>/schema.gd`）。 */
  path: string;
  /** 仅当调用方未指定 outDir（使用临时目录）时需要清理。 */
  cleanup: () => void;
}

/**
 * 调 codegen 生成 GDScript 客户端 schema（schema 5 自带 `--gdscript`）。
 *
 * 输出文件固定为 `schema.gd`，内容头部追加生成命令注释；该注释在
 * `normalizeSchemaSource` 比较时会被忽略。
 *
 * @param outDir 输出目录（缺省用临时目录；传入目录会被创建且不自动清理）
 */
export function generateGdscriptSchema(outDir?: string): GeneratedGdscriptSchema {
  const ownsDir = outDir === undefined;
  const target = outDir ?? mkdtempSync(join(tmpdir(), "client-schema-gdscript-"));
  const cleanup = ownsDir ? () => rmSync(target, { recursive: true, force: true }) : () => {};
  const targetPath = join(target, GDSCRIPT_SCHEMA_FILENAME);
  try {
    mkdirSync(target, { recursive: true });
    execFileSync(
      process.execPath,
      [join(REPO_ROOT, SCHEMA_CODEGEN_BIN), SERVER_SCHEMA_ENTRY, "--output", target, "--gdscript", "--bundle"],
      { cwd: REPO_ROOT, stdio: "pipe" },
    );
    const raw = readFileSync(targetPath, "utf8");
    const text = `${gdscriptHeader(target)}${raw}`;
    writeFileSync(targetPath, text);
  } catch (err) {
    cleanup();
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error(`GDScript schema-codegen 执行失败：${detail}`);
  }
  return { text: readFileSync(targetPath, "utf8"), path: targetPath, cleanup };
}

/**
 * 重新生成已提交的 GDScript schema（`pnpm schema:gen` 的 Godot 半程）。
 *
 * @param outDir 输出目录（缺省 GODOT_SCHEMA_DIR）
 * @returns 生成物路径
 */
export function writeGdscriptSchema(outDir: string = GODOT_SCHEMA_DIR): string {
  const generated = generateGdscriptSchema(outDir);
  generated.cleanup();
  return generated.path;
}

/**
 * GDScript 生成物头部注释：生成命令 + 使用说明。
 *
 * 所有行以 `#` 开头，比较时被忽略；不参与 schema 结构判定。
 */
function gdscriptHeader(outDir: string): string {
  const workspaceRoot = resolve(REPO_ROOT, "..");
  const displayPath = outDir.startsWith(workspaceRoot) ? relative(REPO_ROOT, outDir) : outDir;
  return [
    "# 本文件由 @colyseus/schema 的 schema-codegen 生成，请勿手改。",
    `# 生成命令：${GDSCRIPT_GEN_COMMAND}`,
    `# 实际输出目录：${displayPath}`,
    "# 重新生成：pnpm schema:gen（或 tsx tools/schemaCheck.ts --gdscript [--out <dir>]）",
    "# 校验：pnpm schema:check（忽略注释后逐行比较）",
    "",
  ].join("\n");
}

/**
 * 归一化 schema 源码：去掉空行与整行注释、忽略行首缩进，仅保留代码行
 * （比较语义结构：字段名/顺序/类型/装饰器）。
 *
 * 同时识别 TS 的 `//` 与 GDScript 的 `#` 整行注释。
 */
export function normalizeSchemaSource(text: string): string {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("//") && !line.startsWith("#"))
    .join("\n");
}

/** 一致性校验结果：ok 为 true 时 diff 为空。 */
export interface ClientSchemaCheckResult {
  ok: boolean;
  /** 已提交副本归一化后的代码。 */
  committed: string;
  /** codegen 生成的归一化代码。 */
  generated: string;
  /** 首个差异附近的可读上下文（逐行 diff 摘要）。 */
  diff: string;
}

/** GDScript 一致性校验结果；`skipped:true` 表示 Godot 客户端不存在。 */
export interface GdscriptSchemaCheckResult {
  ok: boolean;
  /** 已提交 GDScript 副本不存在 → 跳过（不视为失败）。 */
  skipped: boolean;
  committed: string;
  generated: string;
  diff: string;
}

/**
 * 校验已提交客户端 TS 副本与服务端 schema 的 codegen 产物一致。
 *
 * @param committedPath 已提交副本路径（缺省 CLIENT_SCHEMA_PATH；测试可注入）
 */
export function checkClientSchema(committedPath: string = CLIENT_SCHEMA_PATH): ClientSchemaCheckResult {
  const { text, cleanup } = generateClientSchema();
  try {
    const committed = normalizeSchemaSource(readFileSync(resolve(REPO_ROOT, committedPath), "utf8"));
    const generated = normalizeSchemaSource(text);
    if (committed === generated) return { ok: true, committed, generated, diff: "" };
    return { ok: false, committed, generated, diff: firstDiff(committed, generated) };
  } finally {
    cleanup();
  }
}

/**
 * 校验已提交 GDScript 副本与 codegen 产物一致。
 *
 * 副本不存在时返回 `{ ok: true, skipped: true }`——仓库可能只检出服务端，
 * 不因缺少兄弟目录而失败。
 *
 * @param committedPath 已提交副本路径（缺省 GODOT_SCHEMA_PATH；测试可注入）
 */
export function checkGdscriptSchema(
  committedPath: string = GODOT_SCHEMA_PATH,
): GdscriptSchemaCheckResult {
  const target = isAbsolute(committedPath) ? committedPath : resolve(REPO_ROOT, committedPath);
  if (!existsSync(target)) {
    return { ok: true, skipped: true, committed: "", generated: "", diff: "" };
  }
  const { text, cleanup } = generateGdscriptSchema();
  try {
    const committed = normalizeSchemaSource(readFileSync(target, "utf8"));
    const generated = normalizeSchemaSource(text);
    if (committed === generated) return { ok: true, skipped: false, committed, generated, diff: "" };
    return { ok: false, skipped: false, committed, generated, diff: firstDiff(committed, generated) };
  } finally {
    cleanup();
  }
}

/**
 * 重新生成已提交的 TS 客户端副本（`pnpm schema:gen`）。
 *
 * 保留副本文件头的手写注释块（生成命令/协议变更记录），只替换 codegen
 * 实际输出的 import 与类声明部分——避免每次生成都丢掉协议变更说明。
 */
export function writeClientSchema(committedPath: string = CLIENT_SCHEMA_PATH): void {
  const target = resolve(REPO_ROOT, committedPath);
  mkdirSync(dirname(target), { recursive: true });
  const current = readFileSync(target, "utf8");
  const header = leadingCommentBlock(current);
  const { text, cleanup } = generateClientSchema();
  try {
    const importAt = text.indexOf("import ");
    const body = importAt >= 0 ? text.slice(importAt) : text;
    writeFileSync(target, header + body);
  } finally {
    cleanup();
  }
}

/** 取文件开头到首个 import 之前的注释/空行块（无注释时返回空串）。 */
function leadingCommentBlock(text: string): string {
  const lines = text.split(/\r?\n/);
  const end = lines.findIndex((line) => line.startsWith("import "));
  if (end <= 0) return "";
  const header = lines.slice(0, end).join("\n");
  return header.trim().length === 0 ? "" : `${header}\n`;
}

/** 生成逐行对比的首个差异摘要（最多展示 12 行上下文）。 */
function firstDiff(expected: string, actual: string): string {
  const expectedLines = expected.split("\n");
  const actualLines = actual.split("\n");
  const max = Math.max(expectedLines.length, actualLines.length);
  const lines: string[] = [];
  for (let i = 0; i < max && lines.length < 24; i++) {
    const e = expectedLines[i] ?? "<缺失>";
    const a = actualLines[i] ?? "<缺失>";
    if (e !== a) {
      lines.push(`第 ${i + 1} 行（已提交 / 生成物）:`);
      lines.push(`  - ${e}`);
      lines.push(`  + ${a}`);
    }
  }
  return lines.join("\n");
}

/** 解析 CLI `--out <dir>`（相对路径按当前工作目录解析）。 */
function parseOutDir(): string | undefined {
  const index = process.argv.indexOf("--out");
  if (index < 0) return undefined;
  const value = process.argv[index + 1];
  if (!value) {
    console.error("--out 需要一个目录参数");
    process.exit(2);
  }
  return isAbsolute(value) ? value : resolve(process.cwd(), value);
}

/** CLI 入口：`--write` 重新生成；`--gdscript` 只生成 GDScript；否则双份校验。 */
function main(): void {
  const outDir = parseOutDir();

  if (process.argv.includes("--gdscript")) {
    const path = writeGdscriptSchema(outDir ?? GODOT_SCHEMA_DIR);
    console.log(`GDScript schema 已生成：${path}`);
    return;
  }

  if (process.argv.includes("--write")) {
    writeClientSchema();
    console.log(`client-schema 已生成：${CLIENT_SCHEMA_PATH}（文件头注释保留）`);
    if (existsSync(GODOT_CLIENT_DIR)) {
      const path = writeGdscriptSchema(outDir ?? GODOT_SCHEMA_DIR);
      console.log(`GDScript schema 已生成：${path}`);
    } else {
      console.log(`未发现 Godot 客户端目录（${GODOT_CLIENT_DIR}），跳过 GDScript 生成`);
    }
    return;
  }

  let failed = false;

  const tsResult = checkClientSchema();
  if (tsResult.ok) {
    console.log("client-schema 一致：与服务端 schema 的 codegen 产物逐字段一致");
  } else {
    failed = true;
    console.error("client-schema 不一致：请运行 `pnpm schema:gen` 重新生成并同步协议变更记录");
    console.error(tsResult.diff);
  }

  const gdResult = checkGdscriptSchema(
    outDir === undefined ? GODOT_SCHEMA_PATH : join(outDir, GDSCRIPT_SCHEMA_FILENAME),
  );
  if (gdResult.skipped) {
    console.log("GDScript schema 校验跳过：未找到 ../godot-client/generated/schema.gd");
  } else if (gdResult.ok) {
    console.log("GDScript schema 一致：与 schema-codegen 产物逐字段一致");
  } else {
    failed = true;
    console.error("GDScript schema 不一致：请运行 `pnpm schema:gen` 重新生成");
    console.error(gdResult.diff);
  }

  if (failed) process.exitCode = 1;
}

// 仅在直接执行时跑 CLI（被测试 import 时不触发）
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
