import * as React from 'react';
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// @ts-expect-error react-test-renderer has no declarations in this workspace.
import TestRenderer from 'react-test-renderer';

const clipboard = vi.hoisted(() => ({ setStringAsync: vi.fn() }));

vi.mock('react-native', () => ({
    Pressable: 'Pressable',
    Text: 'Text',
    View: 'View',
}));
vi.mock('@expo/vector-icons', () => ({ Ionicons: 'Ionicons' }));
vi.mock('expo-clipboard', () => clipboard);
vi.mock('@/text', () => ({ t: (key: string) => key }));
vi.mock('react-native-unistyles', () => ({
    useUnistyles: () => ({
        theme: {
            colors: {
                divider: '#333',
                success: '#0a0',
                status: { connected: '#0a0', error: '#c00' },
                surfaceHighest: '#222',
                surfacePressed: '#292929',
                text: '#fff',
                textSecondary: '#aaa',
            },
        },
    }),
    StyleSheet: {
        create: (factory: any) => factory({
            colors: {
                divider: '#333',
                success: '#0a0',
                status: { connected: '#0a0', error: '#c00' },
                surfaceHighest: '#222',
                surfacePressed: '#292929',
                text: '#fff',
                textSecondary: '#aaa',
            },
        }),
    },
}));

import { CodeBlockCopyButton } from './CodeBlockCopyButton';

describe('CodeBlockCopyButton', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        clipboard.setStringAsync.mockReset().mockResolvedValue(undefined);
        (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    });

    afterEach(() => {
        vi.useRealTimers();
        delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
    });

    it('announces a successful copy and returns to idle after 1.8 seconds', async () => {
        let renderer: any;
        act(() => {
            renderer = TestRenderer.create(<CodeBlockCopyButton content={'pnpm test\n'} visible />);
        });

        const button = renderer.root.findByProps({ testID: 'markdown-code-copy' });
        expect(button.props.accessibilityLabel).toBe('common.copy');
        expect(button.findByType('Ionicons').props.name).toBe('copy-outline');

        await act(async () => button.props.onPress());

        expect(clipboard.setStringAsync).toHaveBeenCalledWith('pnpm test\n');
        expect(button.props.accessibilityLabel).toBe('common.copied');
        expect(button.findByType('Ionicons').props.name).toBe('checkmark');
        const feedback = renderer.root.findByProps({ testID: 'markdown-code-copy-feedback' });
        expect(feedback.props.accessibilityLiveRegion).toBe('polite');
        expect(feedback.props.children).toBe('common.copied');

        act(() => vi.advanceTimersByTime(1_800));

        expect(button.props.accessibilityLabel).toBe('common.copy');
        expect(button.findByType('Ionicons').props.name).toBe('copy-outline');
        expect(renderer.root.findAllByProps({ testID: 'markdown-code-copy-feedback' })).toHaveLength(0);

        act(() => renderer.unmount());
    });

    it('announces a failed copy without reporting success', async () => {
        clipboard.setStringAsync.mockRejectedValueOnce(new Error('clipboard denied'));
        const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
        let renderer: any;
        act(() => {
            renderer = TestRenderer.create(<CodeBlockCopyButton content="secret" visible />);
        });

        const button = renderer.root.findByProps({ testID: 'markdown-code-copy' });
        await act(async () => button.props.onPress());

        expect(button.props.accessibilityLabel).toBe('markdown.copyFailed');
        expect(button.findByType('Ionicons').props.name).toBe('alert-circle-outline');
        const feedback = renderer.root.findByProps({ testID: 'markdown-code-copy-feedback' });
        expect(feedback.props.accessibilityLiveRegion).toBe('polite');
        expect(feedback.props.children).toBe('markdown.copyFailed');
        expect(renderer.root.findAllByProps({ children: 'common.copied' })).toHaveLength(0);

        act(() => vi.advanceTimersByTime(1_800));

        expect(button.props.accessibilityLabel).toBe('common.copy');
        expect(button.findByType('Ionicons').props.name).toBe('copy-outline');

        consoleError.mockRestore();
        act(() => renderer.unmount());
    });
});
