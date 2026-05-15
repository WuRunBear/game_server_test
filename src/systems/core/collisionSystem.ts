import type { GameWorld } from "src/world";

/**
 * 碰撞系统（占位）：用于后续在移动/物理之后处理碰撞与阻挡。
 *
 * @param world ECS World
 * @returns 处理后的 World
 */
export function collisionSystem(world: GameWorld): GameWorld {
  return world;
}
