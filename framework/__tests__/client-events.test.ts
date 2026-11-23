/**
 * CC-04 客户端事件 outbox 纯函数测试。
 *
 * 覆盖：self / nearby / map / world 四类受众、跨图、半径边界（含边界=可见）、
 * seq 顺序保持。所有用例只构造 PendingClientEvent，不经 ECS。
 */
import { describe, expect, it } from "vitest";
import {
  collectEventsForClient,
  DEFAULT_CLIENT_EVENT_VIEW_RADIUS,
  type PendingClientEvent,
} from "framework/simulation/clientEvents";

function event(
  seq: number,
  audience: PendingClientEvent["audience"],
  options: Partial<PendingClientEvent> = {},
): PendingClientEvent {
  return {
    seq,
    tick: 10 + seq,
    type: `t${seq}`,
    data: { n: seq },
    audience,
    ...options,
  };
}

const viewer = { eid: 7, mapId: "island", x: 100, y: 100 };

describe("collectEventsForClient", () => {
  it("self：只发给 targetEid 匹配的当事人", () => {
    const events = [
      event(1, "self", { targetEid: 7 }),
      event(2, "self", { targetEid: 8 }),
      event(3, "self"),
    ];
    const out = collectEventsForClient(events, viewer);
    expect(out.map((e) => e.seq)).toEqual([1]);
  });

  it("map：同图可见、跨图不可见；无地图锚点时不误广播", () => {
    const events = [
      event(1, "map", { mapId: "island", x: 0, y: 0 }),
      event(2, "map", { mapId: "cave", x: 100, y: 100 }),
      event(3, "map"),
    ];
    const out = collectEventsForClient(events, viewer);
    expect(out.map((e) => e.seq)).toEqual([1]);
  });

  it("world：全房间可见（跨图也可见）", () => {
    const events = [event(1, "world"), event(2, "world", { mapId: "cave" })];
    const out = collectEventsForClient(events, viewer);
    expect(out.map((e) => e.seq)).toEqual([1, 2]);
  });

  it("nearby：同图半径内可见、边界值包含、半径外与跨图不可见", () => {
    const radius = DEFAULT_CLIENT_EVENT_VIEW_RADIUS;
    const events = [
      event(1, "nearby", { mapId: "island", x: 100, y: 100 }), // 0
      event(2, "nearby", { mapId: "island", x: 100 + radius, y: 100 }), // 恰在边界
      event(3, "nearby", { mapId: "island", x: 100 + radius + 0.01, y: 100 }), // 外
      event(4, "nearby", { mapId: "cave", x: 100, y: 100 }), // 跨图
      event(5, "nearby", { mapId: "island" }), // 无锚点 → 退化为同图
    ];
    const out = collectEventsForClient(events, viewer);
    expect(out.map((e) => e.seq)).toEqual([1, 2, 5]);
  });

  it("keep order and monotonic seq; data is shallow-copied", () => {
    const events = [
      event(5, "world"),
      event(9, "world"),
      event(12, "world"),
    ];
    const out = collectEventsForClient(events, viewer);
    expect(out.map((e) => e.seq)).toEqual([5, 9, 12]);
    // 输出只含出网字段，不含 audience / targetEid / 锚点。
    expect(Object.keys(out[0]!).sort()).toEqual(["data", "seq", "tick", "type"]);
    expect(out[0]!.data).not.toBe(events[0]!.data);
    expect(out[0]!.data).toEqual(events[0]!.data);
  });

  it("不同视角过滤同一批事件：各自 seq 子序列仍严格单调", () => {
    const events = [
      event(1, "world"),
      event(2, "self", { targetEid: 7 }),
      event(3, "map", { mapId: "cave" }),
      event(4, "nearby", { mapId: "island", x: 110, y: 100 }),
      event(5, "self", { targetEid: 8 }),
    ];
    const a = collectEventsForClient(events, viewer);
    const b = collectEventsForClient(events, { eid: 8, mapId: "cave", x: 0, y: 0 });
    expect(a.map((e) => e.seq)).toEqual([1, 2, 4]);
    expect(b.map((e) => e.seq)).toEqual([1, 3, 5]);
    for (const list of [a, b]) {
      for (let i = 1; i < list.length; i++) {
        expect(list[i]!.seq).toBeGreaterThan(list[i - 1]!.seq);
      }
    }
  });
});
