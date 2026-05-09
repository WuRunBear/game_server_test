export interface ServerConfig {
  port: number;
  wsPath: string;
}

export const serverConfig: ServerConfig = {
  port: Number(process.env.PORT ?? 3000),
  wsPath: "/ws",
};
