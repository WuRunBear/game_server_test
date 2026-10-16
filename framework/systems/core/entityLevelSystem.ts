/**
 * 实体层号系统（framework/systems/core/entityLevelSystem.ts）。
 *
 * 消费 EntityLevel 载体（切片 4 交付）：按实体位置与所在图地形，推导实体
 * 应处的离散层号并写回 EntityLevel（v2 地图切片 5，前置修正 1 的转移纯
 * 函数 + 滞回）。
 *
 * **判定算法**（resolveEntityLevel，(位置, 地图数据, 当前层) 的纯函数——
 * 同输入序列恒同输出，离线补差可复现）：
 * 0. 首次确立：实体无 EntityLevel 条目时无条件取地形层号（candidateLevelAt，
 *    纯位置函数）——出生/刷怪/读档缺条目的落地语义，「实体所在格决定其
 *    level」；确立之后的变化才走过渡校验；
 * 1. 候选层 = 有效格的地形层号。有效格经**格中心越过**判定（见
 *    effectiveTileIndex）：实体进入相邻格的前半格时层号仍属来格，越过目标
 *    格中心才切换——提交点从格边界移到格中心，边界两侧各半格为不翻转区，
 *    在格边界附近反复抖动不产生层号振荡（连接器振荡是已知坑）。无状态
 *    （纯位置函数）是该滞回的形态：双阈值有状态滞回会破坏 (位置, 地图数据)
 *    纯函数约束，故振荡防线取「中心提交」而非「记忆死区」。
 *    v2 切片 6 扩展（实体侧连接器）：有效格上有**连接器实体**（Structure
 *    role=connector，楼梯把「连接器格」扩展到实体侧）时候选层按其方向
 *    重定向——上行连接器把 low 层实体的候选抬到 high，下行连接器把 high
 *    层实体的候选压到 low；两端之外的实体候选不变（仍取地形层）。
 * 2. 过渡校验（候选 ≠ 当前才判定）：
 *    - |Δ| = 1：必须经 slope 语义格（目标格 tiles = slope 语义 id）**或**
 *      实体侧连接器（有效格上的连接器覆盖当前层与候选层的过渡）——
 *      坡道带/连接器格两侧层号连续变化，不瞬移坐标；
 *    - Δ ≤ -2（自上而下跨崖边界）：允许（跳下，前置修正 8 的有向语义）；
 *    - 其余（低→高跨崖、无坡道的 ±1）：拒绝，保持当前层号（碰撞层已把
 *      向上路径物理封死，此处是纯函数侧的一致性防线）。
 * 3. 写回：确立（无条目 → 地形层号，含 0）与校验通过的过渡都直接写
 *    EntityLevel[eid]；条目存在即「已确立」，0 是普通取值（"无条目回退 0"
 *   仅覆盖从未被本系统处理过的实体）。
 *
 * **跳过名单**：投射物（生成时锁层）；挂 Structure（role ≠ 0）的建造实体
 * ——楼板悬空于地形层之上、墙/连接器的层号在放置/生成时显式写入，地形
 * 推导必错（且 delta ≤ -2 的跳下规则会击穿固定层号），故其 EntityLevel 为
 * 权威值、永不推导。
 *
 * 消费方约定：本系统排在 movement 之后、collision 之前——碰撞按实体层号
 * 分区路由（每层一个碰撞世界）；投射物不参与（Projectile 实体在生成时锁
 * 层，见 projectileSystem.spawnProjectile）。新刷实体存在一 tick 的层号
 * 滞后（本 tick 末按位置推导，下一 tick 起参与按层碰撞），推导是纯函数，
 * 语义与逐格判定一致。
 */
import { hasComponent, query } from "bitecs";

import { EntityLevel } from "framework/components/entityLevel";
import { entityMapOf } from "framework/components/entityMap";
import { Projectile } from "framework/components/projectile";
import {
  Structure,
  STRUCTURE_ROLE_NONE,
  STRUCTURE_ROLE_CONNECTOR,
  CONNECTOR_DIR_UP,
} from "framework/components/structure";
import { collectConnectorLookup, type StructureConnector } from "framework/map/runtime/builtStructures";
import { Transform } from "components";
import type { MapGeometry } from "map/geometry/types";
import type { GameWorld } from "world";

