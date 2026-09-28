import * as React from 'react';
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MainView } from './MainView';

// react-test-renderer 没有发布 TypeScript 类型；测试只使用 create/unmount。
// @ts-expect-error 测试只依赖这里使用的最小 API。
import TestRenderer from 'react-test-renderer';

const mocks = vi.hoisted(() => ({
    isTablet: false,
    sessionListData: [] as any[],
}));

vi.mock('react-native', () => ({
    ActivityIndicator: 'ActivityIndicator',
    View: 'View',
}));
vi.mock('react-native-unistyles', () => ({
    StyleSheet: {
        create: (factory: unknown) => typeof factory === 'function'
            ? (factory as (theme: any) => object)({
                colors: {
                    groupped: { background: '#111' },
                    header: { tint: '#fff' },
                    textSecondary: '#888',
                },
            })
            : factory,
    },
    useUnistyles: () => ({
        theme: {
            colors: {
                groupped: { background: '#111' },
                textSecondary: '#888',
            },
        },
    }),
}));
vi.mock('@/sync/storage', () => ({
    useRealtimeStatus: () => 'disconnected',
}));
vi.mock('@/hooks/useVisibleSessionListViewData', () => ({
    useVisibleSessionListViewData: () => mocks.sessionListData,
}));
vi.mock('@/utils/responsive', () => ({
    useIsTablet: () => mocks.isTablet,
}));
vi.mock('@/constants/Typography', () => ({
    Typography: { default: () => ({}) },
}));
vi.mock('./EmptySessionsTablet', () => ({ EmptySessionsTablet: 'EmptySessionsTablet' }));
vi.mock('./SessionsList', () => ({ SessionsList: 'SessionsList' }));
vi.mock('./EmptyMainScreen', () => ({ EmptyMainScreen: 'EmptyMainScreen' }));
vi.mock('./ComposeHome', () => ({ ComposeHome: 'ComposeHome' }));
vi.mock('./VoiceAssistantStatusBar', () => ({ VoiceAssistantStatusBar: 'VoiceAssistantStatusBar' }));

describe('MainView 首页内容', () => {
    const originalConsoleError = console.error;
    let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
        mocks.isTablet = false;
        mocks.sessionListData = [];
        (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
        consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation((...values: unknown[]) => {
            if (values[0] === 'react-test-renderer is deprecated. See https://react.dev/warnings/react-test-renderer') return;
            originalConsoleError(...values);
        });
    });

    afterEach(() => consoleErrorSpy.mockRestore());

    it.each([
        ['窄屏', false],
        ['宽屏', true],
    ])('%s都渲染包含粒子背景的 ComposeHome', (_label, isTablet) => {
        mocks.isTablet = isTablet;
        let renderer: any;

        act(() => {
            renderer = TestRenderer.create(<MainView variant="phone" />);
        });

        expect(renderer.root.findAllByType('ComposeHome')).toHaveLength(1);
        expect(renderer.root.findAllByType('EmptyMainScreen')).toHaveLength(0);
        act(() => renderer.unmount());
    });

    it.each(['projects', 'time'] as const)('passes the translucent sidebar through %s mode', (sessionListLayout) => {
        mocks.sessionListData = [{ type: 'active-sessions', sessions: [] }];
        let renderer: any;
        act(() => { renderer = TestRenderer.create(<MainView variant="sidebar" sessionListLayout={sessionListLayout} transparentSidebar />); });
        expect(renderer.root.findByType('SessionsList').props).toMatchObject({ layoutMode: sessionListLayout, transparentSidebar: true });
        act(() => renderer.unmount());
    });

    it('keeps the DreamSkin empty sidebar transparent and the default sidebar opaque', () => {
        let renderer: any;
        act(() => { renderer = TestRenderer.create(<MainView variant="sidebar" transparentSidebar />); });
        const empty = renderer.root.findByType('EmptySessionsTablet');
        expect(empty.parent.props.style[1]).toBe(false);
        act(() => renderer.unmount());

        act(() => { renderer = TestRenderer.create(<MainView variant="sidebar" />); });
        expect(renderer.root.findByType('EmptySessionsTablet').parent.props.style[1].backgroundColor).toBe('#111');
        act(() => renderer.unmount());
    });
});
