// 先执行游戏自定义扩展注册（src/register.ts 内自调 bootstrapFramework），
// 确保任何 register* 调用都发生在 createGameInstance 之前；bootstrapFramework 幂等。
import "src/register";
import { bootstrapFramework } from "framework/bootstrap";
import { startColyseusServer } from "network/colyseus/server";
import { createLogger } from "utils/logger";

export function main(): void {
  bootstrapFramework();
  startColyseusServer({
    logger: createLogger("net"),
    gameJsonPath: process.env.GAME_CONFIG_PATH,
  });
}
