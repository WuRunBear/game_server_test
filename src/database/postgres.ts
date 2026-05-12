import type { Repository } from "database/repository";

export interface PostgresOptions {
  connectionString: string;
}

export function createPostgresRepository(_options: PostgresOptions): Repository {
  return {
    async savePlayer() {},
    async loadPlayer() {
      return null;
    },
  };
}
