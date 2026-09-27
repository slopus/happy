import * as React from 'react';
import { act } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
// @ts-expect-error renderer is a test-only dependency without declarations.
import TestRenderer from 'react-test-renderer';
import { SessionsListWrapper } from './SessionsListWrapper';
import { useSessionListSyncState } from '@/sync/sessionListSyncState';

const data = vi.hoisted(() => ({ rows: null as unknown[] | null }));
vi.mock('react-native', () => ({ View: 'View', ActivityIndicator: 'ActivityIndicator', Pressable: 'Pressable' }));
vi.mock('react-native-unistyles', () => ({
    StyleSheet: { create: (fn: any) => fn({ colors: { groupped: { background: 'background' }, textSecondary: 'secondary', text: 'text', surface: 'surface', surfacePressed: 'pressed' } }) },
    useUnistyles: () => ({ theme: { colors: { textSecondary: 'secondary' } } }),
}));
vi.mock('@/hooks/useVisibleSessionListViewData', () => ({ useVisibleSessionListViewData: () => data.rows }));
vi.mock('./SessionsList', () => ({ SessionsList: () => React.createElement('Text', {}, 'Readable cached session') }));
vi.mock('./EmptyMainScreen', () => ({ EmptyMainScreen: () => React.createElement('Text', {}, 'empty') }));
vi.mock('./StyledText', () => ({ Text: 'Text' }));
vi.mock('@/text', () => ({ t: (key: string) => key }));
vi.mock('@/sync/sync', () => ({ sync: {
    bootstrapSessions: () => { useSessionListSyncState.setState({ bootstrap: 'loading' }); return Promise.resolve(); },
    loadNextSessionHistoryPage: () => { useSessionListSyncState.setState({ history: 'loading' }); return Promise.resolve(); },
} }));

describe('session list recovery', () => {
    let renderer: any;
    afterEach(() => { act(() => renderer?.unmount()); });
    it('replaces the unbounded empty spinner with an actionable failure and retries', () => {
        (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
        data.rows = null;
        useSessionListSyncState.setState({ bootstrap: 'error', history: 'idle' });
        act(() => { renderer = TestRenderer.create(<SessionsListWrapper />); });
        expect(renderer.root.findAllByType('ActivityIndicator')).toHaveLength(0);
        expect(renderer.root.findByProps({ children: 'sessionHistory.failedToRefreshSessions' })).toBeTruthy();
        const retry = renderer.root.findByProps({ accessibilityRole: 'button', accessibilityLabel: 'common.retry' });
        act(() => retry.props.onPress());
        expect(useSessionListSyncState.getState().bootstrap).toBe('loading');
        expect(renderer.root.findAllByType('ActivityIndicator')).toHaveLength(1);
    });
    it('keeps cached contents mounted through history loading, error and retry', () => {
        (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
        data.rows = [{}];
        useSessionListSyncState.setState({ bootstrap: 'ready', history: 'loading' });
        act(() => { renderer = TestRenderer.create(<SessionsListWrapper />); });
        const content = renderer.root.findByType('Text');
        act(() => useSessionListSyncState.setState({ history: 'error' }));
        expect(renderer.root.findAllByType('Text')).toContain(content);
        expect(renderer.root.findByProps({ children: 'sessionHistory.failedToLoadMore' })).toBeTruthy();
        expect(renderer.root.findAllByProps({ children: 'sessionHistory.failedToRefreshSessions' })).toHaveLength(0);
        const retry = renderer.root.findByProps({ accessibilityRole: 'button', accessibilityLabel: 'common.retry' });
        act(() => retry.props.onPress());
        expect(useSessionListSyncState.getState().history).toBe('loading');
        expect(renderer.root.findByType('Text')).toBe(content);
    });
    it('prioritizes bootstrap recovery when bootstrap and history both fail', () => {
        (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
        data.rows = [{}];
        useSessionListSyncState.setState({ bootstrap: 'error', history: 'error' });
        act(() => { renderer = TestRenderer.create(<SessionsListWrapper />); });
        expect(renderer.root.findByProps({ children: 'sessionHistory.failedToRefreshSessions' })).toBeTruthy();
        expect(renderer.root.findAllByProps({ children: 'sessionHistory.failedToLoadMore' })).toHaveLength(0);
        const retry = renderer.root.findByProps({ accessibilityRole: 'button', accessibilityLabel: 'common.retry' });
        act(() => retry.props.onPress());
        expect(useSessionListSyncState.getState()).toEqual({ bootstrap: 'loading', history: 'error' });
    });
});
