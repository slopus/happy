import { describe, expect, it } from 'vitest';
import { STANDALONE_LAUNCH_ENV, captureStandaloneLaunchBootstrap, takeStandaloneLaunchBootstrap } from './standaloneLaunchProtocol';

const bootstrap = JSON.stringify({ version: 1, instanceId: 'instance', launchId: 'launch', port: 4000, secret: 'a'.repeat(64) });

describe('standalone launch bootstrap capture', () => {
    it('hands the bootstrap to the runtimes that can drain, as the daemon spawns them', () => {
        for (const args of [['codex'], ['claude'], ['grok'], ['acp', 'opencode']]) {
            const env: NodeJS.ProcessEnv = { [STANDALONE_LAUNCH_ENV]: bootstrap };
            captureStandaloneLaunchBootstrap(env, args);
            expect(env[STANDALONE_LAUNCH_ENV]).toBeUndefined();
            expect(takeStandaloneLaunchBootstrap({})).toMatchObject({ launchId: 'launch' });
        }
    });

    it('refuses a standalone launch of an agent without a drain, and leaves nothing to take', () => {
        for (const args of [['acp'], ['acp', 'gemini'], ['acp', 'grok'], ['gemini'], ['openclaw'], []]) {
            const env: NodeJS.ProcessEnv = { [STANDALONE_LAUNCH_ENV]: bootstrap };
            expect(() => captureStandaloneLaunchBootstrap(env, args)).toThrow(/Standalone launch/);
            expect(env[STANDALONE_LAUNCH_ENV]).toBeUndefined();
            expect(takeStandaloneLaunchBootstrap({})).toBeUndefined();
        }
    });
});
