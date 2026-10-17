/**
 * ResourceNode 组件：可采集资源节点（AoS 结构）。
 *
 * 由 spawn 的 AoS 初始化钩子写入，按 archetype 的 ResourceNode 配置建状态。
 * 字段名与语义游戏无关（yieldsKind 仍是字符串引用 item kind；具体产出由 game/ 配置）。
 */
import type { LootEntry } from "components/loot";

export interface ResourceNodeState {
  /** 剩余可采集次数（remaining ≤ 0 表示枯竭，待 regenMs 后回满）。 */
  remaining: number;
  /** 上限（remaining 回满到此值）。 */
  max: number;
  /** 每次采集产出数量（仅单产物回退路径使用；配置 lootTable 时不参与）。 */
  amountPerHit: number;
  /** 枯竭后回满所需毫秒；0 表示不自动回满（一次性 / 常驻）。 */
  regenMs: number;
  /** 产出物的 item kind 字符串（lootTable 缺省时的单产物回退；也用于 directConsume 查表）。 */
  yieldsKind: string;
  /** 直接施加 consume 效果而不入背包（如直接饮用）。 */
  directConsume: boolean;
  /** 枯竭时刻的逻辑时间戳（world.time.tick × fixedDtMs），null 表示未枯竭。 */
  depletedSinceMs: number | null;
  /**
   * 采集工具门槛：采集者 tool 装备槽中的物品须声明同名字符串的 toolType。
   * 缺省/空串 = 无门槛（历史行为，徒手可采）。字符串由 game/ 配置定义，框架不解释。
   */
  requiredToolType?: string;
  /**
   * 多产物掉落表（复用 LootTable 语义）：配置后取代 yieldsKind 单产物路径，
   * 每次采集按条目顺序逐条掷骰（确定性 rng：tick + 采集者 eid + 节点 eid + "harvest"）。
   * 空/缺省 = 回退单产物 yieldsKind。
   */
  lootTable?: LootEntry[];
}

/** AoS 存储：普通 JS 数组按 eid 索引（非 bitecs 组件，不能 addComponent/query）。 */
export const ResourceNode = [] as (ResourceNodeState | undefined)[];

interface ResourceNodeConfig {
  remaining?: number;
  max?: number;
  amountPerHit?: number;
  regenMs?: number;
  yieldsKind?: string;
  directConsume?: boolean;
  requiredToolType?: string;
  lootTable?: LootEntry[];
}

/** AoS 初始化钩子。 */
export function initResourceNode(
  _world: unknown,
  eid: number,
  config: unknown,
): void {
  const cfg = (config ?? {}) as ResourceNodeConfig;
  const max = typeof cfg.max === "number" && cfg.max > 0 ? cfg.max : (cfg.remaining ?? 1);
  ResourceNode[eid] = {
    remaining: typeof cfg.remaining === "number" ? cfg.remaining : max,
    max,
    amountPerHit: typeof cfg.amountPerHit === "number" && cfg.amountPerHit > 0 ? cfg.amountPerHit : 1,
    regenMs: typeof cfg.regenMs === "number" ? cfg.regenMs : 0,
    yieldsKind: String(cfg.yieldsKind ?? ""),
    directConsume: Boolean(cfg.directConsume),
    depletedSinceMs: null,
    requiredToolType: typeof cfg.requiredToolType === "string" && cfg.requiredToolType !== "" ? cfg.requiredToolType : undefined,
    lootTable: Array.isArray(cfg.lootTable)
      ? cfg.lootTable.map((e) => ({
          kind: String(e?.kind ?? ""),
          qty: Number(e?.qty ?? 1),
          chance: Number(e?.chance ?? 1),
        }))
      : undefined,
  };
}
