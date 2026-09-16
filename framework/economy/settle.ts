/**
 * 交易结算——多方原子条款执行（服务端权威，先验后结）。
 *
 * 条款（SettleTerms）为各方（party eid）的 give/take 列表：
 * - give：从该方容器扣出的数量（结算前须足额）；
 * - take：收入该方容器的数量（结算后须无剩余，即可容纳）。
 *
 * 原子性：先对全部涉及容器做快照 → 校验全部 give 足额 → 执行全部 give →
 * 执行全部 take（任一剩余即容量不足）→ 失败整体回滚全部快照，零副作用。
 * 支持任意方数；不做资产硬锁（校验与结算同 tick 内同步完成）。
 *
 * 游戏无关——kind/container 全为通用机制词，语义由 game/ 配置约定。
 */
import type { GameWorld, EntityId } from "framework/world";
import {
  queryContainer,
  insertContainer,
  removeContainer,
  snapshotContainer,
  restoreContainer,
  type ContainerRef,
  type ContainerKind,
  type ContainerSnapshot,
} from "framework/economy/container";

/** 单条转移数量：容器种类 + 物品种类 + 数量。 */
export interface TransferAmount {
  /** 容器种类（"inventory" 槽位背包 / "ledger" 计数账本）。 */
  container: ContainerKind;
  /** 物品种类字符串（game/items 配置的 kind）。 */
  kind: string;
  /** 数量（> 0）。 */
  count: number;
}

/** 单方条款：该方给出的与收取的。 */
export interface SettlePartyTerms {
  /** 参与方实体 eid。 */
  party: EntityId;
  /** 该方给出的数量列表（从其容器扣减）。 */
  give?: TransferAmount[];
  /** 该方收取的数量列表（插入其容器）。 */
  take?: TransferAmount[];
}

/** 完整结算条款：各方列表（任意方数）。 */
export type SettleTerms = SettlePartyTerms[];

/** 条款涉及的容器引用去重键。 */
function refKey(ref: ContainerRef): string {
  return `${ref.type}:${ref.eid}`;
}

/** 由条款条目构造容器引用。 */
function refOf(party: EntityId, amount: TransferAmount): ContainerRef {
  return { type: amount.container, eid: party };
}

/** 收集条款涉及的全部容器引用（去重）。 */
function collectRefs(terms: SettleTerms): ContainerRef[] {
  const refs = new Map<string, ContainerRef>();
  for (const party of terms) {
    for (const amount of [...(party.give ?? []), ...(party.take ?? [])]) {
      const ref = refOf(party.party, amount);
      refs.set(refKey(ref), ref);
    }
  }
  return [...refs.values()];
}

/**
 * 执行一笔多方结算。
 *
 * @param terms 各方条款（非空数组）
 * @returns 是否结算成功（任一校验失败即整体拒绝，零副作用）
 */
export function settle(world: GameWorld, terms: SettleTerms): boolean {
  if (!Array.isArray(terms) || terms.length === 0) return false;

  // 条目合法性预检：数量必须为正（防零/负数量绕过足额校验）
  for (const party of terms) {
    for (const amount of [...(party.give ?? []), ...(party.take ?? [])]) {
      if (!(amount.count > 0)) return false;
    }
  }

  // 快照全部涉及容器（整体回滚依据）
  const refs = collectRefs(terms);
  const snapshots = new Map<string, unknown>();
  for (const ref of refs) {
    snapshots.set(refKey(ref), snapshotContainer(ref));
  }

  // 校验：全部 give 足额（余额不足即整体拒绝）
  for (const party of terms) {
    for (const amount of party.give ?? []) {
      if (queryContainer(world, refOf(party.party, amount), amount.kind) < amount.count) {
        return false;
      }
    }
  }

  // 执行 give：跨方扣减（校验已过，必然成功；防御性回滚兜底）
  for (const party of terms) {
    for (const amount of party.give ?? []) {
      if (!removeContainer(world, refOf(party.party, amount), amount.kind, amount.count)) {
        rollback(refs, snapshots);
        return false;
      }
    }
  }

  // 执行 take：跨方插入；任一剩余（容量不足）→ 整体回滚
  for (const party of terms) {
    for (const amount of party.take ?? []) {
      const leftover = insertContainer(world, refOf(party.party, amount), amount.kind, amount.count);
      if (leftover > 0) {
        rollback(refs, snapshots);
        return false;
      }
    }
  }

  return true;
}

/** 整体回滚全部涉及容器的快照（零副作用保证）。 */
function rollback(refs: ContainerRef[], snapshots: Map<string, unknown>): void {
  for (const ref of refs) {
    restoreContainer(ref, snapshots.get(refKey(ref)) as ContainerSnapshot);
  }
}
