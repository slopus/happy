import { log } from '@/utils/log';

export function registerProcessHandlers(): void {
    // Process-level error handling
    process.on('uncaughtException', (error) => {
        log({
            module: 'process-error',
            level: 'error',
            stack: error.stack,
            name: error.name
        }, `Uncaught Exception: ${error.message}`);

        console.error('Uncaught Exception:', error);
        process.exit(1);
    });

    process.on('unhandledRejection', (reason, promise) => {
        const errorMsg = reason instanceof Error ? reason.message : String(reason);
        const errorStack = reason instanceof Error ? reason.stack : undefined;

        log({
            module: 'process-error',
            level: 'error',
            stack: errorStack,
            reason: String(reason)
        }, `Unhandled Rejection: ${errorMsg}`);

        console.error('Unhandled Rejection at:', promise, 'reason:', reason);
        process.exit(1);
    });

    process.on('warning', (warning) => {
        log({
            module: 'process-warning',
            level: 'warn',
            name: warning.name,
            stack: warning.stack
        }, `Process Warning: ${warning.message}`);
    });

    // Log when the process is about to exit
    process.on('exit', (code) => {
        if (code !== 0) {
            log({
                module: 'process-exit',
                level: 'error',
                exitCode: code
            }, `Process exiting with code: ${code}`);
        } else {
            log({
                module: 'process-exit',
                level: 'info',
                exitCode: code
            }, 'Process exiting normally');
        }
    });
}

