import * as React from 'react';
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { StreamingMarkdownView } from './StreamingMarkdownView';

// react-test-renderer does not publish TypeScript declarations with the package.
// @ts-expect-error The test only needs create, update, find, and unmount.
import TestRenderer from 'react-test-renderer';

vi.mock('react-native', () => ({ View: 'View' }));
vi.mock('@/components/markdown/MarkdownView', () => ({ MarkdownView: 'MarkdownView' }));

describe('StreamingMarkdownView', () => {
    const originalConsoleError = console.error;
    let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
        vi.useFakeTimers();
        vi.setSystemTime(1_000);
        (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
        consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation((...values: unknown[]) => {
            if (values[0] === 'react-test-renderer is deprecated. See https://react.dev/warnings/react-test-renderer') return;
            originalConsoleError(...values);
        });
    });

    afterEach(() => {
        consoleErrorSpy.mockRestore();
        vi.useRealTimers();
    });

    it('shows the first chunk immediately and coalesces later chunks without losing the latest text', () => {
        let renderer: any;
        act(() => {
            renderer = TestRenderer.create(<StreamingMarkdownView markdown="**先" />);
        });

        expect(renderer.root.findByType('MarkdownView').props.markdown).toBe('**先**');

        act(() => {
            renderer.update(<StreamingMarkdownView markdown="**先别" />);
            renderer.update(<StreamingMarkdownView markdown="**先别追问" />);
        });
        expect(renderer.root.findByType('MarkdownView').props.markdown).toBe('**先**');

        act(() => vi.advanceTimersByTime(40));
        expect(renderer.root.findByType('MarkdownView').props.markdown).toBe('**先别追问**');

        act(() => renderer.unmount());
    });
});
