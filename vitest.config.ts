import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  test: {
    include: ["framework/__tests__/**/*.test.ts"],
    exclude: ["node_modules", "dist"],
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
