/**
 * 服务端网络配置（framework/config/server.ts）。
 *
 * 从环境变量读取 Colyseus 服务的监听参数（配置驱动、无硬编码）：
 * - PORT：监听端口（默认 3000）
 * - CORS_ORIGINS：跨域白名单（逗号分隔；缺省放行本机 Vite 开发端口 5173）
 *
 * 客户端按 serverConfig 连接服务，wsPath 为 WebSocket 挂载路径。
 */

/**
 * 服务端网络配置项。
 */
export interface ServerConfig {
  /** 服务监听端口。 */
  port: number;
  /** WebSocket 挂载路径（Colyseus 握手端点）。 */
  wsPath: string;
  /** 允许跨域访问的 Origin 列表（CORS 白名单）。 */
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

/** 当前生效的服务端网络配置（进程启动时由环境变量解析一次）。 */
export const serverConfig: ServerConfig = {
  port: Number(process.env.PORT ?? 3000),
  wsPath: "/ws",
  corsOrigins: parseCorsOrigins(process.env.CORS_ORIGINS),
};
