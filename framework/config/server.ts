export interface ServerConfig {
  port: number;
  wsPath: string;
  corsOrigins: string[];
}

/**
 * 解析允许跨域的来源列表（以逗号分隔）。
 *
 * @param value 环境变量原始值
 * @returns 允许的 Origin 列表
 */
function parseCorsOrigins(value: string | undefined): string[] {
  const raw = value?.trim();
  if (!raw) return ["http://localhost:5173"];
  return raw
    .split(",")
    .map((v) => v.trim())
    .filter(Boolean);
}

export const serverConfig: ServerConfig = {
  port: Number(process.env.PORT ?? 3000),
  wsPath: "/ws",
  corsOrigins: parseCorsOrigins(process.env.CORS_ORIGINS),
};
