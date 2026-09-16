/**
 * 容器层与交易子系统测试。
 *
 * 覆盖：统一容器接口（query/insert/remove，inventory/ledger 双实现）、
 * 转移原语（transfer/swap 原子性与回滚）、多方结算 settle（足额/容量校验
 * 与整体回滚）、报价会话 offer（即时成立/玩家确认/取消/过期）、
 * offer 命令经 GameSimulation 的全链路。
 */
import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { query, addComponent, addEntity } from "bitecs";
import {
  bootstrapFramework,
  createGameInstance,
  createGameSimulation,
  createDefaultGameDefinition,
  queryContainer,
  insertContainer,
  removeContainer,
  transferContainer,
  swapContainers,
  settle,
  openOffer,
  acceptOffer,
  cancelOffer,
  getOffer,
  pruneExpiredOffers,
} from "framework/index";
import { NetworkId } from "framework/components/network";
import { Player, NPC } from "framework/components/tags";
import { Health } from "framework/components/combat";
import { Inventory, type InventoryEntry } from "framework/components/inventory";
import { Ledger } from "framework/components/ledger";
import { Transform } from "framework/components/transform";
import { EntityMap } from "framework/components/entityMap";
import { setEntityKind } from "framework/systems/gameplay/aiSystem";
import type { GameWorld } from "framework/world";
import type { ContainerRef } from "framework/economy/container";
import type { SettleTerms } from "framework/economy/settle";
import type { SimulationPort } from "framework/simulation/SimulationPort";

beforeAll(() => {
  bootstrapFramework();
});

/** 构造测试世界（默认配置，真实 GameInstance 路径）。 */
function createBareWorld(): GameWorld {
  return createGameInstance(createDefaultGameDefinition()).world;
}

/** 清空本文件涉及的 AoS 模块级单例（防跨用例 eid 复用串扰）。 */
function clearAos(): void {
  for (let i = 0; i < Inventory.length; i++) Inventory[i] = undefined;
  for (let i = 0; i < Ledger.length; i++) Ledger[i] = undefined;
}

beforeEach(() => {
  clearAos();
});

/** 构造指定槽位数的空背包。 */
function emptyInventory(capacity: number): InventoryEntry {
  return { capacity, slots: Array.from({ length: capacity }, () => null) };
}

/** 手工生成非玩家测试实体（带账本/背包，供交易条款引用）。 */
function spawnTestParty(world: GameWorld, opts: { player?: boolean } = {}): number {
  const eid = addEntity(world);
  addComponent(world, eid, Transform);
  addComponent(world, eid, NetworkId);
  addComponent(world, eid, Health);
  Health.current[eid] = 100;
  Health.max[eid] = 100;
  addComponent(world, eid, opts.player ? Player : NPC);
  NetworkId.value[eid] = world.nextNetworkId++;
  setEntityKind(world, eid, "test-party");
  // EntityMap 为模块级 AoS 单例：显式写归属，防 eid 复用残留串扰
  EntityMap[eid] = world.defaultMapId;
  return eid;
}

/** 背包容器引用。 */
function inv(eid: number): ContainerRef {
  return { type: "inventory", eid };
}

/** 账本容器引用。 */
function led(eid: number): ContainerRef {
  return { type: "ledger", eid };
}

// 容器原语：inventory / ledger 双实现的 query/insert/remove
describe("容器原语（container）", () => {
  it("inventory：insert 入槽 / query 统计 / remove 扣减（不足整体拒绝）", () => {
    const world = createBareWorld();
    const eid = spawnTestParty(world);
    Inventory[eid] = emptyInventory(4);

    // maxStack 缺省 1（无 itemKinds 配置）：5 个入 4 槽剩 1
    expect(insertContainer(world, inv(eid), "k1", 5)).toBe(1);
    expect(queryContainer(world, inv(eid), "k1")).toBe(4);

    expect(removeContainer(world, inv(eid), "k1", 3)).toBe(true);
    expect(queryContainer(world, inv(eid), "k1")).toBe(1);

    // 余额不足：整体拒绝、零副作用
    expect(removeContainer(world, inv(eid), "k1", 2)).toBe(false);
    expect(queryContainer(world, inv(eid), "k1")).toBe(1);
  });

  it("ledger：insert 自动建账 / 数量直加 / remove 余额校验（归零移除键）", () => {
    const world = createBareWorld();
    const eid = spawnTestParty(world);

    expect(queryContainer(world, led(eid), "c2")).toBe(0);
    expect(insertContainer(world, led(eid), "c2", 10)).toBe(0);
    expect(queryContainer(world, led(eid), "c2")).toBe(10);

    expect(removeContainer(world, led(eid), "c2", 4)).toBe(true);
    expect(queryContainer(world, led(eid), "c2")).toBe(6);

    expect(removeContainer(world, led(eid), "c2", 7)).toBe(false);
    expect(queryContainer(world, led(eid), "c2")).toBe(6);

    expect(removeContainer(world, led(eid), "c2", 6)).toBe(true);
    expect(Ledger[eid]).toEqual({});
  });
});

