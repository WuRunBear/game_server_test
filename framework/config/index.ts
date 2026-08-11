/**
 * config 模块统一出口（barrel）。
 *
 * 框架其余部分需要配置时一律经本文件导入（路径别名 "config"），
 * 保持「游戏无关配置」的单一入口。当前导出：
 * - getMapSourceFromConfig：从项目配置解析地图来源（MapSource）
 * - serverConfig / ServerConfig：服务端网络监听配置
 */
export { getMapSourceFromConfig } from "config/map";
export { serverConfig, type ServerConfig } from "config/server";
