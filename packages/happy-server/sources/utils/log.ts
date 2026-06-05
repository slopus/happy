import pino from 'pino';
import pretty from 'pino-pretty';
import { mkdirSync } from 'fs';
import { join } from 'path';

// Single log file name created once at startup
let consolidatedLogFile: string | undefined;

if (process.env.DANGEROUSLY_LOG_TO_SERVER_FOR_AI_AUTO_DEBUGGING) {
    const logsDir = join(process.cwd(), '.logs');
    try {
        mkdirSync(logsDir, { recursive: true });
        // Create filename once at startup
        const now = new Date();
        const month = String(now.getMonth() + 1).padStart(2, '0');
        const day = String(now.getDate()).padStart(2, '0');
        const hour = String(now.getHours()).padStart(2, '0');
        const min = String(now.getMinutes()).padStart(2, '0');
        const sec = String(now.getSeconds()).padStart(2, '0');
        consolidatedLogFile = join(logsDir, `${month}-${day}-${hour}-${min}-${sec}.log`);
        console.log(`[PINO] Remote debugging logs enabled - writing to ${consolidatedLogFile}`);
    } catch (error) {
        console.error('Failed to create logs directory:', error);
    }
}

// Format time as HH:MM:ss.mmm in local time
function formatLocalTime(timestamp?: number) {
    const date = timestamp ? new Date(timestamp) : new Date();
    const hours = String(date.getHours()).padStart(2, '0');
    const mins = String(date.getMinutes()).padStart(2, '0');
    const secs = String(date.getSeconds()).padStart(2, '0');
    const ms = String(date.getMilliseconds()).padStart(3, '0');
    return `${hours}:${mins}:${secs}.${ms}`;
}

// IMPORTANT: do NOT use pino's `transport` option here.
//
// pino transports run the target (pino-pretty, pino/file) in a worker_thread,
// which resolves the module from a real path on disk. happy-server ships as a
// single-file `bun build --compile` binary (see happy-cli `happy server`); inside
// Bun's virtual $bunfs there is no node_modules/pino-pretty for the worker to
// load, so the threaded transport crashes at startup.
//
// Synchronous in-process streams (pino-pretty as a stream + pino.destination,
// composed with pino.multistream) need no worker and no on-disk resolution, so
// they work identically whether bundled or run from source.
const prettyStream = pretty({
    colorize: true,
    translateTime: 'HH:MM:ss.l',
    ignore: 'pid,hostname',
    messageFormat: '{levelLabel} {msg} | [{time}]',
    errorLikeObjectKeys: ['err', 'error'],
});

const loggerStreams: pino.StreamEntry[] = [{ level: 'debug', stream: prettyStream }];

if (process.env.DANGEROUSLY_LOG_TO_SERVER_FOR_AI_AUTO_DEBUGGING && consolidatedLogFile) {
    loggerStreams.push({
        level: 'debug',
        stream: pino.destination({ dest: consolidatedLogFile, mkdir: true }),
    });
}

// Shared core options: both loggers add localTime to every entry and emit the
// same timestamp shape. Stream selection (pretty/file) is layered on top.
const baseOptions = {
    level: 'debug',
    formatters: {
        log: (object: any) => {
            // Add localTime to every log entry
            return {
                ...object,
                localTime: formatLocalTime(typeof object.time === 'number' ? object.time : undefined),
            };
        },
    },
    timestamp: () => `,"time":${Date.now()},"localTime":"${formatLocalTime()}"`,
} satisfies pino.LoggerOptions;

// Main server logger with local time formatting
export const logger = pino(baseOptions, pino.multistream(loggerStreams));

// Optional file-only logger for remote logs from CLI/mobile
export const fileConsolidatedLogger = process.env.DANGEROUSLY_LOG_TO_SERVER_FOR_AI_AUTO_DEBUGGING && consolidatedLogFile ?
    pino(baseOptions, pino.destination({ dest: consolidatedLogFile, mkdir: true })) : undefined;

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
