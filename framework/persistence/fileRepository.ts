/**
 * 文件仓储——Repository 的真实现：按 id 存取 JSON 存档文件。
 *
 * 每个存档 id 对应 `<dir>/<id>.json`。写入采用「临时文件 + rename」原子替换，
 * 避免崩溃时留下半写文件；目录不存在时自动创建。
 *
 * 写盘**串行化**：并发的 saveWorld 通过内部 Promise 队列排队执行——
 * 若两个存档同时写同一 id 的 tmp 文件再各自 rename，慢写者会覆盖快写者
 * （旧档覆盖新档）；排队后写入顺序即调用顺序，最终文件为最后一次调用的内容。
 *
 * 这是默认持久化后端（无外部依赖，可单机验收）；Postgres/Redis 实现见
 * postgres.ts / redis.ts（接口已对齐，当前为占位，等待真实部署需求）。
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

/**
 * 创建文件仓储——返回 Repository 实现（saveWorld / loadWorld）。
 * @param dir 存档目录（不存在时自动创建，可被 SAVE_DIR 环境变量覆盖）
 */
export function createFileRepository(dir: string): Repository {
  // 写盘串行队列：链式 then 保证并发 saveWorld 按调用顺序落盘（见文件头注释）
  let writeQueue: Promise<void> = Promise.resolve();

  return {
    async saveWorld(record: WorldRecord) {
      await mkdir(dir, { recursive: true });
      const target = join(dir, `${safeId(record.id)}.json`);
      const tmp = `${target}.tmp`;
      const payload = JSON.stringify(record);

      // 入队串行写盘（队列失败不断链，错误由本次 await 抛出）
      const task = writeQueue.then(async () => {
        await writeFile(tmp, payload, "utf8");
        await rename(tmp, target);
      });
      writeQueue = task.catch(() => {});
      await task;
    },

    async loadWorld(id: string) {
      try {
        const raw = await readFile(join(dir, `${safeId(id)}.json`), "utf8");
        return JSON.parse(raw) as WorldRecord;
      } catch {
        // 文件不存在/解析失败均视为无存档
        return null;
      }
    },
  };
}