// 转移原语：先全量校验后执行，失败整体回滚
describe("转移原语（transfer/swap）", () => {
  it("槽↔槽：maxStack 合并转移", () => {
    const world = createBareWorld();
    world.gameDef.itemsByKind = new Map([["k1", { kind: "k1", maxStack: 10 }]]);
    const a = spawnTestParty(world);
    const b = spawnTestParty(world);
    Inventory[a] = emptyInventory(2);
    Inventory[b] = emptyInventory(2);
    Inventory[a].slots[0] = { kind: "k1", count: 6 };

    expect(transferContainer(world, inv(a), inv(b), "k1", 4)).toBe(true);
    expect(queryContainer(world, inv(a), "k1")).toBe(2);
    expect(queryContainer(world, inv(b), "k1")).toBe(4);
  });

  it("槽↔Ledger：背包扣减入账本 / 账本扣减入背包", () => {
    const world = createBareWorld();
    const a = spawnTestParty(world);
    const b = spawnTestParty(world);
    Inventory[a] = emptyInventory(4);
    Inventory[a].slots[0] = { kind: "o1", count: 3 };
    Ledger[b] = { o1: 5 };

    expect(transferContainer(world, inv(a), led(b), "o1", 3)).toBe(true);
    expect(queryContainer(world, inv(a), "o1")).toBe(0);
    expect(queryContainer(world, led(b), "o1")).toBe(8);

    expect(transferContainer(world, led(b), inv(a), "o1", 2)).toBe(true);
    expect(queryContainer(world, led(b), "o1")).toBe(6);
    expect(queryContainer(world, inv(a), "o1")).toBe(2);
  });

  it("Ledger↔Ledger：余额不足拒绝且零副作用", () => {
    const world = createBareWorld();
    const a = spawnTestParty(world);
    const b = spawnTestParty(world);
    Ledger[a] = { c1: 3 };
    Ledger[b] = { c1: 9 };

    expect(transferContainer(world, led(a), led(b), "c1", 5)).toBe(false);
    expect(Ledger[a]).toEqual({ c1: 3 });
    expect(Ledger[b]).toEqual({ c1: 9 });

    expect(transferContainer(world, led(a), led(b), "c1", 3)).toBe(true);
    expect(Ledger[a]).toEqual({});
    expect(Ledger[b]).toEqual({ c1: 12 });
  });

  it("容量不足：目标试插入失败后回滚，源未扣减", () => {
    const world = createBareWorld();
    const a = spawnTestParty(world);
    const b = spawnTestParty(world);
    Inventory[a] = emptyInventory(4);
    Inventory[a].slots[0] = { kind: "k1", count: 2 };
    Inventory[b] = emptyInventory(1); // 仅 1 空槽（maxStack=1）
    Inventory[b].slots[0] = { kind: "k2", count: 1 };

    expect(transferContainer(world, inv(a), inv(b), "k1", 2)).toBe(false);
    expect(queryContainer(world, inv(a), "k1")).toBe(2);
    expect(Inventory[b].slots[0]).toEqual({ kind: "k2", count: 1 });
  });

  it("swap：整容器交换；任一侧放不下整体回滚", () => {
    const world = createBareWorld();
    const a = spawnTestParty(world);
    const b = spawnTestParty(world);

    // 成功路径：背包 ↔ 账本（g1 3 个在 maxStack=1 下恰好放入 4 槽背包）
    Inventory[a] = emptyInventory(4);
    Inventory[a].slots[0] = { kind: "k1", count: 2 };
    Ledger[b] = { g1: 3 };
    expect(swapContainers(world, inv(a), led(b))).toBe(true);
    // 交换后：a 的背包装 b 原有内容，b 的账本记 a 原有内容
    expect(queryContainer(world, inv(a), "g1")).toBe(3);
    expect(Ledger[b]).toEqual({ k1: 2 });

    // 失败路径：大背包换 1 槽背包放不下 → 双方回滚
    const c = spawnTestParty(world);
    const d = spawnTestParty(world);
    Inventory[c] = emptyInventory(4);
    Inventory[c].slots[0] = { kind: "x1", count: 1 };
    Inventory[c].slots[1] = { kind: "x2", count: 1 };
    Inventory[d] = emptyInventory(1);
    Inventory[d].slots[0] = { kind: "y1", count: 1 };
    expect(swapContainers(world, inv(c), inv(d))).toBe(false);
    expect(queryContainer(world, inv(c), "x1")).toBe(1);
    expect(queryContainer(world, inv(c), "x2")).toBe(1);
    expect(queryContainer(world, inv(d), "y1")).toBe(1);
  });
});

