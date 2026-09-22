import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
    policy: {} as { analyticsEnabled?: boolean },
    postHogKey: 'test-project-key' as string | undefined,
    constructor: vi.fn(),
}));
vi.mock('@/sync/managedConfiguration', () => ({ managedConfiguration: state.policy }));
vi.mock('@/config', () => ({ config: { get postHogKey() { return state.postHogKey; } } }));
vi.mock('posthog-react-native', () => ({ default: class { constructor(...args: unknown[]) { state.constructor(...args); } } }));

beforeEach(() => {
    vi.resetModules();
    state.constructor.mockClear();
    delete state.policy.analyticsEnabled;
    state.postHogKey = 'test-project-key';
    vi.stubEnv('EXPO_PUBLIC_DISABLE_ANALYTICS', '');
    vi.stubGlobal('__HAPPY_CONFIG__', undefined);
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

describe('managed analytics', () => {
    it('never constructs PostHog when disabled, including lifecycle collection', async () => {
        state.policy.analyticsEnabled = false;
        expect((await import('./tracking')).tracking).toBeNull();
        expect(state.constructor).not.toHaveBeenCalled();
    });

    it.each([undefined, true])('preserves normal initialization when policy is %s', async (value) => {
        state.policy.analyticsEnabled = value;
        expect((await import('./tracking')).tracking).not.toBeNull();
        expect(state.constructor).toHaveBeenCalledWith('test-project-key', {
            host: 'https://us.i.posthog.com', captureAppLifecycleEvents: true,
        });
    });

    it.each(['1', 'true'])('cannot override the build disable flag %s', async (flag) => {
        state.policy.analyticsEnabled = true;
        vi.stubEnv('EXPO_PUBLIC_DISABLE_ANALYTICS', flag);
        expect((await import('./tracking')).tracking).toBeNull();
    });

    it('cannot override the self-hosted web disable flag', async () => {
        state.policy.analyticsEnabled = true;
        vi.stubGlobal('__HAPPY_CONFIG__', { disableAnalytics: true });
        expect((await import('./tracking')).tracking).toBeNull();
    });

    it('does not initialize without a PostHog key', async () => {
        state.policy.analyticsEnabled = true;
        state.postHogKey = undefined;
        expect((await import('./tracking')).tracking).toBeNull();
    });
});
