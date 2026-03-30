export interface Logger {
  debug(message: string, ...args: unknown[]): void;
  info(message: string, ...args: unknown[]): void;
  warn(message: string, ...args: unknown[]): void;
  error(message: string, ...args: unknown[]): void;
}

function debugEnabled(): boolean {
  const value = process.env.PI_HAPPY_DEBUG ?? process.env.DEBUG;
  return value === '1' || value === 'true' || value === '*';
}

function log(level: 'debug' | 'info' | 'warn' | 'error', message: string, args: unknown[]): void {
  const prefix = '[pi-happy]';
  switch (level) {
    case 'debug':
      if (debugEnabled()) {
        console.debug(prefix, message, ...args);
      }
      return;
    case 'info':
      console.info(prefix, message, ...args);
      return;
    case 'warn':
      console.warn(prefix, message, ...args);
      return;
    case 'error':
      console.error(prefix, message, ...args);
      return;
  }
}

export function createLogger(): Logger {
  return {
    debug(message: string, ...args: unknown[]) {
      log('debug', message, args);
    },
    info(message: string, ...args: unknown[]) {
      log('info', message, args);
    },
    warn(message: string, ...args: unknown[]) {
      log('warn', message, args);
    },
    error(message: string, ...args: unknown[]) {
      log('error', message, args);
    },
  };
}

export const logger = createLogger();
