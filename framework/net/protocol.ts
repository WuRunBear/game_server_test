/**
 * 线上协议版本常量与 join 握手校验（游戏无关）。
 *
 * Colyseus schema 的**字段顺序即线协议**：服务端追加/删除/改序字段后，
 * 旧客户端仍能连上，却会静默解码错位。本模块提供一个可协商的
 * `protocolVersion`，由客户端在 join options 里携带：
 *
 * - 未提供：按旧客户端兼容放行（调用方记一次 warn，见 `GameRoom.onJoin`）；
 * - 非整数：拒绝（`protocol-version-invalid`）；
 * - 与 `PROTOCOL_VERSION` 不等：拒绝（`protocol-version-mismatch`）。
 *
 * 破坏性 schema 变更（删字段/改类型/改顺序）必须递增 `PROTOCOL_VERSION`；
 * 只追加字段也建议递增，客户端可据此提示升级。`SCHEMA_VERSION` 记录生成
 * 客户端 schema 时的 `@colyseus/schema` 版本，仅作诊断信息（字段结构以
 * codegen 产物为准，见 `tools/schemaCheck.ts`）。
 */

/** 当前线上协议版本。破坏性 schema 变更时递增。 */
export const PROTOCOL_VERSION = 1;

/**
 * 当前 `@colyseus/schema` 基线版本（诊断/文档用途）。
 *
 * 必须与实际安装版本一致——`protocol-version.test.ts` 会读取
 * `node_modules/@colyseus/schema/package.json` 断言，避免版本再次漂移。
 */
export const SCHEMA_VERSION = "5.0.43";

/** 握手失败原因码（客户端可据此区分「版本旧」与「参数畸形」）。 */
export type ProtocolCompatibilityCode =
  | "protocol-version-invalid"
  | "protocol-version-mismatch";

/** `checkProtocolCompatibility` 的判定结果。 */
export interface ProtocolCompatibility {
  /** 是否允许加入。缺省 `protocolVersion` 视为兼容，返回 true。 */
  ok: boolean;
  /** 失败原因（仅 `ok:false` 时出现）。 */
  code?: ProtocolCompatibilityCode;
  /** 客户端上报的协议版本（`ok:true` 的匹配路径也会回填）。 */
  clientVersion?: number;
  /** 可直接作为 join 拒绝错误消息的文本。 */
  message?: string;
}

/**
 * 校验客户端 join options 中的 `protocolVersion`。
 *
 * 纯函数：不读全局状态、不抛异常，调用方决定 warn/拒绝策略。
 *
 * @param options Colyseus `onJoin` 收到的 options（任意 JSON 对象）
 */
export function checkProtocolCompatibility(options: unknown): ProtocolCompatibility {
  const raw =
    options !== null && typeof options === "object"
      ? (options as Record<string, unknown>).protocolVersion
      : undefined;

  // 缺省（未提供）→ 旧客户端兼容
  if (raw === undefined) return { ok: true };

  // 显式提供但不是整数（字符串/小数/NaN/Infinity/null 等）→ 参数非法
  if (typeof raw !== "number" || !Number.isInteger(raw)) {
    return {
      ok: false,
      code: "protocol-version-invalid",
      message: `protocol-version-invalid client=${String(raw)} server=${PROTOCOL_VERSION}`,
    };
  }

  // 整数但与服务端不同 → 版本不匹配
  if (raw !== PROTOCOL_VERSION) {
    return {
      ok: false,
      code: "protocol-version-mismatch",
      clientVersion: raw,
      message: `protocol-version-mismatch client=${raw} server=${PROTOCOL_VERSION}`,
    };
  }

  return { ok: true, clientVersion: raw };
}
