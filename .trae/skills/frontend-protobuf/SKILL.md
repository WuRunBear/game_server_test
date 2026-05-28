---
name: "frontend-protobuf"
description: "为前端项目接入 Protobuf（Buf + protobuf-es），支持从 .proto 生成 TS 代码与 WebSocket 二进制收发模板。用户要在前端使用同一套协议/新增 protobuf 通讯时调用。"
---

# 前端 Protobuf（Buf + protobuf-es）

## 目标

把前端项目改造成：

- 以 `.proto` 为唯一真源
- 使用 Buf 生成 TypeScript 协议代码
- 使用 `@bufbuild/protobuf` 在浏览器侧进行二进制序列化/反序列化（适配 WebSocket 二进制帧）

## 最小接入步骤（通用）

### 1）安装依赖

运行以下其一（按项目包管理器选择）：

```bash
pnpm add @bufbuild/protobuf
pnpm add -D @bufbuild/buf @bufbuild/protoc-gen-es
```

```bash
npm i @bufbuild/protobuf
npm i -D @bufbuild/buf @bufbuild/protoc-gen-es
```

```bash
yarn add @bufbuild/protobuf
yarn add -D @bufbuild/buf @bufbuild/protoc-gen-es
```

如果使用 pnpm 且安装时提示类似 “Ignored build scripts: @bufbuild/buf …”，需要放行该依赖的安装脚本（二选一）：

- 方式一：执行 `pnpm approve-builds`，交互式允许 `@bufbuild/buf`
- 方式二：在 `package.json` 加入：

```json
{
  "pnpm": {
    "onlyBuiltDependencies": ["@bufbuild/buf"]
  }
}
```

### 2）加入 proto 与 Buf 配置

建议目录结构（可按项目调整）：

```
proto/
  game/v1/network.proto
buf.yaml
buf.gen.yaml
src/
  proto/
    gen/   (生成产物输出目录)
```

`buf.yaml` 最小示例：

```yaml
version: v2
modules:
  - path: proto
lint:
  use:
    - STANDARD
```

`buf.gen.yaml` 最小示例（生成 TS 到 `src/proto/gen`）：

```yaml
version: v2
clean: true
plugins:
  - local: protoc-gen-es
    out: src/proto/gen
    opt:
      - target=ts
inputs:
  - directory: proto
```

### 3）加入脚本并生成代码

在 `package.json` 加脚本：

```json
{
  "scripts": {
    "proto:gen": "buf generate",
    "proto:lint": "buf lint",
    "proto:format": "buf format -w"
  }
}
```

生成：

```bash
pnpm proto:gen
```

或（不关心包管理器时）：

```bash
npx buf generate
```

## WebSocket 二进制收发模板（浏览器侧）

假设你在 `.proto` 里定义了 `ClientMessage`、`ServerMessage` 两个入口消息（oneof 包裹具体 payload），则前端通常这样做：

```ts
import { create, fromBinary, toBinary } from "@bufbuild/protobuf";
import { ClientMessageSchema, ServerMessageSchema } from "../src/proto/gen/game/v1/network_pb";

const ws = new WebSocket("ws://localhost:3000/ws");
ws.binaryType = "arraybuffer";

ws.addEventListener("open", () => {
  const msg = create(ClientMessageSchema, {
    payload: { case: "input", value: { seq: 1, moveX: 1, moveY: 0 } },
  });
  const bytes = toBinary(ClientMessageSchema, msg);
  ws.send(bytes);
});

ws.addEventListener("message", (ev) => {
  const bytes = new Uint8Array(ev.data as ArrayBuffer);
  const msg = fromBinary(ServerMessageSchema, bytes);
  if (msg.payload.case === "snapshot") {
    const snapshot = msg.payload.value;
    console.log(snapshot.tick, snapshot.entities);
  }
});
```

## 约定与建议（避免踩坑）

- WebSocket 走二进制时，浏览器侧把 `ws.binaryType` 设为 `arraybuffer`，接收才能直接得到 `ArrayBuffer`
- 生成代码建议不要手改：只改 `.proto`，然后重新 `buf generate`
- 如果团队希望“前端不安装 buf”，可以把生成产物作为 npm 私有包发布；但仍建议同时保留 `.proto`，避免协议漂移

## 验收清单

- `proto:gen` 能生成 `src/proto/gen/**` 且无报错
- 前端能成功 `toBinary` 发送消息，后端能 `fromBinary` 解析（反之亦然）
- 修改 `.proto` 后重新生成，类型与 Schema 同步更新
