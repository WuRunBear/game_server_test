import { query } from "bitecs";
import { Player, NPC, Transform, Resource, Enemy, Health, Intent, entityMapOf } from "components";
import { entityLevelOf } from "framework/components/entityLevel";
import { sameLevelDistance } from "framework/utils/gameplayDistance";
import type { GameWorld } from "world";
import { harvest, hasRequiredTool } from "framework/systems/gameplay/gatheringSystem";
import { attackTarget } from "framework/systems/gameplay/combatSystem";
import { startDialogue, dialogueTalkRange } from "framework/systems/gameplay/dialogueSystem";
import { awardHarvestXp } from "framework/systems/gameplay/progression";
import { Passage, togglePassage } from "framework/components/passage";

interface SystemConfig {
  range?: number;
}

const DEFAULT_RANGE = 24;

/**
 * 路由判定的实体地图 id：mapId 解析不到已构建图（归属异常 = 配置/存档 bug）
 * 时**不改写归属**——记 error 并原样返回，与任何真实图比较即自然跳过该实体
 * （全量常驻后不允许静默踢回默认图的旧纠偏行为）。
 */
function effectiveMapOf(world: GameWorld, eid: number): string {
  const m = entityMapOf(world, eid);
  if (m !== "" && !world.maps[m]) {
    world.logger.error("entity mapId does not resolve to a known map; entity skipped", {
      eid,
      mapId: m,
    });
  }
  return m;
}

/**
 * interactionSystem：交互意图路由器。
 *
 * 输入信号（interact / attack / talk）由 GameSimulation.applyInputs 写入 Intent[player]；
 * 本系统消费意图——无论成败清空 Intent（consume-or-discard 语义，不让意图跨帧堆积）：
 * - "interact"：在 range 内找最近资源节点调 harvest
 * - "attack"：找最近 [Enemy] 实体调 attackTarget（射程/冷却由 attackTarget 校验）
 * - "talk"：在 range 内找最近 [NPC] 实体调 startDialogue（对话树经 DialogueSource 查）
 *
 * 游戏无关——只识别通用意图与 Resource/Enemy/NPC 标签；具体产出由
 * gatheringSystem 按 yieldsKind、combatSystem 按规则、dialogueSystem 按树决定。
 */
export function createInteractionSystem(config?: Record<string, unknown>) {
  const cfg: SystemConfig = {
    range: config?.range as number | undefined,
  };

  return function interactionSystem(world: GameWorld): GameWorld {
    const range = cfg.range ?? DEFAULT_RANGE;

    for (const playerEid of query(world, [Player, Transform])) {
      const intent = Intent[playerEid];
      if (!intent) continue;
      // 先清空：意图只在本帧生效（无论是否路由）——死亡玩家残留的意图
      // 也必须消费，否则会在重生后的第一个存活 tick 触发幽灵攻击/采集
      Intent[playerEid] = null;
      // 死亡/重生窗口内的玩家不路由交互意图（防幽灵采集/攻击）
      if ((Health.current[playerEid] ?? 0) <= 0) continue;

      const px = Transform.x[playerEid];
      const py = Transform.y[playerEid];

      if (intent === "interact") {
        // 可开合通行口（Passage）：与资源节点共用 interact 意图与 range，
        // 取最近的交互目标——资源更近则采集，否则切换通行口开合。
        let nearestPassageEid = -1;
        let nearestPassageDist = Infinity;
        for (const passageEid of query(world, [Passage, Transform])) {
          if (effectiveMapOf(world, passageEid) !== effectiveMapOf(world, playerEid)) continue;
          const d = sameLevelDistance(
            px,
            py,
            entityLevelOf(playerEid),
            Transform.x[passageEid],
            Transform.y[passageEid],
            entityLevelOf(passageEid),
          );
          if (d === undefined) continue;
          if (d <= range && d < nearestPassageDist) {
            nearestPassageEid = passageEid;
            nearestPassageDist = d;
          }
        }

        let nearestEid = -1;
        let nearestDist = nearestPassageDist;
        for (const nodeEid of query(world, [Resource, Transform])) {
          if (effectiveMapOf(world, nodeEid) !== effectiveMapOf(world, playerEid)) continue;
          // 工具门槛不满足的节点不参与最近目标选择：否则「最近节点采不了」会
          // 让意图空转，挡住更远处本可采集的节点（采集仍是权威校验点）。
          if (!hasRequiredTool(world, playerEid, nodeEid)) continue;
          // 统一距离检查（前置修正 4）：同层欧氏距离，异层不可交互
          const d = sameLevelDistance(
            px,
            py,
            entityLevelOf(playerEid),
            Transform.x[nodeEid],
            Transform.y[nodeEid],
            entityLevelOf(nodeEid),
          );
          if (d === undefined) continue;
          if (d <= range && d < nearestDist) {
            nearestEid = nodeEid;
            nearestDist = d;
          }
        }

        if (nearestEid >= 0) {
          // 采集成功才结算经验（失败/门槛不满足不产经验）；经验数值来自节点配置
          if (harvest(world, playerEid, nearestEid)) {
            awardHarvestXp(world, playerEid, nearestEid);
          }
        } else if (nearestPassageEid >= 0) {
          togglePassage(world, nearestPassageEid);
        }
      } else if (intent === "attack") {
        let nearestEid = -1;
        let nearestDist = Infinity;
        for (const enemyEid of query(world, [Enemy, Health, Transform])) {
          if (effectiveMapOf(world, enemyEid) !== effectiveMapOf(world, playerEid)) continue;
          // 统一距离检查（前置修正 4）：异层不构成最近目标（射程由 attackTarget 复核）
          const d = sameLevelDistance(
            px,
            py,
            entityLevelOf(playerEid),
            Transform.x[enemyEid],
            Transform.y[enemyEid],
            entityLevelOf(enemyEid),
          );
          if (d === undefined) continue;
          if (d < nearestDist) {
            nearestEid = enemyEid;
            nearestDist = d;
          }
        }

        if (nearestEid >= 0) {
          attackTarget(world, playerEid, nearestEid);
        }
      } else if (intent === "talk") {
        // 对话半径单一来源：rules/dialogue.json 的 talkRange（缺省 48）。
        // interaction.range 只约束 interact/attack，避免"talkRange 48 被
        // interaction.range 24 屏蔽"的两套半径问题。
        const talkRange = dialogueTalkRange(world);
        let nearestEid = -1;
        let nearestDist = Infinity;
        for (const npcEid of query(world, [NPC, Transform])) {
          if (effectiveMapOf(world, npcEid) !== effectiveMapOf(world, playerEid)) continue;
          // 统一距离检查（前置修正 4）：同层欧氏距离，异层不可对话
          const d = sameLevelDistance(
            px,
            py,
            entityLevelOf(playerEid),
            Transform.x[npcEid],
            Transform.y[npcEid],
            entityLevelOf(npcEid),
          );
          if (d === undefined) continue;
          if (d <= talkRange && d < nearestDist) {
            nearestEid = npcEid;
            nearestDist = d;
          }
        }

        if (nearestEid >= 0) {
          startDialogue(world, playerEid, nearestEid);
        }
      }
    }

    return world;
  };
}

/** 无配置默认实例（向后兼容直接注册形态）。 */
export function interactionSystem(world: GameWorld): GameWorld {
  return createInteractionSystem()(world);
}