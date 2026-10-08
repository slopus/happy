import * as React from 'react';
import { act } from 'react';
import { describe, expect, it, vi } from 'vitest';
// @ts-expect-error react-test-renderer does not publish declarations.
import TestRenderer from 'react-test-renderer';
import { useVisibleSessionListViewData } from './useVisibleSessionListViewData';

const fixtures = vi.hoisted(() => ({
    data: null as any,
}));

vi.mock('@/sync/storage', () => ({
    useSessionListViewData: () => fixtures.data,
    useSetting: () => false,
}));

function Result({ value }: { value: unknown }) {
    return <View value={value} />;
}

function View(_props: { value: unknown }) {
    return null;
}

function renderVisibleRows() {
    let renderer: TestRenderer.ReactTestRenderer;
    function Subject() {
        return <Result value={useVisibleSessionListViewData()} />;
    }
    act(() => { renderer = TestRenderer.create(<Subject />); });
    return renderer!;
}

describe('useVisibleSessionListViewData', () => {
    it('keeps lifecycle-archived sessions out of the shared Projects, Lists, and Timeline source', () => {
        fixtures.data = [
            { type: 'active-sessions', sessions: [
                { id: 'online', active: true, archived: false },
                { id: 'disconnected', active: false, archived: false },
                { id: 'app', application: { appId: 'advisor', bindingId: 'binding' } },
            ] },
            { type: 'project-group', displayPath: '~/paws', machine: { id: 'mac' } },
            { type: 'session', session: { id: 'archived', archived: true } },
        ];

        const renderer = renderVisibleRows();

        expect(renderer.root.findByType(View).props.value).toEqual([
            { type: 'active-sessions', sessions: [
                { id: 'online', active: true, archived: false },
                { id: 'disconnected', active: false, archived: false },
            ] },
        ]);
        act(() => renderer.unmount());
    });
});
