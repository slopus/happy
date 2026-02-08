import { startApiServer } from './api/app';
import { env } from './runtime/env';
import { logError, logInfo } from './runtime/log';
import { sessionStore } from './runtime/sessionStore';
import { startWorker } from './worker/agent';

type ServiceMode = 'api' | 'worker' | 'all';

function resolveMode(): ServiceMode {
    const cliMode = process.argv[2] as ServiceMode | undefined;
    const envMode = process.env.HAPPY_VOICE_MODE as ServiceMode | undefined;
    return cliMode || envMode || 'api';
}

async function run() {
    const mode = resolveMode();
    logInfo(`Booting happy-voice in mode=${mode} env=${env.NODE_ENV}`);

    setInterval(() => {
        sessionStore.pruneExpired();
    }, 5 * 60 * 1000).unref();

    if (mode === 'api') {
        await startApiServer();
        return;
    }

    if (mode === 'worker') {
        await startWorker();
        return;
    }

    await startApiServer();
    await startWorker();
}

run().catch((error) => {
    logError('Fatal startup error', error);
    process.exit(1);
});
