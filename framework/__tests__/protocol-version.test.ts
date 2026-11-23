/**
 * 协议版本握手测试（CC-08）。
 *
 * 覆盖 `GameRoom.onJoin` 依赖的四条路径：缺省兼容、非整数拒绝、
 * 匹配放行、不匹配拒绝；并断言 `SCHEMA_VERSION` 与安装的
 * `@colyseus/schema` 版本一致，防止文档/常量再次漂移。
 */
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  PROTOCOL_VERSION,
  SCHEMA_VERSION,
  checkProtocolCompatibility,
} from "network/protocol";
import { GameRoom } from "network/colyseus/rooms/GameRoom";

const INSTALLED_SCHEMA_PACKAGE = new URL(
  "../../node_modules/@colyseus/schema/package.json",
  import.meta.url,
);

describe("协议版本握手（checkProtocolCompatibility）", () => {
  it("缺省 protocolVersion → 兼容旧客户端（ok:true，无错误码）", () => {
    for (const options of [undefined, null, {}, { networkId: 7 }]) {
      const result = checkProtocolCompatibility(options);
      expect(result.ok, `options=${JSON.stringify(options)}`).toBe(true);
      expect(result.code).toBeUndefined();
    }
  });

  it("非整数 protocolVersion → protocol-version-invalid", () => {
    for (const invalid of ["1", 1.5, Number.NaN, Number.POSITIVE_INFINITY, true, {}, null]) {
      const result = checkProtocolCompatibility({ protocolVersion: invalid });
      expect(result.ok, `protocolVersion=${String(invalid)}`).toBe(false);
      expect(result.code).toBe("protocol-version-invalid");
    }
  });

  it("与服务端一致 → 放行并回填 clientVersion", () => {
    const result = checkProtocolCompatibility({ protocolVersion: PROTOCOL_VERSION });
    expect(result).toEqual({ ok: true, clientVersion: PROTOCOL_VERSION });
  });

  it("与服务端不一致 → protocol-version-mismatch（消息含 client/server）", () => {
    const result = checkProtocolCompatibility({ protocolVersion: PROTOCOL_VERSION + 1 });
    expect(result.ok).toBe(false);
    expect(result.code).toBe("protocol-version-mismatch");
    expect(result.clientVersion).toBe(PROTOCOL_VERSION + 1);
    expect(result.message).toBe(
      `protocol-version-mismatch client=${PROTOCOL_VERSION + 1} server=${PROTOCOL_VERSION}`,
    );
  });

  it("SCHEMA_VERSION 与安装的 @colyseus/schema 版本一致", () => {
    const pkg = JSON.parse(readFileSync(INSTALLED_SCHEMA_PACKAGE, "utf8")) as {
      version?: string;
    };
    expect(pkg.version).toBe(SCHEMA_VERSION);
  });

  it("PROTOCOL_VERSION 是正整数（join options 只接受整数）", () => {
    expect(Number.isInteger(PROTOCOL_VERSION)).toBe(true);
    expect(PROTOCOL_VERSION).toBeGreaterThan(0);
  });

  it("GameRoom.onJoin 对不匹配版本抛出可识别的拒绝消息（Colyseus 据此拒绝加入）", () => {
    // 只验证握手闸门：版本检查在任何 sim/state 访问之前抛出，
    // 故 Object.create 绕过 Room 构造即可（不触达仿真层）。
    const room = Object.create(GameRoom.prototype) as GameRoom;
    const client = { sessionId: "protocol-test-session" } as never;
    expect(() =>
      room.onJoin(client, { protocolVersion: PROTOCOL_VERSION + 1 }),
    ).toThrow(
      `protocol-version-mismatch client=${PROTOCOL_VERSION + 1} server=${PROTOCOL_VERSION}`,
    );
  });
});