// 多方结算：全量校验 → 结算 → 失败回滚
describe("settle 多方结算", () => {
  it("两方 inventory/ledger 混合条款结算成功", () => {
    const world = createBareWorld();
    const a = spawnTestParty(world);
    const b = spawnTestParty(world);
    Inventory[a] = emptyInventory(4);
    Inventory[a].slots[0] = { kind: "w1", count: 5 };
    Ledger[b] = { c1: 10 };
    Inventory[b] = emptyInventory(8); // b 收 5 个 w1（maxStack=1 需 5 槽）

    const terms: SettleTerms = [
      { party: a, give: [{ container: "inventory", kind: "w1", count: 5 }], take: [{ container: "ledger", kind: "c1", count: 6 }] },
      { party: b, give: [{ container: "ledger", kind: "c1", count: 6 }], take: [{ container: "inventory", kind: "w1", count: 5 }] },
    ];
    expect(settle(world, terms)).toBe(true);
    expect(queryContainer(world, inv(a), "w1")).toBe(0);
    expect(queryContainer(world, led(a), "c1")).toBe(6);
    expect(queryContainer(world, led(b), "c1")).toBe(4);
    expect(queryContainer(world, inv(b), "w1")).toBe(5);
  });

  it("give 足额校验失败：整体拒绝零副作用", () => {
    const world = createBareWorld();
    const a = spawnTestParty(world);
    const b = spawnTestParty(world);
    Inventory[a] = emptyInventory(2);
    Inventory[a].slots[0] = { kind: "k1", count: 1 };
    Ledger[b] = { c1: 5 };

    const terms: SettleTerms = [
      { party: a, give: [{ container: "inventory", kind: "k1", count: 2 }], take: [{ container: "ledger", kind: "c1", count: 5 }] },
      { party: b, give: [{ container: "ledger", kind: "c1", count: 5 }], take: [{ container: "inventory", kind: "k1", count: 2 }] },
    ];
    expect(settle(world, terms)).toBe(false);
    expect(queryContainer(world, inv(a), "k1")).toBe(1);
    expect(queryContainer(world, led(b), "c1")).toBe(5);
  });

  it("take 容量不足：已执行的 give 全量回滚（原子性）", () => {
    const world = createBareWorld();
    const a = spawnTestParty(world);
    const b = spawnTestParty(world);
    Inventory[a] = emptyInventory(4);
    Inventory[a].slots[0] = { kind: "l1", count: 3 };
    Inventory[b] = emptyInventory(1); // 仅 1 空槽，收不下 3 个 l1

    const terms: SettleTerms = [
      { party: a, give: [{ container: "inventory", kind: "l1", count: 3 }] },
      { party: b, give: [], take: [{ container: "inventory", kind: "l1", count: 3 }] },
    ];
    expect(settle(world, terms)).toBe(false);
    // 回滚：a 的 l1 仍在
    expect(queryContainer(world, inv(a), "l1")).toBe(3);
  });

  it("三方结算：链式交换", () => {
    const world = createBareWorld();
    const a = spawnTestParty(world);
    const b = spawnTestParty(world);
    const c = spawnTestParty(world);
    Ledger[a] = { c1: 10 };
    Ledger[b] = { g1: 2 };
    Inventory[c] = emptyInventory(4);
    Inventory[c].slots[0] = { kind: "f1", count: 1 };
    Inventory[a] = emptyInventory(4); // a 收 f1
    Ledger[c] = {}; // c 收 g1（账本可预置空，也可由 credit 自建）

    const terms: SettleTerms = [
      { party: a, give: [{ container: "ledger", kind: "c1", count: 4 }], take: [{ container: "inventory", kind: "f1", count: 1 }] },
      { party: b, give: [{ container: "ledger", kind: "g1", count: 1 }], take: [{ container: "ledger", kind: "c1", count: 4 }] },
      { party: c, give: [{ container: "inventory", kind: "f1", count: 1 }], take: [{ container: "ledger", kind: "g1", count: 1 }] },
    ];
    expect(settle(world, terms)).toBe(true);
    expect(Ledger[a]).toEqual({ c1: 6 });
    expect(Ledger[b]).toEqual({ g1: 1, c1: 4 });
    expect(queryContainer(world, led(c), "g1")).toBe(1);
    expect(queryContainer(world, inv(a), "f1")).toBe(1);
  });
});

