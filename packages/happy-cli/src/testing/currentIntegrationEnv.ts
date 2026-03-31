import type { IntegrationEnvironment } from './integrationEnvironment';

declare global {
    // eslint-disable-next-line no-var
    var __happyIntegrationEnv: IntegrationEnvironment | undefined;
}

export function getIntegrationEnv(): IntegrationEnvironment {
    if (!globalThis.__happyIntegrationEnv) {
        throw new Error('No active integration environment');
    }

    return globalThis.__happyIntegrationEnv;
}
