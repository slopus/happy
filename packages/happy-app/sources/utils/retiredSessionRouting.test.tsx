import * as React from 'react';
import { act } from 'react';
// @ts-expect-error react-test-renderer has no local declarations.
import TestRenderer from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ sessions: {} as Record<string, any> }));
const trackSessionSwitched = vi.hoisted(() => vi.fn());
vi.mock('@/sync/storage', () => ({ storage: { getState: () => state }, useSession: (id: string) => state.sessions[id] }));
vi.mock('@/track', () => ({ trackSessionSwitched }));
vi.mock('react-native', () => ({ Platform: { OS: 'web' }, Dimensions: { get: () => ({ width: 1400 }) } }));
vi.mock('expo-router', () => ({ Redirect: 'Redirect', useRouter: vi.fn() }));
vi.mock('@react-navigation/native', () => ({ useRoute: () => ({ params: { id: 'old' } }) }));
vi.mock('@/-session/SessionView', () => ({ SessionView: 'SessionView' }));

import { navigateToSession } from '@/hooks/useNavigateToSession';
import SessionRoute from '@/app/(app)/session/[id]';
import RetiredPersonalRoute from '@/app/(app)/personal';

beforeEach(() => {
    vi.clearAllMocks();
    state.sessions = { old: { id: 'old', metadata: { flavor: 'personal', codexThreadId: 'misleading', claudeSessionId: 'misleading' } } };
});

describe('retired Personal navigation', () => {
    it('routes known legacy sessions to Bots without changing history or local settings', () => {
        const router = { navigate: vi.fn(), canDismiss: vi.fn(), dismissTo: vi.fn() };
        const before = JSON.stringify(state.sessions);
        navigateToSession(router as any, 'old');
        expect(router.navigate).toHaveBeenCalledExactlyOnceWith('/bots');
        expect(router.canDismiss).not.toHaveBeenCalled();
        expect(JSON.stringify(state.sessions)).toBe(before);
    });

    it('redirects old deep links without mounting the coding conversation', async () => {
        let tree: any;
        await act(async () => { tree = TestRenderer.create(<SessionRoute />); });
        expect(tree.root.findByType('Redirect').props.href).toBe('/bots');
        expect(tree.root.findAllByType('SessionView')).toHaveLength(0);
        await act(async () => tree.unmount());
    });

    it('redirects the old standalone route to Bots', async () => {
        let tree: any;
        await act(async () => { tree = TestRenderer.create(<RetiredPersonalRoute />); });
        expect(tree.root.findByType('Redirect').props.href).toBe('/bots');
        await act(async () => tree.unmount());
    });

    it('retains ordinary navigation for supported sessions', () => {
        state.sessions.code = { id: 'code', metadata: { flavor: 'codex' } };
        const router = { navigate: vi.fn() };
        navigateToSession(router as any, 'code');
        expect(router.navigate).toHaveBeenCalledWith('/session/code');
    });
});