// 报价会话：先验后结（无资产硬锁）
describe("offer 报价会话", () => {
  it("无玩家方即时成立：创建即结算", () => {
    const world = createBareWorld();
    const npcA = spawnTestParty(world);
    const npcB = spawnTestParty(world);
    Ledger[npcA] = { c1: 5 };
    Inventory[npcA] = emptyInventory(4); // npcA 收 k1
    Inventory[npcB] = emptyInventory(4);
    Inventory[npcB].slots[0] = { kind: "k1", count: 1 };

    const terms: SettleTerms = [
      { party: npcA, give: [{ container: "ledger", kind: "c1", count: 5 }], take: [{ container: "inventory", kind: "k1", count: 1 }] },
      { party: npcB, give: [{ container: "inventory", kind: "k1", count: 1 }], take: [{ container: "ledger", kind: "c1", count: 5 }] },
    ];
    const id = openOffer(world, terms);
    expect(id).not.toBeNull();
    expect(getOffer(world, id!)!.status).toBe("settled");
    expect(Ledger[npcA]).toEqual({});
    // npcB 收的 c1 进其账本（insert 自建）
    expect(queryContainer(world, led(npcB), "c1")).toBe(5);
    expect(queryContainer(world, inv(npcA), "k1")).toBe(1);
  });

  it("玩家方需确认：pending → accept → settled；重复确认拒绝", () => {
    const world = createBareWorld();
    const player = spawnTestParty(world, { player: true });
    const npc = spawnTestParty(world);
    Inventory[player] = emptyInventory(4);
    Inventory[player].slots[0] = { kind: "o1", count: 2 };
    Ledger[npc] = { c1: 9 };
    Inventory[npc] = emptyInventory(4); // npc 收 o1

    const terms: SettleTerms = [
      { party: player, give: [{ container: "inventory", kind: "o1", count: 2 }], take: [{ container: "ledger", kind: "c1", count: 9 }] },
      { party: npc, give: [{ container: "ledger", kind: "c1", count: 9 }], take: [{ container: "inventory", kind: "o1", count: 2 }] },
    ];
    const id = openOffer(world, terms)!;
    const session = getOffer(world, id)!;
    expect(session.status).toBe("pending"); // 玩家未确认，不结算
    expect(session.confirmed.has(npc)).toBe(true); // NPC 方即时确认

    expect(acceptOffer(world, player, id)).toBe(true);
    expect(session.status).toBe("settled");
    expect(Ledger[player]).toEqual({ c1: 9 });

    // 已结算后重复确认拒绝
    expect(acceptOffer(world, player, id)).toBe(false);
  });

  it("任一方取消作废；非参与方无法确认/取消", () => {
    const world = createBareWorld();
    const p1 = spawnTestParty(world, { player: true });
    const p2 = spawnTestParty(world, { player: true });
    const outsider = spawnTestParty(world, { player: true });
    Ledger[p1] = { c1: 1 };

    const id = openOffer(world, [
      { party: p1, give: [{ container: "ledger", kind: "c1", count: 1 }] },
      { party: p2, take: [{ container: "ledger", kind: "c1", count: 1 }] },
    ])!;
    expect(getOffer(world, id)!.status).toBe("pending");

    expect(acceptOffer(world, outsider, id)).toBe(false);
    expect(cancelOffer(world, outsider, id)).toBe(false);
    expect(cancelOffer(world, p1, id)).toBe(true);
    expect(getOffer(world, id)!.status).toBe("cancelled");
    // 资产未动（无硬锁语义）
    expect(Ledger[p1]).toEqual({ c1: 1 });
  });

  it("到期作废：过期后确认/取消均拒绝", () => {
    const world = createBareWorld();
    const p = spawnTestParty(world, { player: true });
    const npc = spawnTestParty(world);
    Ledger[npc] = { c1: 1 };

    const id = openOffer(
      world,
      [
        { party: p, take: [{ container: "ledger", kind: "c1", count: 1 }] },
        { party: npc, give: [{ container: "ledger", kind: "c1", count: 1 }] },
      ],
      { expiresTick: world.time.tick + 5 },
    )!;
    expect(getOffer(world, id)!.status).toBe("pending");

    world.time.tick += 10;
    pruneExpiredOffers(world);
    expect(getOffer(world, id)!.status).toBe("expired");
    expect(acceptOffer(world, p, id)).toBe(false);
    expect(Ledger[npc]).toEqual({ c1: 1 });
  });

  it("全确认时结算失败（先验后结）→ 会话作废", () => {
    const world = createBareWorld();
    const p = spawnTestParty(world, { player: true });
    const npc = spawnTestParty(world);
    Ledger[npc] = { c1: 1 };

    // 条款要求 p 收 5 个 c1，但 npc 只有 1 → 最终结算失败
    const id = openOffer(world, [
      { party: p, take: [{ container: "ledger", kind: "c1", count: 5 }] },
      { party: npc, give: [{ container: "ledger", kind: "c1", count: 5 }] },
    ])!;
    expect(getOffer(world, id)!.status).toBe("pending");
    expect(acceptOffer(world, p, id)).toBe(false);
    expect(getOffer(world, id)!.status).toBe("cancelled");
    expect(Ledger[npc]).toEqual({ c1: 1 });
  });
});

