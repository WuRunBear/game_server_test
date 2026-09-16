/**
 * 内置效果装配：注册框架自带的七个通用效果执行器。
 *
 * 由 bootstrapFramework 调用一次（注册表查重，重复注册抛错）。
 * 全部效果为通用机制词（damage/heal/status/impulse/ledger/spawn 等），
 * 具体数值与语义由 EffectSpec.params / game/ 配置声明。
 */
import { hasComponent } from "bitecs";
import { Health, Defense, Kind, Transform } from "components";
import type { GameWorld } from "framework/world";
import { registerEffect, positionOfEntity } from "framework/simulation/effects/effectRegistry";
import { computeStandardDamage } from "framework/systems/gameplay/damageFormula";
import { getEquipModifiers } from "framework/systems/gameplay/equipmentSystem";
import { emitEvent } from "framework/events/gameEvents";
import { addModifier } from "framework/simulation/modifiers/modifiers";
import { insertContainer, removeContainer, type ContainerRef } from "framework/economy/container";
import { spawnProjectile } from "framework/systems/gameplay/projectileSystem";
import { spawnEntity } from "framework/entities/spawn";

/** 参数读取工具：数值参数（非法/缺失回退缺省值）。 */
function numParam(params: Record<string, unknown>, key: string, fallback: number): number {
  const value = Number(params[key]);
  return Number.isFinite(value) ? value : fallback;
}

/** 参数读取工具：字符串参数（非字符串回退空串）。 */
function strParam(params: Record<string, unknown>, key: string): string {
  const value = params[key];
  return typeof value === "string" ? value : "";
}

/**
 * 注册全部内置效果（bootstrap 时调用一次；重复调用因注册表查重抛错）。
 */
