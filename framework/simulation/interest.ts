/**
 * 兴趣集合计算——按玩家所属地图 + 视野半径裁剪每个玩家的可见实体。
 *
 * 纯数据函数：读 ECS 玩家位置 + 快照实体位置，输出 sessionId → 可见 networkId 列表。
 * - 玩家自身恒可见（客户端必须始终能追踪自己的控制实体）
 * - 其他实体仅在「快照 mapId === 玩家图」时才可能可见（分图分区语义）
 * - 无 Transform 数据的实体不可见（现实中不存在，防御分支）
 *
 * 传输层（GameRoom）拿到 interest 后做 per-client 裁剪同步；
 * 未配置视野半径时按同图全量返回（半径裁剪关闭，兼容旧协议的全量广播语义）。
 */
import { NetworkId } from "framework/components/network";
import { Transform } from "framework/components/transform";
import { entityMapOf } from "framework/components/entityMap";
import type { GameWorld } from "framework/world";
import type { EntityId } from "framework/world";
import type { TickSnapshot } from "./types";

/**
 * 计算兴趣集合。
 *
 * @param world ECS world（读玩家 Transform / EntityMap）
 * @param playerEidBySessionId sessionId → 玩家 eid
 * @param snapshot 本帧全量快照
 * @param viewRadius 视野半径（像素）；缺省时同图全量可见（不裁剪距离）
 */
export function computeInterest(
  world: GameWorld,
  playerEidBySessionId: ReadonlyMap<string, EntityId>,
  snapshot: TickSnapshot,
  viewRadius?: number,
): Map<string, number[]> {
  const result = new Map<string, number[]>();
  // 有半径时用距离平方比较（避免开方），radiusSq = viewRadius²
  const radiusSq = viewRadius === undefined ? undefined : viewRadius * viewRadius;

  for (const [sessionId, eid] of playerEidBySessionId) {
    // 以玩家的 ECS Transform 位置为视野中心
    const px = Transform.x[eid];
    const py = Transform.y[eid];
    // 玩家所属图：本玩家以 ECS 实体归属为准（authoritative）
    const myMap = entityMapOf(world, eid);
    const ownNetworkId = NetworkId.value[eid];
    const visible: number[] = [];

    for (const [networkId, snap] of snapshot.entities) {
      // 玩家自身恒可见（客户端必须始终能追踪自己的控制实体）
      if (networkId === ownNetworkId) {
        visible.push(networkId);
        continue;
      }
      // 同图过滤：快照 mapId 即同步给客户端的真相——只按玩家所在图收窄范围
      if (snap.mapId !== myMap) continue;
      // 其他实体位置取自快照的 Transform.x/y（与客户端收到的一致，且避免再读 ECS）
      const ex = snap.values["Transform.x"];
      const ey = snap.values["Transform.y"];
      // 无位置数据的实体不可见（现实中不存在，防御分支）
      if (ex === undefined || ey === undefined) continue;
      // 未配视野半径 → 同图全量可见（不做距离检查）
      if (radiusSq === undefined) {
        visible.push(networkId);
        continue;
      }
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