// offer 命令全链路（GameSimulation → economy）
describe("offer 命令（GameSimulation 接线）", () => {
  /** 取仿真内部 world（镜像 slice5 测试的私有访问器）。 */
  function simWorld(sim: SimulationPort): GameWorld {
    return (sim as unknown as { world: GameWorld }).world;
  }

  it("offer → offer-accept → 结算生效；offer-cancel 作废", async () => {
    const sim = await createGameSimulation(createDefaultGameDefinition());
    const world = simWorld(sim);
    sim.addPlayer("s1");
    sim.addPlayer("s2");
    const [p1, p2] = query(world, [Player]);
    Inventory[p1] = emptyInventory(4);
    Inventory[p1].slots[0] = { kind: "k1", count: 2 };
    Ledger[p2] = { c1: 6 };
    Inventory[p2] = emptyInventory(4); // p2 收 k1

    // s1 发起：给 2 个 k1，收 6 个 c1（s1 本人视为已确认；s2 是玩家需确认）
    const offered = sim.submitCommand("s1", {
      type: "offer",
      offer: [
        { party: p1, give: [{ container: "inventory", kind: "k1", count: 2 }], take: [{ container: "ledger", kind: "c1", count: 6 }] },
        { party: p2, give: [{ container: "ledger", kind: "c1", count: 6 }], take: [{ container: "inventory", kind: "k1", count: 2 }] },
      ],
    });
    expect(offered).toBe(true);
    const sessions = [...world.offerSessions.values()];
    expect(sessions.length).toBe(1);
    const id = sessions[0].id;
    expect(sessions[0].status).toBe("pending");

    // s2 确认 → 全确认 → 结算
    expect(sim.submitCommand("s2", { type: "offer-accept", offerId: id })).toBe(true);
    expect(sessions[0].status).toBe("settled");
    expect(queryContainer(world, led(p1), "c1")).toBe(6);
    expect(queryContainer(world, inv(p2), "k1")).toBe(2);

    // 新报价 → s1 取消 → 作废
    Inventory[p1].slots[0] = { kind: "k1", count: 2 };
    expect(sim.submitCommand("s1", {
      type: "offer",
      offer: [
        { party: p1, give: [{ container: "inventory", kind: "k1", count: 2 }] },
        { party: p2, take: [{ container: "inventory", kind: "k1", count: 2 }] },
      ],
    })).toBe(true);
    const id2 = [...world.offerSessions.values()].find((s) => s.id !== id)!.id;
    expect(sim.submitCommand("s1", { type: "offer-cancel", offerId: id2 })).toBe(true);
    expect(getOffer(world, id2)!.status).toBe("cancelled");
    expect(queryContainer(world, inv(p1), "k1")).toBe(2);
  });
});
