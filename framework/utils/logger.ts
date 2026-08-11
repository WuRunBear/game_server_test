/**
 * 日志工具（游戏无关）：基于 winston 的轻量封装。
 *
 * 提供带 scope（作用域）前缀的日志器：同一底层 logger 输出到
 * 控制台（带颜色）与 logs/game.log 文件，日志行形如
 * `时间 级别 [scope] 消息 {附加字段}`。
 */
import fs from "node:fs";
import path from "node:path";
import { inspect } from "node:util";
import winston from "winston";

/**
 * 日志器接口：三个级别，extra 为可选的附加结构化字段（会 JSON 化打印）。
 * 以 createLogger(scope) 工厂创建，各模块持有自己的 scope 便于过滤。
 */
export interface Logger {
  /** 记录 info 级日志。 */
  info(message: string, extra?: Record<string, unknown>): void;
  /** 记录 warn 级日志。 */
  warn(message: string, extra?: Record<string, unknown>): void;
  /** 记录 error 级日志。 */
  error(message: string, extra?: Record<string, unknown>): void;
}

/** 日志目录（进程工作目录下 logs/）。 */
const LOG_DIR = path.join(process.cwd(), "logs");
/** 日志文件路径。 */
const LOG_FILE = path.join(LOG_DIR, "game.log");

/** 底层 winston logger（惰性创建，全局单例）。 */
let baseLogger: winston.Logger | undefined;

/** 获取底层 logger：首次调用时建目录并初始化控制台 + 文件双输出。 */
function getBaseLogger(): winston.Logger {
  if (baseLogger) return baseLogger;

  fs.mkdirSync(LOG_DIR, { recursive: true });

  // useColors=true 用于控制台（着色），false 用于文件（纯文本）
  const makeFormat = (useColors: boolean) =>
    winston.format.combine(
      winston.format.timestamp({ format: "YYYY-MM-DD HH:mm:ss.SSS" }),
      useColors ? winston.format.colorize({ level: true }) : winston.format.uncolorize(),
      winston.format.printf((info) => {
        const { timestamp, level, message, scope, ...meta } = info as Record<string, unknown> & {
          timestamp: string;
          level: string;
          message: string;
          scope?: string;
        };

        const extraText = Object.keys(meta).length ? ` ${inspect(meta, { colors: useColors, depth: null, compact: true, breakLength: Infinity })}` : "";
        const prefix = scope ? `[${scope}] ` : "";
        return `${timestamp} ${level} ${prefix}${message}${extraText}`;
      }),
    );

  baseLogger = winston.createLogger({
    level: "info",
    transports: [
      new winston.transports.Console({ format: makeFormat(true) }),
      new winston.transports.File({ filename: LOG_FILE, format: makeFormat(false) }),
    ],
  });

  return baseLogger;
}

/**
 * 创建一个带 scope 前缀的日志器（输出到控制台与文件）。
 *
 * @param scope 日志作用域（会出现在前缀中）
 * @returns Logger
 */
export function createLogger(scope: string): Logger {
  const logger = getBaseLogger();
  return {
    info(message, extra) {
      logger.info(message, { scope, ...(extra ?? {}) });
    },
    warn(message, extra) {
      logger.warn(message, { scope, ...(extra ?? {}) });
    },
    error(message, extra) {
      logger.error(message, { scope, ...(extra ?? {}) });
    },
  };
}
