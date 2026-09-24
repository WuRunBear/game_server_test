import { bootstrapFramework } from "framework/bootstrap";

// 由 src/main.ts 在启动链最前 import 执行，使其中的自定义扩展注册先于 createGameInstance。
bootstrapFramework();

// 游戏自定义扩展注册（框架功能之外的 src 专属实现）写在这里：
// 使用 framework/api 的 registerSystem / registerComponent / registerArchetype /
// registerAction / registerRuleModule，地图生成积木经
// getRegistries().mapGeneratorRegistry.register()；新签名支持可选
// description / configSchema 元数据（见 docs/CONFIG-EDITOR-PLAN.md §Phase A3）。
