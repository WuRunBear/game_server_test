import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  test: {
    include: ["framework/__tests__/**/*.test.ts"],
    exclude: ["node_modules", "dist"],
    // legacy ECS（bitecs legacy 组件数组/注册表为模块级全局单例，eid 位槽跨 world 共享）
    // 多测试文件并发会交错污染——文件间串行执行
    fileParallelism: false,
  },
  resolve: {
    alias: [
      { find: "framework", replacement: resolve(__dirname, "framework") },
      { find: "world", replacement: resolve(__dirname, "framework/world") },
      { find: "components", replacement: resolve(__dirname, "framework/components") },
      { find: "systems", replacement: resolve(__dirname, "framework/systems") },
      { find: "ai", replacement: resolve(__dirname, "framework/ai") },
      { find: "map", replacement: resolve(__dirname, "framework/map") },
      { find: "utils", replacement: resolve(__dirname, "framework/utils") },
      { find: "config", replacement: resolve(__dirname, "framework/config") },
      { find: "network", replacement: resolve(__dirname, "framework/net") },
      { find: "database", replacement: resolve(__dirname, "framework") },
    ],
  },
});
