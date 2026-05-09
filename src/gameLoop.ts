import { recordTick } from "./metrics";
import type { GameWorld, System } from "./world";

/**
 * 游戏循环的最小接口：启动/停止。
 */
export interface GameLoop {
  start(): void;
  stop(): void;
}

export interface GameLoopOptions {
  tickRate: number;
}

/**
 * 创建固定帧率的服务器主循环。
 *
 * @param world ECS World
 * @param systems 系统列表（按顺序执行）
 * @param options tickRate：每秒 tick 次数
 * @returns 可控制的循环对象
 */
export function createGameLoop(
  world: GameWorld,
  systems: readonly System[],
  options: GameLoopOptions,
): GameLoop {
  const fixedDtMs = Math.max(1, Math.floor(1000 / options.tickRate));
  world.time.fixedDtMs = fixedDtMs;
  world.time.dtMs = fixedDtMs;

  let timer: NodeJS.Timeout | undefined;

  const step = () => {
    const start = performance.now();

    world.time.tick += 1;
    world.time.dtMs = fixedDtMs;

    for (const system of systems) system(world);

    recordTick(world.metrics, performance.now() - start);
  };

  return {
    start() {
      if (timer) return;
      timer = setInterval(step, fixedDtMs);
    },
    stop() {
      if (!timer) return;
      clearInterval(timer);
      timer = undefined;
    },
  };
}
