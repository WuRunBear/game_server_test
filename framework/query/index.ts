/**
 * 查询面公共入口（framework/query）。
 *
 * 每个模块都是纯只读函数：调用方（GameSimulation / HTTP 层）只负责解析
 * networkId 与状态码；规则统一复用 gameplay 系统的干跑/定价函数。
 */
export * from "./types";
export * from "./affordances";
export * from "./placePreview";
export * from "./craftPreview";
export * from "./shop";
export * from "./ui";
