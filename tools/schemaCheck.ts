/**
 * client-schema 一致性校验（F-42）。
 *
 * 服务端 Colyseus schema（`framework/net/colyseus/state/*.ts`）变更时，
 * 客户端副本 `src/network/colyseus/client-schema/schema.ts` 必须逐字段同步——
 * schema 字段索引即线上格式，错位会让客户端解码错乱。
 *
 * 本工具用 `@colyseus/schema` 自带的 `schema-codegen`（已在 node_modules，
 * 不新增依赖）对服务端入口 `RoomState.ts` 生成 TS 客户端副本（codegen 会
 * 跟随 import 打包 EntityState/PlayerState），再与已提交副本按「去除注释与
 * 空行后的代码行」逐行比较：字段名/顺序/类型/装饰器任何差异都会失败。
 * 文件头/行内注释不参与比较，便于在副本里保留协议变更记录。
 *
 * 用法：
 * - `pnpm schema:check` —— 校验已提交副本与生成物一致（CI/本地）
 * - `pnpm schema:gen`   —— 重新生成副本（保留文件头的生成命令与协议变更记录）
 *
 * 也可被测试直接 import（client-schema-consistency.test.ts 复用同一实现）。
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** 仓库根（本文件位于 tools/ 下）。 */
export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** 服务端 schema 入口：codegen 从此文件跟随 import 打包全部 schema。 */
export const SERVER_SCHEMA_ENTRY = "framework/net/colyseus/state/RoomState.ts";

/** 已提交的客户端 schema 副本（相对仓库根）。 */
export const CLIENT_SCHEMA_PATH = "src/network/colyseus/client-schema/schema.ts";

/** schema-codegen 可执行入口（package.json bin，随 @colyseus/schema 安装）。 */
const SCHEMA_CODEGEN_BIN = "node_modules/@colyseus/schema/bin/schema-codegen";

/**
 * 调 codegen 生成客户端 schema，返回生成的文件内容。
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

/**
 * 归一化 schema 源码：去掉空行与整行注释、忽略行首缩进，仅保留代码行
 * （比较语义结构：字段名/顺序/类型/装饰器）。
 */
export function normalizeSchemaSource(text: string): string {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("//"))
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

/**
 * 校验已提交客户端副本与服务端 schema 的 codegen 产物一致。
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
 * 重新生成已提交的客户端副本（`pnpm schema:gen`）。
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

/** CLI 入口：--write 重新生成；否则校验并在不一致时打印 diff（非零退出）。 */
function main(): void {
  if (process.argv.includes("--write")) {
    writeClientSchema();
    console.log(`client-schema 已生成：${CLIENT_SCHEMA_PATH}（文件头注释保留）`);
    return;
  }
  const result = checkClientSchema();
  if (result.ok) {
    console.log("client-schema 一致：与服务端 schema 的 codegen 产物逐字段一致");
    return;
  }
  console.error("client-schema 不一致：请运行 `pnpm schema:gen` 重新生成并同步协议变更记录");
  console.error(result.diff);
  process.exitCode = 1;
}

// 仅在直接执行时跑 CLI（被测试 import 时不触发）
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
