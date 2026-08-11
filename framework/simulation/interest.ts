/**
 * 兴趣集合计算——按视野半径裁剪每个玩家的可见实体。
 *
 * 纯数据函数：读 ECS 玩家位置 + 快照实体位置，输出 sessionId → 可见 networkId 列表。
 * - 玩家自身恒可见（客户端必须始终能追踪自己的控制实体）
 * - 无 Transform 数据的实体不可见（现实中不存在，防御分支）
 *
 * 传输层（GameRoom）拿到 interest 后做 per-client 裁剪同步；
 * 未配置视野半径时仿真层不产出 interest，传输层回退全量广播。
 */
import { NetworkId } from "framework/components/network";
import { Transform } from "framework/components/transform";
import type { GameWorld } from "framework/world";
import type { EntityId } from "framework/world";
import type { TickSnapshot } from "./types";

/**
 * 计算兴趣集合。
 *
 * @param world ECS world（读玩家 Transform）
 * @param playerEidBySessionId sessionId → 玩家 eid
 * @param snapshot 本帧全量快照
 * @param viewRadius 视野半径（像素）
 */
export function computeInterest(
  world: GameWorld,
  playerEidBySessionId: ReadonlyMap<string, EntityId>,
  snapshot: TickSnapshot,
  viewRadius: number,
): Map<string, number[]> {
  const result = new Map<string, number[]>();
  // 用距离平方比较（避免开方），radiusSq = viewRadius²
  const radiusSq = viewRadius * viewRadius;

  for (const [sessionId, eid] of playerEidBySessionId) {
    // 以玩家的 ECS Transform 位置为视野中心
    const px = Transform.x[eid];
    const py = Transform.y[eid];
    const ownNetworkId = NetworkId.value[eid];
    const visible: number[] = [];

    for (const [networkId, snap] of snapshot.entities) {
      // 玩家自身恒可见（客户端必须始终能追踪自己的控制实体）
      if (networkId === ownNetworkId) {
        visible.push(networkId);
        continue;
      }
      // 其他实体位置取自快照的 Transform.x/y（与客户端收到的一致，且避免再读 ECS）
      const ex = snap.values["Transform.x"];
      const ey = snap.values["Transform.y"];
      // 无位置数据的实体不可见（现实中不存在，防御分支）
      if (ex === undefined || ey === undefined) continue;
      const dx = ex - px;
      const dy = ey - py;
      // 在视野半径内才可见，否则裁掉
      if (dx * dx + dy * dy <= radiusSq) {
        visible.push(networkId);
      }
    }

    result.set(sessionId, visible);
  }

  return result;
}
