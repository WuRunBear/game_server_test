/**
 * 交易报价会话（offer）——异步协商的多方交易流程。
 *
 * 流程：openOffer（创建会话，无玩家方即时确认）→ 各玩家方经 offer-accept
 * 命令逐一确认 → 全部确认时调 settle 结算 → 成功置 settled / 失败作废。
 * 任一方 cancelOffer 或会话到期（expiresTick）即作废。
 *
 * 不做资产硬锁（先验后结）：创建/确认阶段不冻结资产，最终 settle 时刻
 * 统一校验；结算失败即整体作废会话。会话表挂在 world（offerSessions），
 * 为运行时状态不入档——重启即作废，与无锁语义一致。
 */
import { hasComponent } from "bitecs";
import type { GameWorld } from "framework/world";
import { Player } from "framework/components/tags";
import { settle, type SettleTerms } from "framework/economy/settle";

/** 报价会话状态：pending 协商中 / settled 已结算 / cancelled 已作废 / expired 已过期。 */
export type OfferStatus = "pending" | "settled" | "cancelled" | "expired";

/** 报价会话（world 级，运行时状态不入档）。 */
export interface OfferSession {
  /** 会话 id（world.nextOfferId 自增）。 */
  id: number;
  /** 交易条款（openOffer 时结构化克隆，防调用方后续改动）。 */
  terms: SettleTerms;
  /** 创建时的 tick。 */
  createdAtTick: number;
  /** 过期 tick（缺省永不过期；tick ≥ 该值即作废）。 */
  expiresTick?: number;
  /** 已确认方 eid 集合。 */
  confirmed: Set<number>;
  /** 会话状态。 */
  status: OfferStatus;
}

/** openOffer 选项。 */
export interface OpenOfferOptions {
  /** 已确认方（如发起 offer 命令的玩家本人）。 */
  confirmedParties?: number[];
  /** 过期 tick（缺省永不过期）。 */
  expiresTick?: number;
}

/** 判断实体是否玩家（有 Player 标签即需显式确认；无玩家确认通道的方即时成立）。 */
function isPlayerEntity(world: GameWorld, eid: number): boolean {
  return hasComponent(world, eid, Player);
}

/** 会话是否已全部确认。 */
function allConfirmed(session: OfferSession): boolean {
  return session.terms.every((party) => session.confirmed.has(party.party));
}

/** 清理过期会话（pending 且到达 expiresTick → 置 expired）。 */
export function pruneExpiredOffers(world: GameWorld): void {
  const tick = world.time.tick;
  for (const session of world.offerSessions.values()) {
    if (session.status === "pending" && session.expiresTick !== undefined && tick >= session.expiresTick) {
      session.status = "expired";
    }
  }
}

/**
 * 开启一笔报价会话。
 *
 * 无玩家确认通道的方（非 Player 实体）即时确认；confirmedParties 中的方
 * 视为已确认（如发起命令的玩家本人）。创建后若全部确认 → 立即结算：
 * 成功置 settled；失败作废（cancelled）并返回 null（先验后结，无锁可退）。
 *
 * @returns 会话 id；条款非法或即时结算失败时返回 null
 */
export function openOffer(
  world: GameWorld,
  terms: SettleTerms,
  opts?: OpenOfferOptions,
): number | null {
  pruneExpiredOffers(world);

  if (!Array.isArray(terms) || terms.length === 0) return null;

  const session: OfferSession = {
    id: world.nextOfferId++,
    terms: structuredClone(terms),
    createdAtTick: world.time.tick,
    expiresTick: opts?.expiresTick,
    confirmed: new Set<number>(),
    status: "pending",
  };

  for (const party of session.terms) {
    if (!isPlayerEntity(world, party.party) || opts?.confirmedParties?.includes(party.party)) {
      session.confirmed.add(party.party);
    }
  }

  world.offerSessions.set(session.id, session);

  // 全确认 → 即时结算；失败即作废（先验后结）
  if (allConfirmed(session)) {
    if (settle(world, session.terms)) {
      session.status = "settled";
    } else {
      session.status = "cancelled";
      return null;
    }
  }

  return session.id;
}

/**
 * 玩家方确认报价（offer-accept 命令路径）。
 *
 * 全部确认时触发最终结算：成功置 settled；失败作废并返回 false。
 *
 * @returns 确认是否生效（会话存在且 pending、eid 为参与方且未重复确认）
 */
export function acceptOffer(world: GameWorld, eid: number, offerId: number): boolean {
  pruneExpiredOffers(world);

  const session = world.offerSessions.get(offerId);
  if (!session || session.status !== "pending") return false;
  if (!session.terms.some((party) => party.party === eid)) return false;
  if (session.confirmed.has(eid)) return false;

  session.confirmed.add(eid);

  if (allConfirmed(session)) {
    if (settle(world, session.terms)) {
      session.status = "settled";
    } else {
      session.status = "cancelled";
      return false;
    }
  }
  return true;
}

/**
 * 参与方取消报价（offer-cancel 命令路径；仅 pending 会话可取消）。
 */
export function cancelOffer(world: GameWorld, eid: number, offerId: number): boolean {
  pruneExpiredOffers(world);

  const session = world.offerSessions.get(offerId);
  if (!session || session.status !== "pending") return false;
  if (!session.terms.some((party) => party.party === eid)) return false;

  session.status = "cancelled";
  return true;
}

/** 按会话 id 取报价会话（测试/上层查询用；不存在返回 undefined）。 */
export function getOffer(world: GameWorld, offerId: number): OfferSession | undefined {
  return world.offerSessions.get(offerId);
}
