import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { z } from "zod";

/**
 * 动作时间轴配置 schema（`game/actions/actions.json`）。
 *
 * 设计边界：
 * - 框架只解释**通用动作过程**：时长、阶段边界、事件阶段、移动锁、可打断性；
 *   动作 id（"attack" / "gather" / "throw"）与具体数值全部由游戏配置声明，
 *   framework 不写死任何动作时长。
 * - 时间基一律为**逻辑 tick**（`world.time.tick`）：`durationTicks` 与
 *   `phases[].endTick` 都是相对动作开始 tick 的偏移，不混用毫秒。
 * - `events[].phase` 引用阶段 id；事件在该阶段**进入时**触发一次（阶段区间为
 *   `[上一阶段 endTick, 本阶段 endTick)`）。攻击 hit、采集 harvest、投掷
 *   spawn-projectile 都由 actionSystem 在事件阶段调用既有原子，不复制规则。
 * - 未知事件 type 在加载期 fail-fast（zod enum），运行期再兜底抛错。
 */

/** 当前框架支持的动作事件类型（通用机制词，不含游戏名词）。 */
export const ACTION_EVENT_TYPES = ["hit", "harvest", "spawn-projectile"] as const;

/** 动作事件类型（zod enum）。 */
export const ActionEventTypeSchema = z.enum(ACTION_EVENT_TYPES);

/**
 * 动作阶段：`endTick` 是该阶段结束的相对 tick（开区间上界）。
 *
 * 阶段区间为 `[上一阶段 endTick, 本阶段 endTick)`；首阶段从 0 开始。
 * 最后一个阶段的 `endTick` 必须等于 `durationTicks`。
 */
export const ActionPhaseSchema = z.object({
  /** 阶段 id（事件按此引用；同一动作内唯一）。 */
  id: z.string().min(1),
  /** 阶段结束的相对 tick（相对动作开始，正整数，严格递增）。 */
  endTick: z.number().int().positive(),
});

/** 阶段事件：进入 `phase` 时触发一次 `type`。 */
export const ActionEventSchema = z.object({
  /** 目标阶段 id（必须存在于 phases）。 */
  phase: z.string().min(1),
  /** 事件类型（未知类型加载期即拒绝）。 */
  type: ActionEventTypeSchema,
});

/**
 * 单个动作定义。
 *
 * - `durationTicks`：动作总时长（tick）；客户端用
 *   `(RoomState.tick - Action.startedTick) / Action.durationTicks` 算进度。
 * - `phases`：阶段边界（末阶段 endTick == durationTicks）。
 * - `events`：阶段进入事件（每个事件在动作生命周期内只触发一次）。
 * - `lockMovement`：动作期间是否锁移动（applyInputs/actionSystem 保证）。
 * - `interruptible`：是否允许被新动作替换。
 * - `cooldownTicks`：动作级冷却（可选）。配置后动作开始时写入
 *   `Cooldown.remainingMs`（tick × fixedDtMs），冷却未结束时拒绝新动作；
 *   事件阶段调用既有原子时临时让出冷却判定，原子成功后恢复不短于开始时冷却。
 * - `cancelOnDamage`：受击（Health 下降）是否取消（按配置；默认 false）。
 */
