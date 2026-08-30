/**
 * map 模块公共出口（barrel）。
 *
 * 新地图系统按层自治：geometry（数据）/ generate（生成）/ evolution（演化）/
 * runtime（编排）各有独立子模块；本 barrel 只保留目录级公共面：
 * - movePlayerToMap：跨图移动执行器（portal/respawn 消费）。
 */
export { movePlayerToMap } from "map/switchMap";
