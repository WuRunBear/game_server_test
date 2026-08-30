/**
 * 内建原型注册——框架自带的兜底原型集合（玩家/演示 NPC/掉落物）。
 *
 * 仅在 game/ 配置缺失时兜底（如 createDefaultGameDefinition 的默认世界）；
 * 真实项目由 game/entities/*.json 加载后，经 archetypeRegistry.override
 * 覆盖同名原型，因此这里保持极简、不含游戏专属语义。
 */
import type { ArchetypeRegistry } from "framework/entities/archetypeRegistry";

/**
 * 注册内建原型。组件配置值为初始 SoA 字段（spawn 时写入对应组件）。
 * @param registry 原型注册表（bootstrapFramework 创建的单例）
 */
export function registerBuiltinArchetypes(registry: ArchetypeRegistry): void {
  // 玩家原型：可移动/带碰撞与血量，阵营 1
  registry.register({
    kind: "player",
    tags: ["Player"],
    components: {
      Size: { w: 16, h: 16 },
      Velocity: {},
      Acceleration: {},
      Collider: { shape: 1, halfW: 8, halfH: 8 },
      Health: { current: 100, max: 100 },
    },
    team: 1,
  });

  // 演示 NPC 原型：无加速度、血量较少，挂默认游荡行为树，阵营 0
  registry.register({
    kind: "npc",
    tags: ["NPC"],
    components: {
      Size: { w: 16, h: 16 },
      Velocity: {},
      Collider: { shape: 1, halfW: 8, halfH: 8 },
      Health: { current: 50, max: 50 },
    },
    behavior: "wander-default",
    team: 0,
  });

  // 掉落物原型：仅尺寸（可被拾取进背包），无 AI 无阵营
  registry.register({
    kind: "item",
    tags: ["Item"],
    components: {
      Size: { w: 12, h: 12 },
    },
  });
}
