/**
 * Passage 组件：可开合通行的建造屏障状态（SoA，**入档**——通行口开合跨重启保持）。
 *
 * 语义：实体同时是建造结构（Structure role=wall）与可开合屏障时挂载本组件。
 * - `open = 0`（缺省）：屏障生效——Collider 参与碰撞、Structure 进入寻路/视线
 *   阻挡索引、袭击可把其选为结构目标；
 * - `open = 1`：屏障放行——碰撞系统跳过其实体体、builtStructures 不投影其墙位、
 *   投射物穿过且不与之接触、袭击不再选其为目标。
 *
 * 开合入口：玩家 `interact` 意图选中范围内的 Passage 实体时切换（
 * interactionSystem），状态记在实体上并随世界快照入档；客户端经 netSync
 * 的 `Passage.open` 字段读取渲染。
 *
 * 组件名与字段保持框架通用机制词（passage/open），具体玩法名词
 * 只出现在 game/ 配置。
 */
import { defineComponent, Types } from "bitecs/legacy";
import { hasComponent } from "bitecs";
import type { GameWorld } from "framework/world";

export const Passage = defineComponent({
  /** 开合状态：0=关闭（屏障生效） 1=打开（放行）。 */
  open: Types.ui8,
});

/** 关闭状态（屏障生效）。 */
export const PASSAGE_CLOSED = 0;
/** 打开状态（放行）。 */
export const PASSAGE_OPEN = 1;

/**
 * 实体是否为「打开的通行口」。
 *
 * hasComponent 守卫是必需的：SoA 数组按 eid 复用，未挂载实体的槽位可能残留
 * 旧值；只有真正挂载 Passage 且 open=1 才算放行。
 */
export function isPassageOpen(world: GameWorld, eid: number): boolean {
  return hasComponent(world, eid, Passage) && Passage.open[eid] === PASSAGE_OPEN;
}

/** 切换开合状态（只在实体真正挂载 Passage 时生效）；返回切换后是否处于打开。 */
export function togglePassage(world: GameWorld, eid: number): boolean {
  if (!hasComponent(world, eid, Passage)) return false;
  Passage.open[eid] = Passage.open[eid] === PASSAGE_OPEN ? PASSAGE_CLOSED : PASSAGE_OPEN;
  return Passage.open[eid] === PASSAGE_OPEN;
}
