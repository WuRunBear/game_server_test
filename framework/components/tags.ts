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
