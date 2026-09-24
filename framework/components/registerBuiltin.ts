/**
 * 内置组件注册表装配。
 *
 * 把 framework 内置的 SoA/Tag 组件与 AoS 初始化钩子统一注册进组件注册表，
 * 由 bootstrapFramework 调用；组件名即 game/ 配置 entities/*.json 中
 * components 块的键。游戏无关——这里只注册通用组件，不含任何游戏语义。
 *
 * 各组件随 `register` 第 3 参携带编辑器元数据：
 * - description：组件机制的一句话介绍（编辑器「组件」面板展示）。
 * - configSchema：`entities/*.json` 中该组件键对应值对象的形态（字段介绍用
 *   前导 JSDoc，数值约束走 zod 链）。描述的是**归一化后**的组件字段——加载期
 *   `*Tiles` 后缀量纲键（如 `wTiles`）由 tileUnits 统一换算为 px 裸键后才进入
 *   初始化器，故此处只列裸键、不逐组件重复枚举 Tiles 别名。
 *
 * 无 archetype 可配置形态的组件（纯运行时状态/标签）省略 configSchema，只补
 * description；AoS 组件仅在其注册了 archetype 初始化钩子时才可配置。
 */
import { z } from "zod";
import type { ComponentRegistry } from "framework/components/componentRegistry";
import { Transform } from "framework/components/transform";
import { Size } from "framework/components/size";
import { Velocity, Acceleration, Collider, ColliderShape } from "framework/components/physics";
import { Health, Attack, Defense, Team } from "framework/components/combat";
import { AIState, Target, BlackboardRef } from "framework/components/ai";
import { Inventory, initInventory } from "framework/components/inventory";
import { ItemMeta } from "framework/components/itemMeta";
import { EntityMap } from "framework/components/entityMap";
import { SpawnPoint } from "framework/components/spawnPoint";
import { Needs, initNeeds } from "framework/components/needs";
import { ResourceNode, initResourceNode } from "framework/components/resourceNode";
import { Nest, initNest } from "framework/components/nest";
import { LootTable, initLootTable } from "framework/components/loot";
import { Perception } from "framework/components/perception";
import { Equipment } from "framework/components/equipment";
import { CraftingStation } from "framework/components/craftingStation";
import { LightSource } from "framework/components/lightSource";
import { Placeable } from "framework/components/placeable";
import { GridOccupancy } from "framework/components/gridOccupancy";
import { Portal, initPortal } from "framework/components/portal";
import { Dialogue } from "framework/components/dialogue";
import { DialogueSource, initDialogueSource } from "framework/components/dialogueSource";
import { Quest } from "framework/components/quest";
import { Relation } from "framework/components/relation";
import { Intent } from "framework/components/intent";
import { NetworkId, LastSynced } from "framework/components/network";
import { Cooldown, Duration } from "framework/components/timer";
import { Ledger, initLedger } from "framework/components/ledger";
import { Projectile } from "framework/components/projectile";
import { Modifiers } from "framework/simulation/modifiers/modifiers";
import { Triggers } from "framework/simulation/triggers/triggers";
import { ExpiresAt, Interval } from "framework/simulation/timer/timer";
import { Player, Enemy, NPC, Item, Resource } from "framework/components/tags";
import { Kind } from "framework/components/kind";

/**
 * 注册全部内置组件及其 AoS 初始化钩子。
 * 供 bootstrap 在启动时调用一次（注册表按组件名去重，重复注册会抛错）。
 */