/**
 * 「格中心越过」判定下的有效格索引（滞回查找）。
 *
 * 有效格 k 的位置区间是 [(k + 0.5)·size, (k + 1.5)·size)——即「最近一次越
 * 过的格中心」所在格：正向移动越过格 k+1 的中心才切到 k+1，反向移动越过
 * 格 k-1 的中心才切回 k-1。无状态（纯位置函数），滞回由区间错位天然构成。
 *
 * 地图边缘半格内（shifted 越界）退回常规包含格并钳到图内，保证边缘实体的
 * 有效格恒有定义。
 *
 * @param coord 像素坐标（单轴）
 * @param tileSize 单格边长（像素，> 0）
 * @param tileCount 该轴格数
 * @returns 有效格索引 ∈ [0, tileCount)
 */
export function effectiveTileIndex(coord: number, tileSize: number, tileCount: number): number {
  const shifted = Math.floor(coord / tileSize - 0.5);
  if (shifted >= 0 && shifted < tileCount) return shifted;
  const plain = Math.min(Math.max(Math.floor(coord / tileSize), 0), tileCount - 1);
  return plain;
}

/**
 * 解析 (x, y) 处的地形层号候选与有效格索引（(位置, 地图数据) 的纯函数）。
 *
 * 候选 = 有效格（格中心越过判定，见 effectiveTileIndex）的地形层号。
 *
 * @param geometry 地图几何数据
 * @param x 实体像素 x
 * @param y 实体像素 y
 * @returns 候选层号与有效格展平索引（slope 语义判定用）
 */
export function candidateLevelAt(
  geometry: MapGeometry,
  x: number,
  y: number,
): { level: number; index: number } {
  const { width, height, tileWidth, tileHeight } = geometry.grid;
  const tileX = effectiveTileIndex(x, tileWidth, width);
  const tileY = effectiveTileIndex(y, tileHeight, height);
  const index = tileY * width + tileX;
  return { level: geometry.level[index] ?? 0, index };
}

/**
 * 连接器方向重定向后的候选层（实体侧连接器语义，纯函数）。
 *
 * 有效格上有连接器实体时：上行连接器把 low 层实体的候选抬到 high；
 * 下行连接器把 high 层实体的候选压到 low。两端之外的实体（层号不在连接器
 * 服务范围内）候选不变（返回 undefined，继续用地形层）。
 *
 * 注意方向性是有意设计：单个连接器格只服务一个方向——双向楼梯 = 上行 +
 * 下行两个连接器实体（分置于梯格与上层梯口）。若单格双向重定向，站在
 * 连接器格上的实体每 tick 会在两端之间振荡（候选函数无记忆，无法区分
 * 「刚上来」与「要下去」），有向语义是滞回成立的前提。
 *
 * @param connector 有效格上的连接器声明（无则 undefined）
 * @param currentLevel 实体当前层号
 * @returns 重定向后的候选层；无需重定向返回 undefined
 */
export function connectorCandidate(
  connector: StructureConnector | undefined,
  currentLevel: number,
): number | undefined {
  if (!connector) return undefined;
  if (connector.dir === CONNECTOR_DIR_UP && currentLevel === connector.low) {
    return connector.high;
  }
  if (connector.dir !== CONNECTOR_DIR_UP && currentLevel === connector.high) {
    return connector.low;
  }
  return undefined;
}

/**
 * 解析实体在 (x, y) 处应有的层号（(位置, 地图数据, 当前层, 连接器查找) 的纯函数）。
 *
 * 判定算法见模块注释。拒绝过渡时返回当前层号（不抛错——层号稳定性优先，
 * 非法几何由生成期校验把守，运行期只保证不振荡）。
 *
 * @param geometry 地图几何数据
 * @param x 实体像素 x
 * @param y 实体像素 y
 * @param currentLevel 实体当前层号（EntityLevel 已建立条目）
 * @param connectorAt 有效格索引 → 连接器声明（实体侧连接器；缺省无连接器）
 * @returns 校验后的层号
 */
