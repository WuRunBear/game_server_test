import type { Repository } from "database/repository";

export interface RedisOptions {
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
