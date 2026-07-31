import * as React from 'react';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('react-native', async () => {
    const ReactModule = await import('react');
    const host = (name: string) => ReactModule.forwardRef((props: any, ref: any) => (
        ReactModule.createElement(name, { ...props, ref }, props.children)
    ));
    return {
        Platform: { OS: 'ios' },
        Text: host('Text'),
        TextInput: host('TextInput'),
        View: host('View'),
    };
});

vi.mock('react-native-unistyles', () => ({
    useUnistyles: () => ({
        theme: {
            colors: {
                input: {
                    placeholder: '#888888',
                    text: '#111111',
                },
            },
        },
    }),
}));

vi.mock('@/constants/Typography', () => ({
    Typography: { default: () => ({ fontFamily: 'System' }) },
}));

import { MultiTextInput } from './MultiTextInput';

const originalConsoleError = console.error;

beforeAll(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    vi.spyOn(console, 'error').mockImplementation((message?: unknown, ...args: unknown[]) => {
        if (typeof message === 'string' && message.startsWith('react-test-renderer is deprecated')) {
            return;
        }
        originalConsoleError(message, ...args);
    });
});

afterAll(() => {
    vi.restoreAllMocks();
});

describe('native MultiTextInput autosize opt-in', () => {
    it('keeps the legacy unconstrained wrapper when autosize is not requested', () => {
        let renderer!: ReactTestRenderer;
        act(() => {
            renderer = create(React.createElement(MultiTextInput, {
                value: 'A long value that can wrap onto another visual line',
            }));
        });

        expect(renderer.root.findAllByType('Text' as any)).toHaveLength(0);
        expect(renderer.root.findByType('View' as any).props.style).toEqual({ width: '100%' });
    });

    it('grows both the input and its wrapper from measured wrapped text', () => {
        let renderer!: ReactTestRenderer;
        act(() => {
            renderer = create(React.createElement(MultiTextInput, {
                value: 'A long value that wraps onto several visual lines',
                autoGrow: true,
            } as any));
        });

        const measurement = renderer.root.findByType('Text' as any);
        act(() => {
            measurement.props.onLayout({ nativeEvent: { layout: { height: 66 } } });
        });

        expect(renderer.root.findByType('View' as any).props.style).toEqual({ width: '100%', height: 66 });
        expect(renderer.root.findByType('TextInput' as any).props.style).toEqual(expect.arrayContaining([
            expect.objectContaining({ height: 66 }),
        ]));
    });
});
