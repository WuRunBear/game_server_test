export interface Logger {
  info(message: string, extra?: Record<string, unknown>): void;
  warn(message: string, extra?: Record<string, unknown>): void;
  error(message: string, extra?: Record<string, unknown>): void;
}

/**
 * 把日志消息与附加字段格式化为一行字符串。
 *
 * @param message 日志正文
 * @param extra 附加字段（会被 JSON 序列化）
 * @returns 格式化后的文本
 */
function format(message: string, extra?: Record<string, unknown>): string {
  if (!extra) return message;
  return `${message} ${JSON.stringify(extra)}`;
}

/**
 * 创建一个带 scope 前缀的控制台日志器。
 *
 * @param scope 日志作用域（会出现在前缀中）
 * @returns Logger
 */
export function createLogger(scope: string): Logger {
  return {
    info(message, extra) {
      console.log(`[${scope}] ${format(message, extra)}`);
    },
    warn(message, extra) {
      console.warn(`[${scope}] ${format(message, extra)}`);
    },
    error(message, extra) {
      console.error(`[${scope}] ${format(message, extra)}`);
    },
  };
}
