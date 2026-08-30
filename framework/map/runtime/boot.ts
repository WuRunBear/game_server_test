/**
 * 开机地图编排（framework/map/runtime/boot.ts）。
 *
 * bootMaps 是「有没有存档」这一分支的**唯一**归属地（其余模块零开机分支）：
 * - 无档：逐图 buildMapGeometry → 出口校验 → 初始演化 evolve(0 → initialAgeTicks)，
 *   推进 world.time.tick 到最大初始年龄，组装首个 WorldRecord（maps 与实体
 *   同盘）交 deps.saveRecord（saveId 未定义时由 deps 侧 no-op）；
 * - 有档：逐图判定——快照含该 key 则反序列化回填（结构完整性校验，截断/
 *   缺字段抛错）；快照缺该 key（配置新增图）则走生成+校验+初始演化；
 *   快照中配置已删的 key 自然丢弃（只按 config 键加载）。
 *
 * 职责单一：bootMaps 只拥有 map 快照回填与开机分支；实体/tick/timeOfDay
 * 恢复归 restoreWorld（持久化切换 todo）。全部配置图加入 world.activeMaps
 * （常驻语义：空图也照常运行演化/碰撞）。收尾做全局引用校验（U5）：规则
 * map/region/kind 存在性、exact 落点在生成后几何上可走、Portal 配对坐标互指。
 *
 * deps 为读档**单一通道** { loadRecord, saveRecord }（同步闭包，boot 内禁止
 * 等待 Promise）；record 的预载由 GameSimulation 装配处完成。
 */
import { buildMapGeometry } from "map/generate/pipeline";
import { validateMapGeometry } from "map/generate/validate";
import { deserializeGeometry } from "map/geometry/snapshot";
import { walkableAt } from "map/geometry/query";
import type { MapGeometry } from "map/geometry/types";
import { evolve } from "map/evolution/engine";
import type { ExactRule, EntityRule } from "map/evolution/schema";
import { createMapEvolveDeps } from "map/runtime/evolveDeps";
import { advanceTickTo } from "map/runtime/clock";
import { serializeWorld } from "framework/persistence/worldSerializer";
import { createLogger } from "framework/utils/logger";
import type { GameWorld } from "framework/world";
import type { LoadedGameDefinition } from "framework/config/schema/GameDefinitionSchema";
import type { MapConfig } from "framework/config/schema/MapRegistrySchema";
import type { WorldRecord } from "framework/repository";

/** 开机读档通道（唯一）：预载的存档快照进、首存快照出。 */
export interface BootDeps {
  /** 取预载的世界快照；无档返回 null。 */
  loadRecord: () => WorldRecord | null;
  /** 写首个世界快照（无档路径初始演化完成后调用；无存档标识时实现为 no-op）。 */
  saveRecord: (record: WorldRecord) => void;
}

/** 无档时的缺省通道：不读档、不落盘。 */
export const noopBootDeps: BootDeps = {
  loadRecord: () => null,
  saveRecord: () => {},
};

const logger = createLogger("map-boot");

/** Portal 组件的配置形态（AoS 初始化数据，框架只读通用字段）。 */
interface PortalSpec {
  targetMap?: string;
  x?: number;
  y?: number;
}

/** 读原型的 Portal 组件配置；未声明返回 undefined。 */
function portalSpecOf(world: GameWorld, kind: string): PortalSpec | undefined {
  const components = world.archetypes.get(kind)?.components as Record<string, unknown> | undefined;
  const portal = components?.["Portal"];
  return portal && typeof portal === "object" ? (portal as PortalSpec) : undefined;
}

/** 像素落点 → 目标图 tile 坐标（floor 换算；tile 中心像素精确还原 tile）。 */
function landingTileOf(geometry: MapGeometry, portal: PortalSpec): { x: number; y: number } {
  return {
    x: Math.floor((portal.x ?? 0) / geometry.grid.tileWidth),
    y: Math.floor((portal.y ?? 0) / geometry.grid.tileHeight),
  };
}

/**
 * 全局引用校验（U5）：规则 map/region/kind 存在性、exact 落点在生成后几何上
 * 可走、Portal 配对坐标互指（exact 规则落点 ↔ 对端 Portal 落点双向一致）。
 * 任何一项失败即抛错（消息含规则 kind 与地图 key）——配置错误尽早暴露。
 */
