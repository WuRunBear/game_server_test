/**
 * Redis 持久化后端（游戏无关）。
 *
 * 注意：当前为占位实现（stub）——未接入真实 Redis 驱动，方法体为空，
 * saveWorld 不写入、loadWorld 恒返回 null，**不要假设可用**。
 * 默认可用后端是 createFileRepository（JSON 文件）。待有真实部署需求时，
 * 用 ioredis 按本接口（Repository + WorldRecord 世界快照）实现键值存取。
 */
import type { Repository } from "database/repository";

/** Redis 连接配置（stub 阶段仅声明结构，暂未使用）。 */
export interface RedisOptions {
  /** Redis 连接地址（如 redis://localhost:6379）。 */
  url: string;
}

/**
 * 创建 Redis 仓储（Repository）的实现。
 *
 * 当前为最小占位实现：方法已定义但未持久化任何数据。
 * 接口已对齐世界快照（WorldRecord）；真实现（ioredis + JSON 键值）等待真实部署需求。
 *
 * @param _options Redis 连接配置
 * @returns Repository 实例
 */
export function createRedisRepository(_options: RedisOptions): Repository {
  return {
    async saveWorld() {},
    async loadWorld() {
      return null;
    },
  };
}
