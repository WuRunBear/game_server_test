/**
 * 实体生成——按原型（ArchetypeSpec）在 ECS world 中创建实体。
 *
 * 关键机制：**AoS 组件初始化钩子**。组件注册表里的组件分两类，spawn 时走不同路径：
 * - SoA 组件（bitecs 数值数组）：addComponent 挂载 + 按字段名写入初始值
 * - AoS 组件（普通 JS 数组，如 Inventory/Needs/ItemMeta 等）：不能走
 *   addComponent/按字段赋值，改由组件注册表的 AoS 初始化钩子
 *   （registerAosInitializer）按原型配置整体写入 `CompAos[eid]`；
 *   未注册钩子的 AoS 组件直接跳过（与历史 SoA-only 行为一致）。
 *
 * 流程：分配 eid → 挂 Transform/NetworkId → 逐组件写入（SoA/AoS 分流）
 * → 挂标签/阵营 → 分配 NetworkId（nextNetworkId 自增）→ 写 Kind。
 */
import { addComponent, addEntity } from "bitecs";
import type { EntityId, GameWorld } from "framework/world";
import type { ArchetypeSpec } from "framework/entities/archetypeRegistry";
import type { ComponentRegistry } from "framework/components/componentRegistry";

import { Transform } from "framework/components/transform";
import { NetworkId } from "framework/components/network";
import { Player, NPC, Enemy, Item, Resource } from "framework/components/tags";
import { Team } from "framework/components/combat";
import { setEntityKind } from "framework/systems/gameplay/aiSystem";

/** 标签名 → bitecs 组件对象（原型 tags 挂载时按名查表，未知名忽略）。 */
const TAG_MAP: Record<string, unknown> = { Player, NPC, Enemy, Item, Resource };

export interface SpawnOverrides {
  /** 生成坐标 x（缺省 0）。 */
  x?: number;
  /** 生成坐标 y（缺省 0）。 */
  y?: number;
  /** 预留：未来可覆盖原型组件初始值（key = 组件字段名）。 */
  [key: string]: unknown;
}

/**
 * 生成实体。
 * @param world ECS world
 * @param archetype 原型规格（组件初始值/标签/阵营/kind）
 * @param componentRegistry 组件注册表（按名取组件对象与 AoS 初始化钩子）
 * @param overrides 生成覆盖项（当前仅坐标）
 * @returns 新实体的 eid
 */
export function spawnEntity(
  world: GameWorld,
  archetype: ArchetypeSpec,
  componentRegistry: ComponentRegistry,
  overrides?: SpawnOverrides,
): EntityId {
  const eid = addEntity(world);

  addComponent(world, eid, Transform);
  addComponent(world, eid, NetworkId);

  for (const [compName, compConfig] of Object.entries(archetype.components)) {
    const comp = componentRegistry.get(compName);

    // AoS 组件（普通 JS 数组）不走 bitecs 的 addComponent/按字段赋值路径，
    // 改由注册的初始化钩子按 archetype 配置写入 ComponentAoS[eid]。
    // 若未注册钩子则跳过（与历史 SoA-only 行为一致，避免误把数组当 SoA 写）。
    if (Array.isArray(comp)) {
      const initializer = componentRegistry.getAosInitializer(compName);
      if (initializer) {
        initializer(world, eid, compConfig);
      }
      continue;
    }

    addComponent(world, eid, comp);
    const compObj = comp as Record<string, Record<number, unknown>>;
    if (compConfig && typeof compConfig === "object") {
      // SoA 路径：逐字段写入初始值（字段不存在于组件对象则跳过，容忍配置多写）
      for (const [field, value] of Object.entries(compConfig as Record<string, unknown>)) {
        if (compObj[field] !== undefined) {
          compObj[field][eid] = value;
        }
      }
    }
  }

  Transform.x[eid] = overrides?.x ?? 0;
  Transform.y[eid] = overrides?.y ?? 0;

  // 挂标签组件（如 Player/Item），供 query 与同步适配器按标签筛选
  if (archetype.tags) {
    for (const tag of archetype.tags) {
      const tagComp = TAG_MAP[tag];
      if (tagComp) {
        addComponent(world, eid, tagComp);
      }
    }
  }

  // 有阵营定义才挂 Team 组件并写入阵营 id
  if (archetype.team !== undefined) {
    addComponent(world, eid, Team);
    Team.id[eid] = archetype.team;
  }

  // 分配稳定网络标识（world.nextNetworkId 自增；读档恢复时由存档值覆写）
  NetworkId.value[eid] = world.nextNetworkId++;

  // 写 Kind 组件：AI/行为系统按 kind 路由实体（kind 即原型名）
  setEntityKind(world, eid, archetype.kind);

  return eid;
}
