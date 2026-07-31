import * as React from 'react';
import { act } from 'react';
import { View } from 'react-native';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CapabilityBlockCard } from './CapabilityBlockCard';

// @ts-expect-error react-test-renderer has no declarations in this workspace.
import TestRenderer from 'react-test-renderer';

vi.mock('react-native', () => ({
    Pressable: 'Pressable',
    Text: 'Text',
    View: 'View',
}));
vi.mock('react-native-unistyles', () => {
    const theme = {
        colors: {
            divider: '#333333',
            surface: '#111111',
            surfaceHigh: '#222222',
            text: '#ffffff',
            textSecondary: '#888888',
        },
    };

    return {
        StyleSheet: {
            create: (factory: (value: typeof theme) => object) => factory(theme),
        },
        useUnistyles: () => ({ theme }),
    };
});

describe('CapabilityBlockCard desktop grid layout', () => {
    let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
        (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
        consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    });

    afterEach(() => consoleErrorSpy.mockRestore());

    it.each(['Session Actions', 'Generated Images'])('keeps the full %s title readable in the two-column card', (title) => {
        let renderer: any;
        act(() => {
            renderer = TestRenderer.create(
                <CapabilityBlockCard
                    count={0}
                    icon={<View />}
                    preview={null}
                    title={title}
                />,
            );
        });

        const card = renderer.root.findByType('Pressable');
        const titleNode = renderer.root.findAllByType('Text')
            .find((node: any) => node.props.children === title);
        const cardStyle = card.props.style({ pressed: false });

        expect(cardStyle[0]).toMatchObject({ width: '48.5%' });
        expect(titleNode?.props).toMatchObject({ numberOfLines: 2 });
        expect(titleNode?.props.style[0]).toMatchObject({ lineHeight: 18, minHeight: 36 });

        act(() => renderer.unmount());
    });

    it('reserves the same two-line preview height with and without preview copy', () => {
        let withPreview: any;
        let withoutPreview: any;
        act(() => {
            withPreview = TestRenderer.create(
                <CapabilityBlockCard count={1} icon={<View />} preview="One line" title="Skills" />,
            );
            withoutPreview = TestRenderer.create(
                <CapabilityBlockCard count={0} icon={<View />} preview={null} title="Files" />,
            );
        });

        const preview = withPreview.root.findAllByType('Text')
            .find((node: any) => node.props.children === 'One line');
        const spacer = withoutPreview.root.findAllByType('View')
            .find((node: any) => node.props.style?.minHeight === 32);

        expect(preview?.props).toMatchObject({ numberOfLines: 2 });
        expect(preview?.props.style[0]).toMatchObject({ minHeight: 32 });
        expect(spacer?.props.style).toMatchObject({ minHeight: 32 });

        act(() => {
            withPreview.unmount();
            withoutPreview.unmount();
        });
    });
});
