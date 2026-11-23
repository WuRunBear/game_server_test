import { hasComponent, query } from "bitecs";
import { Player, NPC, Transform, Resource, Enemy, Health, Intent, entityMapOf, Attack } from "components";
import { entityLevelOf } from "framework/components/entityLevel";
import { sameLevelDistance } from "framework/utils/gameplayDistance";
import type { GameWorld } from "world";
import { harvest, hasRequiredTool } from "framework/systems/gameplay/gatheringSystem";
import { attackTarget, DEFAULT_ATTACK_RANGE } from "framework/systems/gameplay/combatSystem";
import { startDialogue, dialogueTalkRange } from "framework/systems/gameplay/dialogueSystem";
import { awardHarvestXp } from "framework/systems/gameplay/progression";
import { Passage, togglePassage } from "framework/components/passage";
import {
  findEidByNetworkId,
  getIntentActionId,
  takeActionInput,
} from "framework/simulation/actions/actionState";
import { startConfiguredAction } from "framework/simulation/actions/actionSystem";

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

/** 玩家实际攻击距离（组件 range > 0 优先，否则 combat 规则/默认值）。 */
function attackReachOf(world: GameWorld, playerEid: number): number {
  const componentRange = Attack.range[playerEid];
  if (typeof componentRange === "number" && componentRange > 0) return componentRange;
  const rules = world.gameDef.resolvedRules["combat"] as { attackRange?: number } | undefined;
  const configured = rules?.attackRange;
  return typeof configured === "number" && configured > 0 ? configured : DEFAULT_ATTACK_RANGE;
}

