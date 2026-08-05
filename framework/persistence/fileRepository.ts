/**
 * 文件仓储——Repository 的真实现：按 id 存取 JSON 存档文件。
 *
 * 每个存档 id 对应 `<dir>/<id>.json`。写入采用「临时文件 + rename」原子替换，
 * 避免崩溃时留下半写文件；目录不存在时自动创建。
 *
 * 这是默认持久化后端（无外部依赖，可单机验收）；Postgres/Redis 实现见
 * postgres.ts / redis.ts（接口已对齐，当前为占位，等待真实部署需求）。
 */
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { Repository, WorldRecord } from "framework/repository";

function safeId(id: string): string {
  const sanitized = id.replace(/[^a-zA-Z0-9._-]/g, "_");
  if (!sanitized) return "world";
  return sanitized;
}

export function createFileRepository(dir: string): Repository {
  return {
    async saveWorld(record: WorldRecord) {
      await mkdir(dir, { recursive: true });
      const target = join(dir, `${safeId(record.id)}.json`);
      const tmp = `${target}.tmp`;
      await writeFile(tmp, JSON.stringify(record), "utf8");
      await rename(tmp, target);
    },

    async loadWorld(id: string) {
      try {
        const raw = await readFile(join(dir, `${safeId(id)}.json`), "utf8");
        return JSON.parse(raw) as WorldRecord;
      } catch {
        return null;
      }
    },
  };
}
