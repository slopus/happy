import { describe, expect, it } from 'vitest';
import { STANDALONE_LAUNCH_ENV, captureStandaloneLaunchBootstrap, takeStandaloneLaunchBootstrap } from './standaloneLaunchProtocol';

const bootstrap = JSON.stringify({ version: 1, instanceId: 'instance', launchId: 'launch', port: 4000, secret: 'a'.repeat(64) });

describe('standalone launch bootstrap capture', () => {
    it('hands the bootstrap to the Codex and Claude runtimes that can drain', () => {
        for (const command of ['codex', 'claude']) {
            const env: NodeJS.ProcessEnv = { [STANDALONE_LAUNCH_ENV]: bootstrap };
            captureStandaloneLaunchBootstrap(env, command);
            expect(env[STANDALONE_LAUNCH_ENV]).toBeUndefined();
            expect(takeStandaloneLaunchBootstrap({})).toMatchObject({ launchId: 'launch' });
        }
    });

    it('refuses a standalone launch of an agent without a drain, and leaves nothing to take', () => {
        for (const command of ['acp', 'grok', 'gemini', undefined]) {
            const env: NodeJS.ProcessEnv = { [STANDALONE_LAUNCH_ENV]: bootstrap };
            expect(() => captureStandaloneLaunchBootstrap(env, command)).toThrow(/Standalone launch/);
            expect(env[STANDALONE_LAUNCH_ENV]).toBeUndefined();
            expect(takeStandaloneLaunchBootstrap({})).toBeUndefined();
        }
    });
});