export function registerBuiltinComponents(registry: ComponentRegistry): void {
  // 空间/运动/碰撞
  registry.register("Transform", Transform, {
    description: "二维位姿：实体中心的世界坐标、朝向与缩放，由生成/移动/演化链路在运行时写入。",
  });
  registry.register("Size", Size, {
    description: "二维尺寸：实体包围盒的宽/高（像素），供碰撞与占位计算。",
    configSchema: z.object({
      /** 宽度（像素）。 */
      w: z.number().nonnegative().optional(),
      /** 高度（像素）。 */
      h: z.number().nonnegative().optional(),
    }),
  });
  registry.register("Velocity", Velocity, {
    description: "二维速度：每 tick 的位移增量，由输入/物理系统在运行时写入。",
  });
  registry.register("Acceleration", Acceleration, {
    description: "二维加速度：每 tick 的速度增量，由行为/物理系统在运行时写入。",
  });
  registry.register("Collider", Collider, {
    description: "碰撞体：以形状（圆形/矩形）与尺寸参与物理分离与命中判定。",
    configSchema: z.object({
      /** 碰撞体形状：0=圆形（用 radius），1=矩形（用 halfW/halfH）。 */
      shape: z.union([z.literal(0), z.literal(1)]).optional(),
      /** 圆形半径（像素；shape=0 时生效）。 */
      radius: z.number().nonnegative().optional(),
      /** 矩形半宽（像素；shape=1 时生效）。 */
      halfW: z.number().nonnegative().optional(),
      /** 矩形半高（像素；shape=1 时生效）。 */
      halfH: z.number().nonnegative().optional(),
    }),
  });
  // 战斗
  registry.register("Health", Health, {
    description: "生命值：当前值与上限，归零触发死亡/重生。",
    configSchema: z.object({
      /** 当前生命值。 */
      current: z.number().nonnegative().optional(),
      /** 最大生命值。 */
      max: z.number().nonnegative().optional(),
    }),
  });
  registry.register("Attack", Attack, {
    description: "攻击力：数值与射程（像素），供战斗系统计算伤害与命中距离。",
    configSchema: z.object({
      /** 攻击力数值。 */
      value: z.number().nonnegative().optional(),
      /** 攻击射程（像素）；0 表示未设置，由系统回退到默认。 */
      range: z.number().nonnegative().optional(),
    }),
  });
  registry.register("Defense", Defense, {
    description: "防御力：数值，用于减免受到的伤害。",
    configSchema: z.object({
      /** 防御力数值。 */
      value: z.number().nonnegative().optional(),
    }),
  });
  registry.register("Team", Team, {
    description: "阵营：队伍编号，用于敌我判定与仇恨分组；通常经原型 team 字段声明。",
    configSchema: z.object({
      /** 阵营/队伍编号。 */
      id: z.number().int().nonnegative().optional(),
    }),
  });
  // AI 状态/目标/黑板引用
  registry.register("AIState", AIState, {
    description: "AI 状态：存放有限状态机状态值，由行为树/系统在运行时推进。",
  });
  registry.register("Target", Target, {
    description: "锁定目标：存放目标实体 eid，由感知/战斗系统在运行时写入。",
  });
  registry.register("BlackboardRef", BlackboardRef, {
    description: "黑板引用：存放行为树黑板数据标识，由 AI 在运行时维护。",
  });
  // 物品/背包（AoS）
  registry.register("Inventory", Inventory, {
    description: "背包：按容量建立槽位数组，槽位存 item kind 字符串与堆叠数。",
    configSchema: z.object({
      /** 槽位容量（槽位数）。 */
      capacity: z.number().int().positive().default(4),
    }),
  });
  registry.register("ItemMeta", ItemMeta, {
    description: "地面物品元数据：记录 kind、堆叠数与最早可拾取时间；由掉落/拾取链路在运行时写入。",
  });
  // 需求/资源/掉落（AoS）
  registry.register("Needs", Needs, {
    description: "需求列表：按名声明需求的上限、衰减与归零扣血，由需求系统统一推进。",
    configSchema: z.array(
      z.object({
        /** 需求名（游戏侧约定，按名匹配恢复与衰减）。 */
        name: z.string().default(""),
        /** 当前值；缺省回退到 max。 */
        current: z.number().optional(),
        /** 上限。 */
        max: z.number().default(0),
        /** 每秒衰减量。 */
        decayPerSec: z.number().default(0),
        /** 归零时每秒扣除的生命值。 */
        depletionDmg: z.number().default(0),
      }),
    ),
  });
  registry.register("ResourceNode", ResourceNode, {
    description: "可采集资源节点：剩余次数、每次产出与枯竭再生，采集系统按此结算。",
    configSchema: z.object({
      /** 剩余可采集次数；缺省回退到 max。 */
      remaining: z.number().optional(),
      /** 上限（remaining 回满到此值）；缺省回退到 remaining 或 1。 */
      max: z.number().positive().optional(),
      /** 每次采集产出数量。 */
      amountPerHit: z.number().positive().default(1),
      /** 枯竭后回满所需毫秒；0 表示不自动回满。 */
      regenMs: z.number().nonnegative().default(0),
      /** 产出物的 item kind 字符串。 */
      yieldsKind: z.string().default(""),
      /** 是否直接施加 consume 效果而不入背包。 */
      directConsume: z.boolean().default(false),
    }),
  });
  registry.register("LootTable", LootTable, {
    description: "掉落表：死亡时逐条掷骰产出的 item kind、数量与命中概率。",
    configSchema: z.array(
      z.object({
        /** item kind 字符串。 */
        kind: z.string().default(""),
        /** 命中时的掉落数量。 */
        qty: z.number().default(1),
        /** 命中概率（0~1）。 */
        chance: z.number().min(0).max(1).default(1),
      }),
    ),
  });
  // 巢穴生产（AoS）：周期在巢周围补足 spawnKind 实体至容量（gameplay/nestSystem）
  registry.register("Nest", Nest, {
    description: "巢穴生产：按周期把巢周围的 spawnKind 原型实体补足到容量上限。",
    configSchema: z.object({
      /** 生产的实体原型 kind（archetypes 注册表引用）；必填非空。 */
      spawnKind: z.string().min(1),
      /** 巢周围的目标存量上限；0 表示不生产。 */
      capacity: z.number().int().nonnegative().default(0),
      /** 生产门控周期（tick 数）。 */
      intervalTicks: z.number().int().positive().default(1),
    }),
  });
  // 感知
  registry.register("Perception", Perception, {
    description: "感知：声明视觉半径与敌对反应半径（像素），供感知系统筛选目标。",
    configSchema: z.object({
      /** 感知半径（像素）。 */
      visionRadius: z.number().nonnegative().optional(),
      /** 敌对反应半径（像素）。 */
      hostilityRange: z.number().nonnegative().optional(),
    }),
  });
  // 装备/合成/光源/放置/网格占用
  registry.register("Equipment", Equipment, {
    description: "装备槽：三槽分别引用背包槽位索引（-1 表示未穿戴）。",
    configSchema: z.object({
      /** 武器槽：引用 Inventory 槽位索引；-1 未穿戴。 */
      weaponSlot: z.number().int().min(-1).optional(),
      /** 工具槽：引用 Inventory 槽位索引；-1 未穿戴。 */
      toolSlot: z.number().int().min(-1).optional(),
      /** 护甲槽：引用 Inventory 槽位索引；-1 未穿戴。 */
      armorSlot: z.number().int().min(-1).optional(),
    }),
  });
  registry.register("CraftingStation", CraftingStation, {
    description: "合成站点：站点类型编号，供合成系统按类型匹配；0 表示通用手搓。",
    configSchema: z.object({
      /** 站点类型编号。 */
      stationType: z.number().int().nonnegative().optional(),
    }),
  });
  registry.register("LightSource", LightSource, {
    description: "光源：光照半径与剩余燃料，供按距离判断光照条件。",
    configSchema: z.object({
      /** 光照半径（像素）。 */
      radius: z.number().nonnegative().optional(),
      /** 剩余燃料（毫秒）；≤ 0 视为熄灭。 */
      fuelRemainingMs: z.number().optional(),
    }),
  });
  registry.register("Placeable", Placeable, {
    description: "可放置物：声明放置占位尺寸、是否参与碰撞与放置者归属。",
    configSchema: z.object({
      /** 占位宽度（像素）。 */
      footprintW: z.number().nonnegative().optional(),
      /** 占位高度（像素）。 */
      footprintH: z.number().nonnegative().optional(),
      /** 放置后是否参与碰撞：1=是，0=否。 */
      canCollide: z.union([z.literal(0), z.literal(1)]).optional(),
      /** 放置者网络标识；0=无主/世界物。 */
      ownerNetworkId: z.number().int().nonnegative().optional(),
    }),
  });
  registry.register("GridOccupancy", GridOccupancy, {
    description: "网格占用：记录实体占据的格组（tile 对齐）；由放置系统在运行时写入。",
  });
  // 传送/对话/任务/好感/意图（AoS）
  registry.register("Portal", Portal, {
    description: "传送门：玩家相交时切换到目标地图与坐标。",
    configSchema: z.object({
      /** 目标地图 id（maps/registry.json 的 maps 键）。 */
      targetMap: z.string().default(""),
      /** 传送目标 X（世界坐标）。 */
      x: z.number().default(0),
      /** 传送目标 Y（世界坐标）。 */
      y: z.number().default(0),
    }),
  });
  registry.register("Dialogue", Dialogue, {
    description: "对话会话：玩家当前对话的对象、树、节点与选项；由对话系统在运行时写入。",
  });
  registry.register("DialogueSource", DialogueSource, {
    description: "对话来源：声明 NPC 提供的对话树 id，供对话系统按树打开。",
    configSchema: z.object({
      /** 对话树 id（game/dialogues/*.json 的树引用）。 */
      treeId: z.string().default(""),
    }),
  });
  registry.register("Quest", Quest, {
    description: "任务进度：玩家的任务状态机与累计计数；由任务系统在运行时写入。",
  });
  registry.register("Relation", Relation, {
    description: "好感度：玩家对各类 NPC 的好感值；由对话/任务系统在运行时增减。",
  });
  registry.register("Intent", Intent, {
    description: "交互意图：单槽位存放当前帧的交互/攻击信号，由输入写入、交互系统消费。",
  });
  // 地图分区（AoS）：实体所属地图标识，无条目回退 world.defaultMapId
  registry.register("EntityMap", EntityMap, {
    description: "地图归属：实体所属地图 id，由生成链路在运行时写入，无条目回退默认地图。",
  });
  // 出生点（AoS）：实体持久化出生落点，由玩家创建链路写入（重生依据，随实体入档）
  registry.register("SpawnPoint", SpawnPoint, {
    description: "出生点：实体持久化的出生地图与坐标，由玩家创建链路在运行时写入。",
  });
  // 网络同步
  registry.register("NetworkId", NetworkId, {
    description: "网络标识：稳定网络 id（不等于 eid），由生成/恢复链路在运行时分配。",
  });
  registry.register("LastSynced", LastSynced, {
    description: "同步帧：记录最近一次被同步的逻辑帧，供增量同步使用。",
  });
  registry.register("Cooldown", Cooldown, {
    description: "冷却计时：剩余冷却毫秒，由战斗等系统在运行时递减。",
  });
  registry.register("Duration", Duration, {
    description: "持续时间计时：剩余毫秒，由效果等系统在运行时递减。",
  });
  // 计数账本（AoS，持久化）/ 投射物（SoA，瞬态）
  registry.register("Ledger", Ledger, {
    description: "计数账本：按 kind 记录数量的无槽位容器，由容器层读写。",
    configSchema: z.object({
      /** 初始条目（kind → 数量）；缺省空账本。 */
      entries: z.record(z.string(), z.number()).optional(),
    }),
  });
  registry.register("Projectile", Projectile, {
    description: "投射物：直线运动与接触判定参数，由投射物系统在运行时创建与推进。",
  });
  // 属性修饰符 / 触发器挂载（AoS，持久化）
  registry.register("Modifiers", Modifiers, {
    description: "属性修饰符：按 statKey 挂乘法/加法/布尔修正，由效果等在运行时施加。",
  });
  registry.register("Triggers", Triggers, {
    description: "触发器挂载：声明触发器名与命中时执行的效果列表，由配置/效果在运行时挂载。",
  });
  // 定时器（AoS，瞬态——运行时状态，恢复后由效果/触发配置重建）
  registry.register("ExpiresAt", ExpiresAt, {
    description: "一次性定时器：绝对到期 tick 与效果引用，由效果/系统在运行时设置。",
  });
  registry.register("Interval", Interval, {
    description: "周期定时器：触发周期、下次触发 tick 与剩余次数，由效果/系统在运行时设置。",
  });
  // 标签（bitecs 空组件）
  registry.register("Player", Player, {
    description: "玩家标签：标记实体为玩家。",
  });
  registry.register("Enemy", Enemy, {
    description: "敌对标签：标记实体为敌对单位。",
  });
  registry.register("NPC", NPC, {
    description: "NPC 标签：标记实体为可交互 NPC。",
  });
  registry.register("Item", Item, {
    description: "物品标签：标记实体为可拾取/可交互物品。",
  });
  registry.register("Resource", Resource, {
    description: "资源标签：标记实体为可采集资源节点。",
  });
  // 种类标签（AoS）
  registry.register("Kind", Kind, {
    description: "种类标签：实体原型 kind 字符串，由生成链路在运行时写入。",
  });

  // AoS 组件初始化钩子
  registry.registerAosInitializer("Inventory", initInventory);
  registry.registerAosInitializer("Needs", initNeeds);
  registry.registerAosInitializer("ResourceNode", initResourceNode);
  registry.registerAosInitializer("Nest", initNest);
  registry.registerAosInitializer("LootTable", initLootTable);
  registry.registerAosInitializer("Portal", initPortal);
  registry.registerAosInitializer("DialogueSource", initDialogueSource);
  registry.registerAosInitializer("Ledger", initLedger);
}
