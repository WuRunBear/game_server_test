/**
 * 注册元数据（游戏无关）。
 *
 * 框架各注册点（系统/组件/原型/动作/规则模块/生成积木/刷怪条件/效果/触发器）
 * 可携带可选元数据：功能介绍 description 与参数 schema configSchema。外部配置
 * 编辑器经 RPC（listRegistries）读取这些元数据，在「添加框架功能」面板展示介绍、
 * 并按 configSchema 渲染参数表单。
 *
 * 本模块只承载通用元数据形态与注册守卫，不含任何游戏语义；字段级介绍用字段声明
 * 前导 JSDoc（配置编辑器 A1 规范），数值约束走 zod 链，由 z.toJSONSchema 自动转成
 * JSON Schema 关键字。
 */
import { z } from "zod";

/** 注册条目可选元数据。 */
export interface RegistrationMetadata {
  /**
   * 功能介绍（编辑器「添加框架功能」面板直接展示）。
   * 可省略以保持旧注册点向后兼容；新注册点建议填写。
   */
  description?: string;
  /**
   * 参数配置 zod 对象 schema；有 config 的注册应提供。
   * 字段介绍用字段声明前导 JSDoc，数值约束走 zod 链（min/max/default/枚举）。
   */
  configSchema?: z.ZodType;
}

/** 注册条目的统一元数据视图（id + 元数据），供 sidecar listRegistries 消费。 */
export interface RegistrationEntry extends RegistrationMetadata {
  /** 注册 id（系统 id / 组件名 / 动作名 / 生成积木 id 等）。 */
  id: string;
}

/**
 * 注册守卫：若提供了 configSchema，则转为 JSON Schema 并递归检查宽松对象形态。
 *
 * 宽松形态（允许任意额外属性，编辑器无法据此生成字段表单）在 zod 中来自
 * `z.object(...).passthrough()` / `z.looseObject(...)` / `.catchall(z.unknown())`，
 * 经 zod v4 `z.toJSONSchema(schema, { io: "input" })` 后表现为
 * `additionalProperties: true` 或等价的空 schema `{}`（`unevaluatedProperties` 同理）。
 * 命中即抛错拒绝注册，错误信息含注册名与命中路径，便于定位。
 *
 * @param registrationName 注册名（用于错误信息）
 * @param configSchema 待检查的 zod schema；缺省跳过
 */
export function assertStrictConfigSchema(
  registrationName: string,
  configSchema: z.ZodType | undefined,
): void {
  if (!configSchema) return;

  let jsonSchema: unknown;
  try {
    jsonSchema = z.toJSONSchema(configSchema, { io: "input" });
  } catch (err) {
    throw new Error(
      `Registration "${registrationName}" configSchema cannot be converted to JSON Schema: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }

  const loosePath = findLooseProperties(jsonSchema, "$");
  if (loosePath) {
    throw new Error(
      `Registration "${registrationName}" configSchema allows arbitrary properties at ${loosePath} ` +
        `(additionalProperties/unevaluatedProperties resolves to true or an empty schema); ` +
        `use a strict z.object({...}) without passthrough/looseObject/catchall`,
    );
  }
}

/** 递归查找 JSON Schema 中首个宽松对象形态，返回其路径；未命中返回 undefined。 */
function findLooseProperties(node: unknown, path: string): string | undefined {
  if (Array.isArray(node)) {
    for (let i = 0; i < node.length; i++) {
      const found = findLooseProperties(node[i], `${path}[${i}]`);
      if (found) return found;
    }
    return undefined;
  }
  if (!node || typeof node !== "object") return undefined;

  const record = node as Record<string, unknown>;
  for (const key of ["additionalProperties", "unevaluatedProperties"] as const) {
    if (Object.prototype.hasOwnProperty.call(record, key) && isLooseValue(record[key])) {
      return `${path}.${key}`;
    }
  }
  for (const [key, value] of Object.entries(record)) {
    if (key === "additionalProperties" || key === "unevaluatedProperties") continue;
    const found = findLooseProperties(value, `${path}.${key}`);
    if (found) return found;
  }
  return undefined;
}

/** 宽松值判定：`true` 或空 schema `{}`（允许任意值）。 */
function isLooseValue(value: unknown): boolean {
  if (value === true) return true;
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return Object.keys(value as Record<string, unknown>).length === 0;
  }
  return false;
}
