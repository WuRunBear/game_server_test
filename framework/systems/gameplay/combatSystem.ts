import { query, removeEntity, hasComponent } from "bitecs";
import { Health, Attack, Defense, Team } from "components";
import { Cooldown, Transform } from "components";
import type { GameWorld } from "world";
import { getRuleModule } from "framework/api";

interface SystemConfig {
  friendlyFire?: boolean;
  damageFormula?: string;
  damageFormulaRef?: string;
  attackCooldownMs?: number;
  attackRange?: number;
}

const DEFAULT_COOLDOWN_MS = 1000;
const DEFAULT_ATTACK_RANGE = 32;

export function createCombatSystem(config?: Record<string, unknown>) {
  const cfg: SystemConfig = {
    friendlyFire: config?.friendlyFire as boolean | undefined,
    damageFormula: config?.damageFormula as string | undefined,
    damageFormulaRef: config?.damageFormulaRef as string | undefined,
    attackCooldownMs: config?.attackCooldownMs as number | undefined,
    attackRange: config?.attackRange as number | undefined,
  };

  return function combatSystem(world: GameWorld): GameWorld {
    const rules = world.gameDef.resolvedRules["combat"] as SystemConfig | undefined;
    const friendlyFire = cfg.friendlyFire ?? rules?.friendlyFire ?? true;
    const damageFormula = cfg.damageFormula ?? rules?.damageFormula ?? "standard";
    const damageFormulaRef = cfg.damageFormulaRef ?? rules?.damageFormulaRef;
    const cooldownMs = cfg.attackCooldownMs ?? rules?.attackCooldownMs ?? DEFAULT_COOLDOWN_MS;
    const configuredRange = cfg.attackRange ?? rules?.attackRange;

    const attackers = query(world, [Attack, Team, Transform]);
    const targets = query(world, [Health, Defense, Team, Transform]);

    for (const attackerId of attackers) {
      if (hasComponent(world, attackerId, Cooldown)) {
        const remaining = Cooldown.remainingMs[attackerId];
        if (remaining !== undefined && remaining > 0) {
          Cooldown.remainingMs[attackerId] = Math.max(0, remaining - world.time.dtMs);
          continue;
        }
      }

      const componentRange = Attack.range[attackerId];
      const attackerRange =
        configuredRange ??
        (typeof componentRange === "number" && componentRange > 0 ? componentRange : DEFAULT_ATTACK_RANGE);
      const attackerX = Transform.x[attackerId];
      const attackerY = Transform.y[attackerId];

      for (const targetId of targets) {
        if (attackerId === targetId) continue;

        if (!friendlyFire && Team.id[attackerId] === Team.id[targetId]) continue;

        const dist = Math.hypot(attackerX - Transform.x[targetId], attackerY - Transform.y[targetId]);
        if (dist > attackerRange) continue;

        const attackerDamage = Attack.value[attackerId] ?? 10;
        const targetDefense = Defense.value[targetId] ?? 0;

        let damage = Math.max(1, attackerDamage - targetDefense);

        if (damageFormula === "custom" && damageFormulaRef) {
          try {
            const customFn = getRuleModule(damageFormulaRef);
            const customDamage = customFn(world, attackerId, targetId, attackerDamage, targetDefense);
            if (typeof customDamage === "number") damage = customDamage;
          } catch {
            // fallback to standard formula
          }
        }

        Health.current[targetId] = (Health.current[targetId] ?? 0) - damage;

        if (Health.current[targetId] <= 0) {
          removeEntity(world, targetId);
        }
      }

      Cooldown.remainingMs[attackerId] = cooldownMs;
    }

    return world;
  };
}

export function combatSystem(world: GameWorld): GameWorld {
  return createCombatSystem()(world);
}
