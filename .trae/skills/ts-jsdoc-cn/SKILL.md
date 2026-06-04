---
name: "ts-jsdoc-cn"
description: "为 TypeScript 的类型定义及字段补充中文 JSDoc 注释。用户要求“给类型/字段补充注释”或提供 TS 文件让你补注释时调用。"
---

# TypeScript 类型/字段中文注释补全

## 目标

在不改动业务逻辑与格式的前提下，为 TypeScript 文件中的类型定义与其字段补充中文注释，提升可读性与可维护性。

## 适用范围

- `export type ...`
- `export interface ...`
- 上述类型中的字段（含可选字段 `?`）

## 注释规范

- 语言：必须使用中文
- 位置：注释放在声明/字段的正上方
- 形式：
  - 类型定义使用 `/** ... */`
  - 字段注释使用 `/** ... */`
- 风格：简洁明了，说明“它是什么/用于什么”，避免复述类型本身
- 不做额外修改：不重排字段、不重命名、不引入无关格式化

## 执行步骤

1. 扫描文件中所有 `export type` 与 `export interface` 定义
2. 为每个类型补充一段一句话中文说明
3. 为类型内每个字段补充一句话中文说明
4. 保持与现有代码一致的缩进与空行风格
5. 最后检查 TypeScript 诊断，确保无新增错误

## 示例

输入：

```ts
export interface GameTime {
  tick: Tick;
  dtMs: number;
}
```

输出：

```ts
/**
 * 运行期时间数据。
 */
export interface GameTime {
  /**
   * 当前逻辑帧编号。
   */
  tick: Tick;

  /**
   * 本帧实际步长（毫秒）。
   */
  dtMs: number;
}
```

