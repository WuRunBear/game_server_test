import type { Repository } from "database/repository";

export interface RedisOptions {
  url: string;
}

export function createRedisRepository(_options: RedisOptions): Repository {
  return {
    async savePlayer() {},
    async loadPlayer() {
      return null;
    },
  };
}