export function registerBuiltinEffects(): void {
  /**
   * damage：对目标施加伤害（params.amount 为防御前基础量）。
   *
   * 防御取 Defense 组件值 + 装备防御加成，与 combatSystem 同一公式
   * （computeStandardDamage 共用，保证数值路径一致）；目标已死跳过；
   * 致命伤害发 gameEvents 的 killed 事件（与攻击路径同语义，questSystem 等
   * 消费方无感）。
   */
  registerEffect("damage", (ctx) => {
    const amount = numParam(ctx.params, "amount", 0);
    if (!(amount > 0)) return false;

    let applied = false;
    for (const target of ctx.targets) {
      if (!hasComponent(ctx.world, target, Health)) continue;
      if ((Health.current[target] ?? 0) <= 0) continue;
      const defense =
        (hasComponent(ctx.world, target, Defense) ? (Defense.value[target] ?? 0) : 0) +
        getEquipModifiers(ctx.world, target).defenseBonus;
      Health.current[target] = (Health.current[target] ?? 0) - computeStandardDamage(amount, defense);
      applied = true;
      if ((Health.current[target] ?? 0) <= 0) {
        emitEvent(ctx.world, "killed", {
          killer: ctx.source,
          victim: target,
          kind: Kind[target] ?? "",
        });
      }
    }
    return applied;
  });

  /** heal：治疗目标（params.amount 恢复量，上限 Health.max；死亡目标跳过）。 */
  registerEffect("heal", (ctx) => {
    const amount = numParam(ctx.params, "amount", 0);
    if (!(amount > 0)) return false;

    let healed = false;
    for (const target of ctx.targets) {
      if (!hasComponent(ctx.world, target, Health)) continue;
      const current = Health.current[target] ?? 0;
      if (current <= 0) continue;
      const max = Health.max[target] ?? current;
      const next = Math.min(max, current + amount);
      if (next !== current) {
        Health.current[target] = next;
        healed = true;
      }
    }
    return healed;
  });

  /**
   * spawn-projectile：从作用位置发射直线投射物。
   *
   * params：vx/vy（像素/秒）、lifeMs（缺省 2000）、radius（缺省 4）。
   * 运动承载为 Projectile 组件 + projectileSystem（命中只发 on-contact 事件）。
   */
  registerEffect("spawn-projectile", (ctx) => {
    const pos = ctx.position ?? positionOfEntity(ctx.world, ctx.source);
    if (!pos) return false;
    spawnProjectile(
      ctx.world,
      ctx.source,
      pos.x,
      pos.y,
      numParam(ctx.params, "vx", 0),
      numParam(ctx.params, "vy", 0),
      numParam(ctx.params, "lifeMs", 2000),
      numParam(ctx.params, "radius", 4),
    );
    return true;
  });

  /**
   * apply-status：给目标追加一条属性修饰符（状态的最小实现——复用 Modifiers）。
   *
   * params：stat（statKey，必填）、mul/add/bool（修正值，至少其一）、
   * durationTicks（>0 时按当前 tick 换算失效时刻）、source（来源标识）。
   */
  registerEffect("apply-status", (ctx) => {
    const stat = strParam(ctx.params, "stat");
    if (!stat) return false;
    if (ctx.params.mul === undefined && ctx.params.add === undefined && ctx.params.bool === undefined) {
      return false;
    }

    const durationTicks = numParam(ctx.params, "durationTicks", 0);
    const source = strParam(ctx.params, "source") || "status";
    const expiresTick = durationTicks > 0 ? ctx.world.time.tick + durationTicks : undefined;

    let applied = false;
    for (const target of ctx.targets) {
      addModifier(ctx.world, target, stat, {
        mul: typeof ctx.params.mul === "number" ? ctx.params.mul : undefined,
        add: typeof ctx.params.add === "number" ? ctx.params.add : undefined,
        bool: typeof ctx.params.bool === "boolean" ? ctx.params.bool : undefined,
        source,
        expiresTick,
      });
      applied = true;
    }
    return applied;
  });

  /** impulse：位移脉冲——对目标做瞬时位移（params.dx/dy 像素增量）。 */
  registerEffect("impulse", (ctx) => {
    const dx = numParam(ctx.params, "dx", 0);
    const dy = numParam(ctx.params, "dy", 0);
    if (dx === 0 && dy === 0) return false;

    let moved = false;
    for (const target of ctx.targets) {
      if (!hasComponent(ctx.world, target, Transform)) continue;
      Transform.x[target] += dx;
      Transform.y[target] += dy;
      moved = true;
    }
    return moved;
  });

  /**
   * ledger：对目标账本记账（params.op = credit | debit）。
   *
   * params：kind（账目种类，必填）、count（数量 > 0）。credit 入账
   * （无账本自动创建）；debit 扣账（余额不足该目标失败，效果整体 false）。
   */
  registerEffect("ledger", (ctx) => {
    const op = ctx.params.op === "debit" ? "debit" : "credit";
    const kind = strParam(ctx.params, "kind");
    const count = numParam(ctx.params, "count", 0);
    if (!kind || !(count > 0)) return false;

    let ok = true;
    for (const target of ctx.targets) {
      const ref: ContainerRef = { type: "ledger", eid: target };
      if (op === "credit") {
        insertContainer(ctx.world, ref, kind, count);
      } else if (!removeContainer(ctx.world, ref, kind, count)) {
        ok = false;
      }
    }
    return ok;
  });

  /**
   * spawn-entity：按原型名召唤实体（params.archetype，必填）。
   *
   * params：count（缺省 1）、offsetX/offsetY（相对作用位置偏移）、
   * mapId（缺省随来源实体归属）。作用位置缺省为来源实体位置。
   */
  registerEffect("spawn-entity", (ctx) => {
    const archetypeName = strParam(ctx.params, "archetype");
    if (!archetypeName) return false;

    if (!ctx.world.archetypes.has(archetypeName)) {
      ctx.world.logger.warn("spawn-entity 原型未注册", { archetype: archetypeName, source: ctx.source });
      return false;
    }

    const pos = ctx.position ?? positionOfEntity(ctx.world, ctx.source);
    if (!pos) return false;

    const count = Math.max(1, Math.floor(numParam(ctx.params, "count", 1)));
    const offsetX = numParam(ctx.params, "offsetX", 0);
    const offsetY = numParam(ctx.params, "offsetY", 0);
    const mapId = strParam(ctx.params, "mapId") || undefined;
    const archetype = ctx.world.archetypes.get(archetypeName);

    let spawned = 0;
    for (let i = 0; i < count; i++) {
      spawnEntity(ctx.world, archetype, ctx.world.components_registry, {
        x: pos.x + offsetX,
        y: pos.y + offsetY,
        mapId,
      });
      spawned += 1;
    }
    return spawned > 0;
  });
}
