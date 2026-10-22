import * as React from 'react';
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
// @ts-expect-error renderer declarations are optional for this harness.
import TestRenderer from 'react-test-renderer';
const fixture = vi.hoisted(() => ({
    sessions: {} as Record<string, any>, listeners: new Set<() => void>(),
    router: { canDismiss: vi.fn(() => true), dismissTo: vi.fn(), navigate: vi.fn() },
}));
vi.mock('react-native', () => ({ Platform: { OS: 'android', select: (options: Record<string, unknown>) => options.android ?? options.default }, Pressable: 'Pressable', View: 'View' }));
vi.mock('expo-router', () => ({ useRouter: () => fixture.router }));
vi.mock('@expo/vector-icons', () => ({ Ionicons: 'Ionicons' }));
vi.mock('./StyledText', () => ({ Text: 'Text' }));
vi.mock('@/track', () => ({ trackSessionSwitched: vi.fn() }));
vi.mock('@/sync/storage', async () => {
    const React = await import('react');
    return { storage: { getState: () => ({ sessions: fixture.sessions }) },
        useSession: (id: string) => React.useSyncExternalStore(listener => {
            fixture.listeners.add(listener); return () => fixture.listeners.delete(listener);
        }, () => fixture.sessions[id]) };
});
vi.mock('react-native-unistyles', async () => {
    const { appThemes } = await import('@/themePacks'); const theme = appThemes.ginghamDark;
    return { StyleSheet: { create: (factory: any) => factory(theme) }, useUnistyles: () => ({ theme }) };
});
import { IndependentSessionCard } from './IndependentSessionCard';
import { parseMarkdown } from './markdown/parseMarkdown';
let renderer: TestRenderer.ReactTestRenderer | undefined;
const text = () => renderer!.root.findAllByType('Text').map((node: any) => node.props.children).join(' ');
const update = (id: string, session: unknown) => act(() => {
    fixture.sessions = { ...fixture.sessions, [id]: session }; for (const listener of fixture.listeners) listener();
});
beforeEach(() => {
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
    fixture.sessions = {}; fixture.listeners.clear(); vi.clearAllMocks(); fixture.router.canDismiss.mockReturnValue(true);
});
afterEach(() => { act(() => renderer?.unmount()); renderer = undefined; });
describe('Android independent session cards', () => {
    it('renders two parsed cards and uses the real native navigation hook for each target', async () => {
        const blocks = parseMarkdown(['alpha', 'beta'].map(id => `<happy-session>\n${JSON.stringify({ sessionId: id, title: `Task ${id}` })}\n</happy-session>`).join('\n'));
        await act(async () => { renderer = TestRenderer.create(<>{blocks.map((block, index) => block.type === 'session-link' ? <IndependentSessionCard link={block.link} key={index} /> : null)}</>); });
        const cards = renderer!.root.findAllByType('Pressable'); expect(cards).toHaveLength(2);
        act(() => cards[0].props.onPress());
        expect(fixture.router.dismissTo).toHaveBeenLastCalledWith('/');
        expect(fixture.router.navigate).toHaveBeenLastCalledWith('/session/alpha');
        act(() => cards[1].props.onPress()); expect(fixture.router.navigate).toHaveBeenLastCalledWith('/session/beta');
        expect(fixture.router.dismissTo.mock.invocationCallOrder[0]).toBeLessThan(fixture.router.navigate.mock.invocationCallOrder[0]);
    });
    it('updates syncing, running, permission and completion states without browser APIs', async () => {
        await act(async () => { renderer = TestRenderer.create(<IndependentSessionCard link={{ sessionId: 'alpha', title: 'Task alpha' }} />); });
        expect(text()).toContain('正在同步会话');
        update('alpha', { thinking: true, agentState: { turnStatus: { status: 'running' } } }); expect(text()).toContain('处理中');
        update('alpha', { thinking: true, agentState: { requests: { approval: { tool: 'exec' } } } }); expect(text()).toContain('等待操作');
        update('alpha', { thinking: false, agentState: { turnStatus: { status: 'completed' } } }); expect(text()).toContain('已完成');
    });
    it('opens a child from native home without dismissing an empty stack', async () => {
        fixture.router.canDismiss.mockReturnValue(false);
        await act(async () => { renderer = TestRenderer.create(<IndependentSessionCard link={{ sessionId: 'alpha', title: 'Task alpha' }} />); });
        act(() => renderer!.root.findByType('Pressable').props.onPress());
        expect(fixture.router.dismissTo).not.toHaveBeenCalled(); expect(fixture.router.navigate).toHaveBeenCalledWith('/session/alpha');
    });
});
