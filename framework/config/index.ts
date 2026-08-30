/**
 * config 模块统一出口（barrel）。
 *
 * 框架其余部分需要配置时一律经本文件导入（路径别名 "config"），
 * 保持「游戏无关配置」的单一入口。当前导出：
 * - serverConfig / ServerConfig：服务端网络监听配置
 *
 * （旧地图清单读取 config/map.ts 已无消费方——/maps/* 端点改用
 * gameDef.resolvedMapConfigs；文件保留至旧系统清理 todo 删除。）
 */
export { serverConfig, type ServerConfig } from "config/server";
