/**
 * PlayerProfile 组件：玩家自报的展示资料（AoS，**随实体入档**）。
 *
 * 字段语义（全部为客户端展示用途，服务端玩法逻辑不读取）：
 * - `displayName`：展示名（去首尾空白；空串 = 客户端回退「玩家」/networkId）；
 * - `characterId`：角色/外观预设 id（不透明字符串，框架不解释）；
 * - `appearance`：不透明 JSON 字符串（客户端自行解析；框架原样保存/下发）。
 *
 * 信任边界：本组件只承载**客户端自报**的展示资料，服务端不校验真实性
 * （账号、角色创建、外观资源归属属于 CC-15 / 内容层职责）。因此这里只做
 * 防崩溃的结构规范化：非字符串一律拒绝为空串，超长同样回退空串，绝不抛错
 * （join 路径上的畸形参数不能把房间打崩）。
 *
 * 持久化：未列入 `worldSerializer` 的运行时黑名单，玩家实体断开保留、重连
 * 以及重启读档后资料仍在；读档恢复由 AoS 分支整体写回。
 *
 * 写入策略（由 GameSimulation.addPlayer 执行）：
 * - 新玩家：用 join options 规范化后的值覆盖写入（含空串占位）；
 * - 重连复用断线保留实体：**逐字段保留已有非空值**，只填充当前为空的字段
 *   （避免任何客户端凭 networkId 冒领改名/换外观）。
 */
import type { GameWorld } from "framework/world";

/** 展示名长度上限（字符，按 JS UTF-16 长度计）。 */
export const PLAYER_PROFILE_DISPLAY_NAME_MAX = 32;
/** 角色 id 长度上限。 */
export const PLAYER_PROFILE_CHARACTER_ID_MAX = 64;
/** 外观 JSON 字符串长度上限。 */
export const PLAYER_PROFILE_APPEARANCE_MAX = 2048;

/** PlayerProfile 的 AoS 数据形态。 */
export interface PlayerProfileState {
  /** 展示名；空串 = 未设置（客户端回退默认名）。 */
  displayName: string;
  /** 角色/外观预设 id；空串 = 未设置。 */
  characterId: string;
  /** 不透明 JSON 字符串；空串 = 未设置。 */
  appearance: string;
}

/** AoS 存储：普通 JS 数组按 eid 索引（非 bitecs 组件，不能 addComponent/query）。 */
export const PlayerProfile = [] as (PlayerProfileState | undefined)[];

/** 空资料（每次返回新对象，调用方可自由修改）。 */
export function emptyPlayerProfile(): PlayerProfileState {
  return { displayName: "", characterId: "", appearance: "" };
}

/**
 * 单字段规范化：非字符串/空白/超长 → 空串。
 *
 * `trim` 只对展示名/角色 id 开启；appearance 必须**原样保留**（JSON 字符串
 * 的空白也属于客户端数据，框架不解释、不重排）。
 */
function normalizeStringField(value: unknown, maxLength: number, trim: boolean): string {
  if (typeof value !== "string") return "";
  const normalized = trim ? value.trim() : value;
  if (normalized.length === 0) return "";
  if (normalized.length > maxLength) return "";
  return normalized;
}

/**
 * 把 join options / archetype 配置中的任意值规范化为合法 PlayerProfile。
 *
 * 接受对象形态 `{ displayName, characterId, appearance }`；缺失/非对象/字段
 * 类型错误一律按空串处理。函数无副作用、永不抛错。
 */
export function normalizePlayerProfile(input: unknown): PlayerProfileState {
  if (!input || typeof input !== "object") return emptyPlayerProfile();
  const raw = input as Record<string, unknown>;
  return {
    displayName: normalizeStringField(
      raw.displayName,
      PLAYER_PROFILE_DISPLAY_NAME_MAX,
      true,
    ),
    characterId: normalizeStringField(
      raw.characterId,
      PLAYER_PROFILE_CHARACTER_ID_MAX,
      true,
    ),
    appearance: normalizeStringField(
      raw.appearance,
      PLAYER_PROFILE_APPEARANCE_MAX,
      false,
    ),
  };
}

/**
 * 读实体资料（无条目/畸形条目的字段回退空串）。
 *
 * 返回新对象，调用方修改不会影响 AoS 存储。
 */
export function playerProfileOf(eid: number): PlayerProfileState {
  const stored = PlayerProfile[eid];
  if (!stored || typeof stored !== "object") return emptyPlayerProfile();
  const raw = stored as Partial<Record<keyof PlayerProfileState, unknown>>;
  // 读侧再规范化一次：旧档/手工篡改的存档可能绕过 addPlayer 的写入校验，
  // 这里保证下发到客户端的三字段仍满足类型/长度契约（不抛错）。
  return {
    displayName: normalizeStringField(
      raw.displayName,
      PLAYER_PROFILE_DISPLAY_NAME_MAX,
      true,
    ),
    characterId: normalizeStringField(
      raw.characterId,
      PLAYER_PROFILE_CHARACTER_ID_MAX,
      true,
    ),
    appearance: normalizeStringField(
      raw.appearance,
      PLAYER_PROFILE_APPEARANCE_MAX,
      false,
    ),
  };
}

/**
 * 覆写实体资料（join 新玩家 / 显式更新路径）。
 *
 * @returns 实际写入的规范化资料
 */
export function setPlayerProfile(eid: number, input: unknown): PlayerProfileState {
  const profile = normalizePlayerProfile(input);
  PlayerProfile[eid] = profile;
  return profile;
}

/**
 * 逐字段合并：已有**非空**值优先，仅用传入值填充当前为空的字段。
 *
 * 重连复用断线保留实体时使用——保留既有身份资料，拒绝冒领改名；旧档/旧实体
 * 的空字段仍可在重连时补全。
 *
 * @returns 合并后的资料
 */
export function fillEmptyPlayerProfile(eid: number, input: unknown): PlayerProfileState {
  const current = playerProfileOf(eid);
  const incoming = normalizePlayerProfile(input);
  const merged: PlayerProfileState = {
    displayName: current.displayName || incoming.displayName,
    characterId: current.characterId || incoming.characterId,
    appearance: current.appearance || incoming.appearance,
  };
  PlayerProfile[eid] = merged;
  return merged;
}

/**
 * AoS 初始化钩子：按 archetype 配置写入资料（当前 game 原型未声明本组件，
 * 玩家资料由 addPlayer 在生成后写入；保留此钩子供配置驱动形态使用）。
 */
export function initPlayerProfile(
  _world: GameWorld | unknown,
  eid: number,
  config: unknown,
): void {
  setPlayerProfile(eid, config);
}
