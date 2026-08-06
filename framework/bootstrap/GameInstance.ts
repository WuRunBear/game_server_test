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
  world: GameWorld;
  systems: System[];
  step(dtMs: number): void;
  spawnInitialEntities(): void;
}

export function createGameInstance(gameDef: LoadedGameDefinition): GameInstance {
  const { componentRegistry, systemRegistry, archetypeRegistry, actionRegistry, generatorRegistry } = getRegistries();

  const fixedDtMs = Math.max(1, Math.floor(1000 / gameDef.tickRate));
  const world = createGameWorld(fixedDtMs);

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

  const mapBuilt = gameDef.resolvedMapSource
    ? buildMapRuntime(gameDef.resolvedMapSource)
    : undefined;
  world.map = mapBuilt;

  const instance: GameInstance = {
    world,
    systems,

    step(dtMs) {
      world.time.tick += 1;

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