export function resolveEntityLevel(
  geometry: MapGeometry,
  x: number,
  y: number,
  currentLevel: number,
  connectorAt?: (index: number) => StructureConnector | undefined,
): number {
  const { level: terrainCandidate, index } = candidateLevelAt(geometry, x, y);
  // 实体侧连接器：候选层按连接器方向重定向（上行 low→high / 下行 high→low）。
  // 重定向发生即过渡合法性——连接器只在自身方向上、对服务范围内的层号给出
  // 另一端候选（下行连接器的目标层可能恰等于地形层，仍须经连接器达成）。
  const redirected = connectorCandidate(connectorAt?.(index), currentLevel);
  const candidate = redirected ?? terrainCandidate;
  const viaConnector = redirected !== undefined;
  if (candidate === currentLevel) return currentLevel;

  const delta = candidate - currentLevel;
  if (Math.abs(delta) === 1) {
    // ±1 层过渡必须经 slope 语义格（目标格为坡道格；量化积木把边界带两侧
    // 同标为 slope，目标格判定即覆盖全部合法过渡）或实体侧连接器
    const semantics = geometry.levelSemantics;
    if (semantics !== undefined && geometry.tiles[index] === semantics.slope) {
      return candidate;
    }
    if (viaConnector) return candidate;
    return currentLevel;
  }
  // cliff 单向：自上而下跨崖边界允许（跳下）；向上跨层一律拒绝
  if (delta <= -2) return candidate;
  return currentLevel;
}

/**
 * 实体层号系统：按位置推导并写回 EntityLevel。
 *
 * - 只处理挂 Transform 的实体（有位置才有层号）；投射物跳过（生成时锁层）；
 *   挂 Structure（role ≠ 0）的建造实体跳过（层号放置/生成时显式写入，权威）；
 * - 实体无归属图（空串哨兵）或图未构建时跳过（空串是无图配置世界的缺省
 *   归属；未知 mapId 由碰撞侧显式抛错，本系统不重复报错）；
 * - flat 图（level 全 0）候选恒为 0，与缺省层一致即零写入——现有图零开销
 *   零回归；
 * - 连接器查找表每 tick 构建一次（Structure 实体全扫，建造实体量小）。
 *
 * @param world ECS World
 * @returns 处理后的 World
 */
export function entityLevelSystem(world: GameWorld): GameWorld {
  const connectorLookup = collectConnectorLookup(world);

  for (const eid of query(world, [Transform])) {
    // 投射物锁单层（前置修正 5）：层号在生成时随主人定格，飞行中不随地形变化
    if (hasComponent(world, eid, Projectile)) continue;
    // 建造实体（楼板/墙/连接器）：层号在放置/生成时显式写入（权威值），
    // 地形推导必错（楼板悬空于地形层之上），跳过推导
    if (hasComponent(world, eid, Structure) && (Structure.role[eid] ?? STRUCTURE_ROLE_NONE) !== STRUCTURE_ROLE_NONE) {
      continue;
    }
    const mapId = entityMapOf(world, eid);
    const geometry = world.maps[mapId];
    if (!geometry) continue;

    const byTile = connectorLookup.get(mapId);
    const connectorAt = byTile
      ? (index: number): StructureConnector | undefined => byTile.get(index)
      : undefined;

    const stored = EntityLevel[eid];
    if (stored === undefined) {
      // 首次确立：无条件取地形层号（出生/刷怪/读档缺条目的落地语义——
      // 「实体所在格决定其 level」，纯位置函数），**含 0 也落条目**——条目
      // 存在即「已确立」，此后变化一律走过渡校验（确立只发生一次；若 0 层
      // 不落条目，实体每回到无条目态都会被重新确立，跨层单向语义被击穿）。
      EntityLevel[eid] = candidateLevelAt(geometry, Transform.x[eid], Transform.y[eid]).level;
      continue;
    }

    const next = resolveEntityLevel(
      geometry,
      Transform.x[eid],
      Transform.y[eid],
      stored,
      connectorAt,
    );
    if (next !== stored) EntityLevel[eid] = next;
  }
  return world;
}