function validateRuleReferences(world: GameWorld, configs: MapConfig[], rules: EntityRule[]): void {
  const mapKeys = new Set(configs.map((config) => config.key));

  for (const rule of rules) {
    if (!mapKeys.has(rule.map)) {
      throw new Error(`entity rule for "${rule.kind}" references unknown map "${rule.map}"`);
    }
    const geometry = world.maps[rule.map];
    if (!geometry) {
      throw new Error(`entity rule for "${rule.kind}": map "${rule.map}" was not built at boot`);
    }
    if (!geometry.regions.has(rule.region)) {
      throw new Error(
        `entity rule for "${rule.kind}" references unknown region "${rule.region}" on map "${rule.map}"`,
      );
    }
    if (!world.archetypes.has(rule.kind)) {
      throw new Error(`entity rule references unknown entity kind "${rule.kind}"`);
    }
    if (rule.mode === "exact" && !walkableAt(geometry, rule.at.x, rule.at.y)) {
      throw new Error(
        `exact rule for "${rule.kind}" on map "${rule.map}" lands on non-walkable tile (${rule.at.x}, ${rule.at.y})`,
      );
    }
  }

  const exactRules = rules.filter((rule): rule is ExactRule => rule.mode === "exact");
  for (const rule of exactRules) {
    const portal = portalSpecOf(world, rule.kind);
    if (!portal?.targetMap) continue;
    const target = world.maps[portal.targetMap];
    if (!target) {
      throw new Error(
        `exact rule for "${rule.kind}" on map "${rule.map}" targets unknown map "${portal.targetMap}"`,
      );
    }
    // 配对语义：落点指向对端传送门所在格的**邻近格**（Chebyshev ≤ 2）——
    // 精确落在对端格上会让玩家到达即站在回程门上触发回弹（ping-pong），
    // 邻近落点既保证「互指可达」又不触发当帧回传。
    const landing = landingTileOf(target, portal);
    const partner = exactRules.find((other) => {
      if (other.mode !== "exact" || other.map !== portal.targetMap) return false;
      if (chebyshev(other.at, landing) > 2) return false;
      return portalSpecOf(world, other.kind)?.targetMap === rule.map;
    });
    if (!partner) {
      throw new Error(
        `portal rule for "${rule.kind}" on map "${rule.map}" has no paired portal near tile (${landing.x}, ${landing.y}) on map "${portal.targetMap}"`,
      );
    }
    const backLanding = landingTileOf(world.maps[rule.map]!, portalSpecOf(world, partner.kind)!);
    if (chebyshev(backLanding, rule.at) > 2) {
      throw new Error(
        `portal pairing mismatch: "${rule.kind}" at tile (${rule.at.x}, ${rule.at.y}) on "${rule.map}" but partner "${partner.kind}" lands at (${backLanding.x}, ${backLanding.y})`,
      );
    }
  }
}

/** Chebyshev 距离（tile 对）。 */
function chebyshev(a: { x: number; y: number }, b: { x: number; y: number }): number {
  return Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y));
}

/**
 * 开机全量构建地图（唯一开机分支归属地）。
 *
 * @param world 目标世界（maps/activeMaps/defaultMapId 在此填充）
 * @param gameDef 已加载游戏定义（resolvedMapConfigs/resolvedEntityRules/规则）
 * @param deps 读档单一通道
 */
export function bootMaps(world: GameWorld, gameDef: LoadedGameDefinition, deps: BootDeps): void {
  const configs = gameDef.resolvedMapConfigs ?? [];
  const rules = gameDef.resolvedEntityRules ?? [];
  const registry = world.generators;
  const record = deps.loadRecord();
  const snapshotMaps = record?.maps;

  // 默认图：game.json 的 map.default（缺省首个配置键；无配置保持空串）
  world.defaultMapId = gameDef.map?.default ?? configs[0]?.key ?? "";

  // 生成器引用前置校验：配置声明即校验（含快照回填路径——回填图不执行管道，
  // 但配置合法性仍须成立；未注册积木的错误消息含图 key 与积木名）
  for (const config of configs) {
    for (const step of config.pipeline) {
      if (!registry.has(step.generator)) {
        throw new Error(
          `map "${config.key}" pipeline references unregistered generator "${step.generator}"`,
        );
      }
    }
  }

  let maxInitialAge = 0;
  for (const config of configs) {
    const snapshot = snapshotMaps?.[config.key];
    if (snapshot) {
      // 快照回填：反序列化后做结构完整性校验（截断/缺字段在此抛错）
      const geometry = deserializeGeometry(snapshot);
      validateMapGeometry(geometry);
      world.maps[config.key] = geometry;
    } else {
      // 无快照（无档，或配置新增图）：生成 → 出口校验（buildMapGeometry 内置）→ 初始演化
      const geometry = buildMapGeometry(config, registry);
      world.maps[config.key] = geometry;
      evolve(world, geometry, rules, 0, config.initialAgeTicks, createMapEvolveDeps(world, geometry, config.seed));
      if (config.initialAgeTicks > maxInitialAge) maxInitialAge = config.initialAgeTicks;
      logger.info("map generated and initially evolved", {
        map: config.key,
        seed: config.seed,
        initialAgeTicks: config.initialAgeTicks,
      });
    }
    // 常驻语义：全部配置图开机即激活（空图也照常运行演化/碰撞）
    world.activeMaps.add(config.key);
  }

  if (!record) {
    // 无档路径：tick 推进到最大初始年龄（首个运行 tick 恰好衔接 initialAge→initialAge+1），
    // 组装首个 WorldRecord（maps 与演化出的实体同盘）并交存档通道
    advanceTickTo(world, maxInitialAge);
    const serverRules = gameDef.resolvedRules["server"] as { saveId?: string } | undefined;
    deps.saveRecord(serializeWorld(world, serverRules?.saveId ?? ""));
  }

  validateRuleReferences(world, configs, rules);
}
