/**
 * Player Tag：标记该实体为玩家。
 */
import { defineComponent } from "bitecs/legacy";

export const Player = defineComponent({});

/**
 * Enemy Tag：标记该实体为敌对单位。
 */
export const Enemy = defineComponent({});

/**
 * NPC Tag：标记该实体为 NPC。
 */
export const NPC = defineComponent({});

/**
 * Item Tag：标记该实体为可拾取/可交互物品。
 */
export const Item = defineComponent({});

/**
 * Resource Tag：标记该实体为资源节点（可采集），由 gatheringSystem 维护。
 * 游戏无关——「资源节点」是通用机制，具体产出由 ResourceNode.yieldsKind 决定。
 */
export const Resource = defineComponent({});

/**
 * Container Tag：标记该实体为可存取的容器（死亡容器/储物箱等承载物）。
 * 游戏无关——具体承载由 Inventory/Ledger 等数据组件决定，标签只供
 * 查询过滤与 netSync 按类同步（如容器背包对客户端可见）。
 */
export const Container = defineComponent({});
