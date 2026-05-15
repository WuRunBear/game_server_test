import type { Repository } from "database/repository";

export interface PostgresOptions {
  connectionString: string;
}

/**
 * 创建 Postgres 仓储（Repository）的实现。
 *
 * 当前为最小占位实现：方法已定义但未持久化任何数据。
 *
 * @param _options Postgres 连接配置
 * @returns Repository 实例
 */
export function createPostgresRepository(_options: PostgresOptions): Repository {
  return {
    async savePlayer() {},
    async loadPlayer() {
      return null;
    },
    async saveMapInstance() {},
    async loadMapInstance() {
      return null;
    },
  };
}
