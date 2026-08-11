/**
 * 游戏实例——单个世界（ECS）的持有者与推进器。
 *
 * 职责：
 * - **组装**：创建 GameWorld，把各注册表（组件/系统/原型/动作/生成器）挂到 world，
 *   建立 gameDef 的运行时索引（itemsByKind / dialoguesByKind / questsByKind），
 *   并用 game 配置覆盖内建原型
 * - **初始化**：构建地图运行时 + 生成初始实体（spawnInitialEntities）
 * - **推进**：step(dtMs) 自增 tick、写入本帧 dtMs（限幅）、清空事件队列、按序执行全部系统
 *
 * 上游是 GameSimulation（调用 step 并读取 world 派生快照）；本文件不涉及网络/传输概念。
 */
import type { GameWorld, System } from "framework/world";
import { createGameWorld } from "framework/world";
import { buildSystems } from "framework/systems/systemRegistry";
import { buildMapRuntime } from "framework/map/buildRuntime";
import { spawnInitialNpcs } from "framework/map/switchMap";
import { getRegistries } from "framework/bootstrap";
import type { LoadedGameDefinition } from "framework/config/schema/GameDefinitionSchema";

/** dtMs 上限倍率：单帧步长最多为固定步长的 N 倍，防止负载尖峰导致物理穿透 */
const MAX_DT_MULTIPLIER = 4;

export interface GameInstance {
  /** ECS 世界（含时间、地图、各注册表引用与 gameDef）。 */
  world: GameWorld;
  /** 按拓扑序排列的系统列表（step 时依次执行）。 */
  systems: System[];
  /** 推进一个逻辑帧：tick+1 → 设 dtMs（限幅）→ 清空事件队列 → 跑全部系统。 */
  step(dtMs: number): void;
  /** 生成地图初始实体（如初始 NPC/资源点）。 */
  spawnInitialEntities(): void;
}

/**
 * 创建游戏实例（一条完整的世界初始化管线）。
 * @param gameDef 已加载并校验的游戏配置（loadGameDefinition 的输出）
 */
export function createGameInstance(gameDef: LoadedGameDefinition): GameInstance {
  const { componentRegistry, systemRegistry, archetypeRegistry, actionRegistry, generatorRegistry } = getRegistries();

  // 固定步长（毫秒）：由 tickRate 换算；负载尖峰时 dtMs 被 clamp 到其 4 倍以内
  const fixedDtMs = Math.max(1, Math.floor(1000 / gameDef.tickRate));
  const world = createGameWorld(fixedDtMs);

  // 把各注册表引用挂到 world——系统运行时统一经 world 访问（Registry 模式）
  world.gameDef = gameDef;
  world.components_registry = componentRegistry;
  world.systems_registry = systemRegistry;
  world.archetypes = archetypeRegistry;
  world.actions = actionRegistry;
  world.generators = generatorRegistry;

  // 构建 item kind 索引，供采集/消耗等系统按 kind 字符串查表
  gameDef.itemsByKind = new Map(gameDef.resolvedItems.map((i) => [i.kind, i]));
  // 对话树/任务定义索引（dialogueSystem/questSystem 按 id 查表）
  gameDef.dialoguesByKind = new Map(gameDef.resolvedDialogues.map((t) => [t.id, t]));
  gameDef.questsByKind = new Map(gameDef.resolvedQuests.map((q) => [q.id, q]));

  // game 配置实体优先于框架内建原型（player/villager 等）——
  // 内建仅作 createDefaultGameDefinition 的兜底，真实 game/*.json 应能完全定义游戏内容
  for (const entity of gameDef.resolvedEntities) {
    archetypeRegistry.override(entity);
  }

  const systems = buildSystems(world, gameDef.systems ?? [], systemRegistry);

  // 构建地图运行时（碰撞体/生成点等）；无地图配置则 world.map 为 undefined
  const mapBuilt = gameDef.resolvedMapSource
    ? buildMapRuntime(gameDef.resolvedMapSource)
    : undefined;
  world.map = mapBuilt;

  const instance: GameInstance = {
    world,
    systems,

    step(dtMs) {
      world.time.tick += 1;

      // dtMs 兜底：非法值回退固定步长；过大值限幅（防物理穿透）
      const raw = Number.isFinite(dtMs) && dtMs > 0 ? dtMs : fixedDtMs;
      world.time.dtMs = Math.min(raw, fixedDtMs * MAX_DT_MULTIPLIER);

      // 帧首清空事件队列：事件只在产生它的那一帧有效（未消费不跨帧堆积）
      world.runtimeEvents = [];

      for (const system of systems) {
        system(world);
      }
    },

    spawnInitialEntities() {
      spawnInitialNpcs(world);
    },
  };

  instance.spawnInitialEntities();

  return instance;
}
