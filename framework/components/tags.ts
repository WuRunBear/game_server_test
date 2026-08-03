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
