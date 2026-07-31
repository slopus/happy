import * as React from 'react';
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SessionHeaderChip } from './SessionHeaderChip';

// @ts-expect-error react-test-renderer has no declarations in this workspace.
import TestRenderer from 'react-test-renderer';

vi.mock('react-native', () => ({
    View: 'View',
    Text: 'Text',
    Pressable: 'Pressable',
}));
vi.mock('@expo/vector-icons', () => ({ Ionicons: 'Ionicons' }));
vi.mock('@/text', () => ({ t: (key: string) => key }));
vi.mock('@/constants/Typography', () => ({
    Typography: { default: () => ({}), mono: () => ({}) },
}));
vi.mock('react-native-unistyles', () => {
    const theme = {
        colors: {
            divider: '#ddd',
            surface: '#fff',
            text: '#111',
            textSecondary: '#666',
            status: { connected: '#0a0', disconnected: '#a00' },
        },
    };
    return {
        StyleSheet: {
            hairlineWidth: 1,
            create: (factory: unknown) => {
                const styles = typeof factory === 'function'
                    ? (factory as (value: typeof theme) => object)(theme)
                    : factory;
                return { ...styles as object, useVariants: vi.fn() };
            },
        },
        useUnistyles: () => ({ theme }),
    };
});

describe('SessionHeaderChip connection semantics', () => {
    const originalConsoleError = console.error;
    let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
        (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
        consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation((...values: unknown[]) => {
            if (values[0] === 'react-test-renderer is deprecated. See https://react.dev/warnings/react-test-renderer') return;
            originalConsoleError(...values);
        });
    });

    afterEach(() => consoleErrorSpy.mockRestore());

    it.each([
        { online: true, status: 'status.online' },
        { online: false, status: 'status.offline' },
    ])('renders and announces $status instead of relying on dot color', ({ online, status }) => {
        let renderer: any;
        act(() => {
            renderer = TestRenderer.create(
                <SessionHeaderChip
                    agentLabel="codex"
                    machineName="Mac mini"
                    online={online}
                    open={false}
                    onPress={vi.fn()}
                />,
            );
        });

        const chip = renderer.root.findByProps({ testID: 'session-header-chip' });
        expect(chip.props.accessibilityRole).toBe('button');
        expect(chip.props.accessibilityState).toEqual({ expanded: false });
        expect(chip.props.accessibilityLabel).toBe(`codex, ${status}, Mac mini`);
        expect(chip.findAllByType('Text').some((node: any) => node.props.children === status)).toBe(true);

        act(() => renderer.unmount());
    });

    it.each([
        { online: true, status: 'status.online' },
        { online: false, status: 'status.offline' },
    ])('keeps $status visible and full metadata accessible in compact desktop layout', ({ online, status }) => {
        let renderer: any;
        act(() => {
            renderer = TestRenderer.create(
                <SessionHeaderChip
                    agentLabel="codex"
                    compact
                    machineName="Mac mini"
                    online={online}
                    open={false}
                    onPress={vi.fn()}
                />,
            );
        });

        const chip = renderer.root.findByProps({ testID: 'session-header-chip' });
        expect(chip.props.accessibilityLabel).toBe(`codex, ${status}, Mac mini`);
        expect(chip.findAllByType('Text').map((node: any) => node.props.children)).toEqual(['codex', status]);

        act(() => renderer.unmount());
    });

    it('keeps the agent identity visible while the machine label takes the remaining width', () => {
        let renderer: any;
        act(() => {
            renderer = TestRenderer.create(
                <SessionHeaderChip
                    agentLabel="codex"
                    machineName="192.168.100.100"
                    online
                    open={false}
                    onPress={vi.fn()}
                />,
            );
        });

        const texts = renderer.root.findAllByType('Text');
        const agent = texts.find((node: any) => node.props.children === 'codex');
        const machine = texts.find((node: any) => node.props.children === '192.168.100.100');

        expect(agent?.props.style).toMatchObject({ flexShrink: 0 });
        expect(machine?.props).toMatchObject({ numberOfLines: 1, ellipsizeMode: 'tail' });
        expect(machine?.props.style).toMatchObject({ flex: 1, minWidth: 0, flexShrink: 1 });

        act(() => renderer.unmount());
    });
});
