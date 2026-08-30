/**
 * 测试夹具：内存仓储替身（读档通道唯一化的测试注入）。
 *
 * loadWorld 恒返回预置快照；saveWorld 覆写内存副本（不落盘）——
 * 供需要「已有存档」场景的用例注入，无需临时目录与文件 I/O。
 */
import type { Repository, WorldRecord } from "framework/repository";

export function memoryRepository(record: WorldRecord | null): Repository {
  let stored = record;
  return {
    saveWorld: async (next) => {
      stored = next;
    },
    loadWorld: async () => stored,
  };
}