/**
 * interactionSystem：交互意图路由器。
 *
 * 输入信号（interact / attack / talk）由 GameSimulation.applyInputs 写入 Intent[player]；
 * 本系统消费意图——无论成败清空 Intent（consume-or-discard 语义，不让意图跨帧堆积）：
 * - "interact"：在 range 内找最近资源节点。配置了动作时间轴（game.json 的
 *   action 系统 + intentActions.interact）时**启动动作**，由 actionSystem 在
 *   swing/harvest 事件阶段调用 harvest；未配置时保持旧瞬时 harvest。
 * - "attack"：找最近 [Enemy] 实体。配置动作时启动 attack 动作（active/hit
 *   阶段才调用 attackTarget）；未配置时旧瞬时 attackTarget。
 * - "talk"：在 range 内找最近 [NPC] 实体调 startDialogue（对话保持瞬时路径）。
 *
 * 可选输入载荷（ActionInput，来自 PlayerInput.target/aimX/aimY）：
 * - target 是 networkId；命中合法且范围内的资源/敌人时优先于最近目标；
 * - 解析失败/不在范围 → 回退最近目标（与旧行为一致）；
 * - 目标最终解析为内部 eid 后写入 ActionState.targetEid（同步层只输出 networkId）。
 *
 * 开合通行口（Passage）保持旧瞬时路径，不进入动作时间轴。
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
      // 可选目标/瞄准载荷与意图同帧消费（不跨帧堆积）
      const actionInput = takeActionInput(playerEid);
      // 死亡/重生窗口内的玩家不路由交互意图（防幽灵采集/攻击）
      if ((Health.current[playerEid] ?? 0) <= 0) continue;

      const px = Transform.x[playerEid];
      const py = Transform.y[playerEid];

      if (intent === "interact") {
        const gatherActionId = getIntentActionId(world, "interact");
        const targetedEid = gatherActionId
          ? findEidByNetworkId(world, actionInput?.target)
          : undefined;

        // 显式目标通行口：toggle 保持瞬时路径（不受动作时间轴影响）
        if (targetedEid !== undefined && hasComponent(world, targetedEid, Passage)) {
          if (effectiveMapOf(world, targetedEid) === effectiveMapOf(world, playerEid)) {
            const d = sameLevelDistance(
              px,
              py,
              entityLevelOf(playerEid),
              Transform.x[targetedEid],
              Transform.y[targetedEid],
              entityLevelOf(targetedEid),
            );
            if (d !== undefined && d <= range) {
              togglePassage(world, targetedEid);
              continue;
            }
          }
        }

        // 显式资源目标：同图/同层/范围内且工具门槛满足才采用
        let targetedResourceEid = -1;
        if (
          gatherActionId &&
          targetedEid !== undefined &&
          hasComponent(world, targetedEid, Resource) &&
          effectiveMapOf(world, targetedEid) === effectiveMapOf(world, playerEid) &&
          hasRequiredTool(world, playerEid, targetedEid)
        ) {
          const d = sameLevelDistance(
            px,
            py,
            entityLevelOf(playerEid),
            Transform.x[targetedEid],
            Transform.y[targetedEid],
            entityLevelOf(targetedEid),
          );
          if (d !== undefined && d <= range) targetedResourceEid = targetedEid;
        }

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

        // 显式目标优先（已通过范围/工具校验）；否则沿用最近目标选择
        if (targetedResourceEid >= 0) nearestEid = targetedResourceEid;

        if (nearestEid >= 0) {
          if (gatherActionId) {
            // 动作时间轴：启动 gather，harvest 在 swing 事件阶段结算；
            // 动作锁定/冷却中启动失败 → 本帧意图丢弃（不绕过冷却即时采集）。
            startConfiguredAction(world, playerEid, gatherActionId, {
              targetEid: nearestEid,
              maxRange: range,
            });
          } else if (harvest(world, playerEid, nearestEid)) {
            // 无动作配置：旧瞬时路径（采集成功才结算经验）
            awardHarvestXp(world, playerEid, nearestEid);
          }
        } else if (nearestPassageEid >= 0) {
          togglePassage(world, nearestPassageEid);
        }
      } else if (intent === "attack") {
        const attackActionId = getIntentActionId(world, "attack");
        const targetedEid = attackActionId
          ? findEidByNetworkId(world, actionInput?.target)
          : undefined;

        // 显式目标：存活、同图、同层且在攻击距离内才采用；否则回退最近目标
        let targetedEnemyEid = -1;
        if (
          attackActionId &&
          targetedEid !== undefined &&
          hasComponent(world, targetedEid, Enemy) &&
          (Health.current[targetedEid] ?? 0) > 0 &&
          effectiveMapOf(world, targetedEid) === effectiveMapOf(world, playerEid)
        ) {
          const d = sameLevelDistance(
            px,
            py,
            entityLevelOf(playerEid),
            Transform.x[targetedEid],
            Transform.y[targetedEid],
            entityLevelOf(targetedEid),
          );
          if (d !== undefined && d <= attackReachOf(world, playerEid)) {
            targetedEnemyEid = targetedEid;
          }
        }

        let nearestEid = -1;
        let nearestDist = Infinity;
        for (const enemyEid of query(world, [Enemy, Health, Transform])) {
          if (effectiveMapOf(world, enemyEid) !== effectiveMapOf(world, playerEid)) continue;
          // 动作时间轴：已死亡目标不参与最近目标选择（避免选到尸体空挥）；
          // 无动作配置时保持历史行为（attackTarget 自己会拒绝尸体）。
          if (attackActionId && (Health.current[enemyEid] ?? 0) <= 0) continue;
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

        // 显式目标已解析则优先；否则最近目标
        if (targetedEnemyEid >= 0) nearestEid = targetedEnemyEid;

        if (nearestEid >= 0) {
          if (attackActionId) {
            // 动作时间轴：active/hit 事件阶段才调用 attackTarget；
            // 动作锁定/冷却中启动失败 → 丢弃本帧意图（不绕过冷却）。
            startConfiguredAction(world, playerEid, attackActionId, {
              targetEid: nearestEid,
            });
          } else {
            attackTarget(world, playerEid, nearestEid);
          }
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
