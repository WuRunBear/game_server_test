import fs from "node:fs";
import path from "node:path";
import { inspect } from "node:util";
import winston from "winston";

export interface Logger {
  info(message: string, extra?: Record<string, unknown>): void;
  warn(message: string, extra?: Record<string, unknown>): void;
  error(message: string, extra?: Record<string, unknown>): void;
}

const LOG_DIR = path.join(process.cwd(), "logs");
const LOG_FILE = path.join(LOG_DIR, "game.log");

let baseLogger: winston.Logger | undefined;

function getBaseLogger(): winston.Logger {
  if (baseLogger) return baseLogger;

  fs.mkdirSync(LOG_DIR, { recursive: true });

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
