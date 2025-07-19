import pino from 'pino';
import { mkdirSync } from 'fs';
import { join } from 'path';

const isDebug = process.env.DEBUG === 'true' || process.env.NODE_ENV === 'development';
const logsDir = join(process.cwd(), '.logs');

if (isDebug) {
    try {
        mkdirSync(logsDir, { recursive: true });
    } catch (error) {
        console.error('Failed to create logs directory:', error);
    }
}

const transports: any[] = [];

transports.push({
    target: 'pino-pretty',
    options: {
        colorize: true,
        translateTime: 'HH:MM:ss.l',
        ignore: 'pid,hostname',
        messageFormat: '{levelLabel} [{time}] {msg}',
        errorLikeObjectKeys: ['err', 'error'],
    },
});

if (isDebug) {
    transports.push({
        target: 'pino/file',
        options: {
            destination: join(logsDir, `server-${new Date().toISOString().split('T')[0]}.log`),
            mkdir: true,
        },
    });
}

export const logger = pino({
    level: isDebug ? 'debug' : 'info',
    transport: {
        targets: transports,
    },
});

export function log(src: any, ...args: any[]) {
    logger.info(src, ...args);
}

export function warn(src: any, ...args: any[]) {
    logger.warn(src, ...args);
}

export function error(src: any, ...args: any[]) {
    logger.error(src, ...args);
}

export function debug(src: any, ...args: any[]) {
    logger.debug(src, ...args);
}