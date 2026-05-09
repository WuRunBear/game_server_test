# ts-backend

Node.js 游戏服务器，基于 ESEngine ECS 框架。

## 快速开始

```bash
# 安装依赖
npm install

# 开发模式（热重载）
npm run dev

# 构建并运行
npm run build:start
```

## 项目结构

```
src/
├── index.ts                    # 入口文件
├── server/
│   └── GameServer.ts           # 网络服务器配置
└── game/
    ├── Game.ts                 # ECS 游戏主类
    ├── scenes/
    │   └── MainScene.ts        # 主场景
    ├── components/             # ECS 组件
    │   ├── PositionComponent.ts
    │   └── VelocityComponent.ts
    └── systems/                # ECS 系统
        └── MovementSystem.ts
```

## 客户端连接

```typescript
import { Core } from '@esengine/ecs-framework';
import { NetworkPlugin } from '@esengine/network';

// 安装网络插件
const networkPlugin = new NetworkPlugin();
await Core.installPlugin(networkPlugin);

// 连接服务器
await networkPlugin.connect({
    url: 'ws://localhost:3000',
    playerName: 'Player1'
});
```

## 文档

- [ESEngine 文档](https://esengine.github.io/esengine/)
- [RPC 模块](https://esengine.github.io/esengine/modules/rpc/)
- [Network 模块](https://esengine.github.io/esengine/modules/network/)