export const ActionDefinitionSchema = z
  .object({
    /** 动作总时长（tick）。 */
    durationTicks: z.number().int().positive(),
    /** 阶段列表（至少一个；末阶段 endTick 必须等于 durationTicks）。 */
    phases: z.array(ActionPhaseSchema).min(1),
    /** 阶段事件（进入阶段时触发一次）。 */
    events: z.array(ActionEventSchema).default([]),
    /** 动作期间是否锁移动（默认 false）。 */
    lockMovement: z.boolean().default(false),
    /** 是否允许被新动作替换（默认 false）。 */
    interruptible: z.boolean().default(false),
    /** 动作级冷却（tick；可选，配置后动作开始时写入 Cooldown）。 */
    cooldownTicks: z.number().int().nonnegative().optional(),
    /** 受击是否取消动作（默认 false）。 */
    cancelOnDamage: z.boolean().default(false),
  })
  .superRefine((definition, ctx) => {
    const phaseIds = new Set<string>();
    let previousEnd = 0;
    for (let i = 0; i < definition.phases.length; i++) {
      const phase = definition.phases[i]!;
      if (phaseIds.has(phase.id)) {
        ctx.addIssue({
          code: "custom",
          path: ["phases", i, "id"],
          message: `duplicate phase id "${phase.id}"`,
        });
      }
      phaseIds.add(phase.id);
      if (phase.endTick <= previousEnd) {
        ctx.addIssue({
          code: "custom",
          path: ["phases", i, "endTick"],
          message: `phase endTick must be strictly increasing (previous ${previousEnd}, got ${phase.endTick})`,
        });
      }
      previousEnd = phase.endTick;
    }
    const lastEnd = definition.phases[definition.phases.length - 1]?.endTick;
    if (lastEnd !== definition.durationTicks) {
      ctx.addIssue({
        code: "custom",
        path: ["phases"],
        message: `last phase endTick (${lastEnd}) must equal durationTicks (${definition.durationTicks})`,
      });
    }

    const seenEvents = new Set<string>();
    for (let i = 0; i < definition.events.length; i++) {
      const event = definition.events[i]!;
      if (!phaseIds.has(event.phase)) {
        ctx.addIssue({
          code: "custom",
          path: ["events", i, "phase"],
          message: `event phase "${event.phase}" is not declared in phases`,
        });
      }
      // 同一阶段同一类型只允许一个事件：防止同 tick 双结算（配置错误 fail-fast）。
      const key = `${event.phase}:${event.type}`;
      if (seenEvents.has(key)) {
        ctx.addIssue({
          code: "custom",
          path: ["events", i],
          message: `duplicate event "${key}" in the same phase (would resolve twice)`,
        });
      }
      seenEvents.add(key);
    }
  });

/** 动作配置文档根结构（`{ "actions": { ... } }`）。 */
export const ActionConfigSchema = z.object({
  /** 动作 id → 动作定义。 */
  actions: z.record(z.string(), ActionDefinitionSchema),
});

/** 动作系统配置（game.json 的 systems[].config）。 */
export const ActionSystemConfigSchema = z.object({
  /**
   * 动作配置文件路径（相对 process.cwd()，与 game.json 的加载基准一致；
   * 绝对路径原样使用）。缺省且未提供内联 actions 时动作系统为 no-op，
   * attack/gather/throw 保持旧瞬时行为。
   */
  actionsPath: z.string().min(1).optional(),
  /** 内联动作定义（测试/工具用；提供时优先于 actionsPath）。 */
  actions: z.record(z.string(), ActionDefinitionSchema).optional(),
  /**
   * 意图名 → 动作 id 的映射（如 `{ "attack": "attack", "interact": "gather",
   * "throw": "throw" }`）。引用的动作 id 必须在 actions 中存在（加载期校验）。
   */
  intentActions: z.record(z.string(), z.string()).default({}),
});

/** 动作定义（经 zod 解析后的形态，默认值已填充）。 */
export type ActionDefinition = z.infer<typeof ActionDefinitionSchema>;
/** 动作阶段定义。 */
export type ActionPhase = z.infer<typeof ActionPhaseSchema>;
/** 动作事件定义。 */
export type ActionEvent = z.infer<typeof ActionEventSchema>;
/** 动作配置文档。 */
export type ActionConfigDocument = z.infer<typeof ActionConfigSchema>;
/** 动作系统配置（game.json systems[].config）。 */
export type ActionSystemConfig = z.infer<typeof ActionSystemConfigSchema>;

/**
 * 解析动作配置文本/对象（不做文件 I/O；测试可直接传对象）。
 *
 * @param raw JSON.parse 后的对象
 * @param source 错误定位用的来源标签（文件路径/测试名）
 */
export function parseActionConfig(raw: unknown, source = "actions config"): ActionConfigDocument {
  try {
    return ActionConfigSchema.parse(raw);
  } catch (err) {
    throw new Error(
      `invalid action config "${source}": ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/**
 * 读取并校验动作配置文件。
 *
 * 路径按 process.cwd() 解析（与 loadGameDefinition 的 gameJsonPath 基准一致）；
 * 绝对路径直接使用。文件不存在/JSON 损坏/schema 非法一律 fail-fast。
 */
export function loadActionConfigFile(filePath: string): ActionConfigDocument {
  const fullPath = resolve(process.cwd(), filePath);
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(fullPath, "utf8")) as unknown;
  } catch (err) {
    throw new Error(
      `failed to read action config "${fullPath}": ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  return parseActionConfig(raw, fullPath);
}
