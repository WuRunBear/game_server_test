/**
 * 文件仓储——Repository 的真实现：按 id 存取 JSON 存档文件。
 *
 * 每个存档 id 对应 `<dir>/<id>.json`。写入采用「临时文件 + rename」原子替换，
 * 避免崩溃时留下半写文件；目录不存在时自动创建。
 *
 * 读取区分「无档」与「坏档」：只有 ENOENT 返回 null（合法首次开机）；读取/
 * 解析失败一律抛出带路径与原始原因的明确错误——进程 fail-fast，绝不把损坏
 * 存档当成无档而用新世界覆盖它。
 *
 * 写盘**串行化**：并发的 saveWorld 通过内部 Promise 队列排队执行——
 * 若两个存档同时写同一 id 的 tmp 文件再各自 rename，慢写者会覆盖快写者
 * （旧档覆盖新档）；排队后写入顺序即调用顺序，最终文件为最后一次调用的内容。
 *
 * JSON 编码（`JSON.stringify`）在队列任务内执行（F-30）：调用方在 tick 内
 * 只需同步产出纯数据快照（serializeWorld），编码/写盘在 tick 返回后的异步段
 * 完成，降低大世界自动存档的当帧阻塞。record 视为不可变快照——入队后调用方
 * 不得再修改它（内部唯一调用方 serializeWorld 每帧新建对象，满足该契约）。
 *
 * 这是当前唯一的持久化后端（无外部依赖，可单机验收）；仓库不提供
 * Postgres/Redis 实现（F-37 删除了不可用的占位桩，等真实部署需求再按
 * Repository 接口实现）。
 */
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { Repository, WorldRecord } from "framework/repository";

/**
 * 把存档 id 清洗为安全文件名：非法字符替换为下划线，空结果兜底 "world"。
 * 防止外部传入的 id 含路径分隔符造成目录穿越/非法文件名。
 */
function safeId(id: string): string {
  const sanitized = id.replace(/[^a-zA-Z0-9._-]/g, "_");
  if (!sanitized) return "world";
  return sanitized;
}

/** 判断 Node 文件系统错误是否为指定 errno（ENOENT 等）。 */
function isErrno(err: unknown, code: string): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    (err as NodeJS.ErrnoException).code === code
  );
}

/** 错误消息提取（保留原始 message 供排障，避免只给出 "Error"）。 */
function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * 创建文件仓储——返回 Repository 实现（saveWorld / loadWorld）。
 * @param dir 存档目录（不存在时自动创建，可被 SAVE_DIR 环境变量覆盖）
 */
export function createFileRepository(dir: string): Repository {
  // 写盘串行队列：链式 then 保证并发 saveWorld 按调用顺序落盘（见文件头注释）
  let writeQueue: Promise<void> = Promise.resolve();

  return {
    async saveWorld(record: WorldRecord) {
      const target = join(dir, `${safeId(record.id)}.json`);
      const tmp = `${target}.tmp`;

      // 同步入队（在任何 await 之前）：保证入队顺序==调用顺序，旧档不覆盖新档。
      // JSON.stringify 放在队列任务内（F-30）：调用方（自动存档在 tick 内触发）
      // 只同步产出纯数据快照（serializeWorld），编码与写盘在 tick 返回后的
      // 微任务/异步段执行，避免大世界 JSON 编码阻塞当帧 tick。
      const task = writeQueue.then(async () => {
        const payload = JSON.stringify(record);
        await mkdir(dir, { recursive: true });
        await writeFile(tmp, payload, "utf8");
        await rename(tmp, target);
      });
      writeQueue = task.catch(() => {});
      await task;
    },

    async loadWorld(id: string) {
      const target = join(dir, `${safeId(id)}.json`);
      let raw: string;
      try {
        raw = await readFile(target, "utf8");
      } catch (err) {
        // ENOENT = 合法无档（首次开机）；其余读取错误（权限/IO）必须 fail-fast，
        // 否则会被误判为"无档"并以新世界覆盖掉可能完好的旧档。
        if (isErrno(err, "ENOENT")) return null;
        throw new Error(
          `loadWorld("${id}") failed to read save "${target}": ${describeError(err)}`,
          { cause: err },
        );
      }

      try {
        return JSON.parse(raw) as WorldRecord;
      } catch (err) {
        // 解析失败 = 存档损坏：明确报错并保留原文件（绝不覆盖、绝不静默新建世界）。
        throw new Error(
          `loadWorld("${id}") found a corrupt save at "${target}" (${describeError(err)}); the file was left untouched`,
          { cause: err },
        );
      }
    },
  };
}
