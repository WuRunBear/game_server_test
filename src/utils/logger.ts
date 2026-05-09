export interface Logger {
  info(message: string, extra?: Record<string, unknown>): void;
  warn(message: string, extra?: Record<string, unknown>): void;
  error(message: string, extra?: Record<string, unknown>): void;
}

function format(message: string, extra?: Record<string, unknown>): string {
  if (!extra) return message;
  return `${message} ${JSON.stringify(extra)}`;
}

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
