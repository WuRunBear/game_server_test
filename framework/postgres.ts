import type { Repository } from "database/repository";

export interface PostgresOptions {
  connectionString: string;
}

/**
 * 创建 Postgres 仓储（Repository）的实现。
 *
 * 当前为最小占位实现：方法已定义但未持久化任何数据。
 * 接口已对齐世界快照（WorldRecord）；真实现（pg 驱动 + SQL 存取）等待真实部署需求。
 *
 * @param _options Postgres 连接配置
 * @returns Repository 实例
 */
export function createPostgresRepository(_options: PostgresOptions): Repository {
  return {
    async saveWorld() {},
    async loadWorld() {
      return null;
    },
  };
}
