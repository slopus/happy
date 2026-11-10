import * as React from 'react';
import { act } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AttachmentSourceSheet } from './AttachmentSourceSheet';

// @ts-expect-error react-test-renderer has no declarations in this workspace.
import TestRenderer from 'react-test-renderer';

vi.mock('react-native', () => ({
    Pressable: 'Pressable',
    StyleSheet: { create: (styles: object) => styles },
    Text: 'Text',
    View: 'View',
}));
vi.mock('@expo/vector-icons', () => ({ Ionicons: 'Ionicons' }));
vi.mock('@/text', () => ({ t: (key: string) => key }));
vi.mock('react-native-unistyles', () => ({
    useUnistyles: () => ({
        theme: {
            colors: {
                divider: '#333',
                surface: '#111',
                surfaceHigh: '#222',
                text: '#fff',
            },
        },
    }),
}));

describe('AttachmentSourceSheet', () => {
    afterEach(() => vi.useRealTimers());

    it('shows the file source and opens it after closing the sheet', () => {
        (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
        vi.useFakeTimers();
        const onPickPhoto = vi.fn();
        const onPickFiles = vi.fn();
        const onClose = vi.fn();

        let renderer: any;
        act(() => {
            renderer = TestRenderer.create(
                <AttachmentSourceSheet
                    onPickPhoto={onPickPhoto}
                    onPickFiles={onPickFiles}
                    onClose={onClose}
                />,
            );
        });

        const cards = renderer.root.findAllByType('Pressable');
        expect(cards).toHaveLength(2);
        expect(cards[1].props.accessibilityLabel).toBe('imageUpload.chooseSourceFiles');

        act(() => {
            cards[1].props.onPress();
            vi.advanceTimersByTime(50);
        });

        expect(onClose).toHaveBeenCalledTimes(1);
        expect(onPickFiles).toHaveBeenCalledTimes(1);
        expect(onPickPhoto).not.toHaveBeenCalled();
        act(() => renderer.unmount());
    });
});
