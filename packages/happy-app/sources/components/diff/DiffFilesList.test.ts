import * as React from 'react';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('react-native', async () => {
    const ReactModule = await import('react');
    const host = (name: string) => (props: any) =>
        ReactModule.createElement(name, props, props.children);
    return {
        ActivityIndicator: host('ActivityIndicator'),
        Platform: { OS: 'ios' },
        Pressable: host('Pressable'),
        Text: host('Text'),
        View: host('View'),
    };
});

const listMocks = vi.hoisted(() => ({
    scrollToIndex: vi.fn(),
}));

vi.mock('@shopify/flash-list', async () => {
    const ReactModule = await import('react');
    const FlashList = ReactModule.forwardRef((props: any, ref: any) => {
        ReactModule.useImperativeHandle(ref, () => ({ scrollToIndex: listMocks.scrollToIndex }));
        return ReactModule.createElement(
            'FlashList',
            props,
            props.data.map((item: any, index: number) => ReactModule.createElement(
                ReactModule.Fragment,
                { key: item.key ?? item.path ?? index },
                props.renderItem({ item, index }),
            )),
        );
    });
    return { FlashList };
});

vi.mock('@/constants/Typography', () => ({
    Typography: { default: () => ({}), mono: () => ({}) },
}));

vi.mock('@/text', () => ({
    t: (key: string) => key,
}));

vi.mock('@/components/layout', () => ({
    layout: { maxWidth: 1200 },
}));

vi.mock('./DiffPalette', () => ({
    useDiffPalette: () => ({
        surface: '#ffffff',
        divider: '#e1e4e8',
        textSecondary: '#586069',
        text: '#24292e',
        hunkBg: '#f1f8ff',
    }),
}));

vi.mock('./DiffFileHeader', async () => {
    const ReactModule = await import('react');
    return {
        DiffFileHeader: (props: any) => ReactModule.createElement(
            'DiffFileHeader',
            props,
            ReactModule.createElement(
                'Pressable',
                { onPress: props.onToggle },
                props.collapsed ? 'collapsed' : 'expanded',
            ),
        ),
    };
});

vi.mock('./DiffFileView', async () => {
    const ReactModule = await import('react');
    return {
        DiffFileView: (props: any) => ReactModule.createElement('DiffFileView', props),
    };
});

vi.mock('./DiffImageView', async () => {
    const ReactModule = await import('react');
    return {
        DiffImageView: (props: any) => ReactModule.createElement('DiffImageView', props),
    };
});

import { DiffFilesList, type DiffFileItem } from './DiffFilesList';

beforeAll(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

const baseItem = (overrides: Partial<DiffFileItem> = {}): DiffFileItem => ({
    path: 'src/example.ts',
    kind: 'modified',
    additions: 1,
    deletions: 1,
    source: null,
    ...overrides,
});

function render(props: Record<string, unknown>): ReactTestRenderer {
    let renderer!: ReactTestRenderer;
    act(() => {
        renderer = create(React.createElement(DiffFilesList, {
            items: [baseItem()],
            ...props,
        }));
    });
    return renderer;
}

function textOf(node: any): string {
    if (node === null || node === undefined || typeof node === 'boolean') return '';
    if (typeof node === 'string' || typeof node === 'number') return String(node);
    if (Array.isArray(node)) return node.map(textOf).join('');
    return node.props ? textOf(node.props.children) : '';
}

describe('DiffFilesList — lazy content requests', () => {
    it('does not request a collapsed file', () => {
        const request = vi.fn();
        render({ defaultCollapsed: true, onRequestContent: request });

        expect(request).not.toHaveBeenCalled();
    });

    it('requests content once when a file is expanded', () => {
        const request = vi.fn();
        const tree = render({ defaultCollapsed: true, onRequestContent: request });
        const header = tree.root.findAllByType('Pressable')[0];

        act(() => {
            header.props.onPress();
        });

        expect(request).toHaveBeenCalledTimes(1);
        expect(request).toHaveBeenCalledWith('src/example.ts');
    });

    it('does not repeat a request for rerenders with the same unavailable item', () => {
        const request = vi.fn();
        const item = baseItem();
        const props = { items: [item], onRequestContent: request };
        const tree = render(props);

        expect(request).toHaveBeenCalledTimes(1);
        act(() => {
            tree.update(React.createElement(DiffFilesList, props));
        });

        expect(request).toHaveBeenCalledTimes(1);
    });

    it('does not request files that already have a source, error, or message', () => {
        const cases: DiffFileItem[] = [
            baseItem({ source: { kind: 'patch', patch: '' } }),
            baseItem({ error: 'Could not load file' }),
            baseItem({ message: 'File contents match the comparison base.' }),
        ];

        for (const item of cases) {
            const request = vi.fn();
            let tree!: ReactTestRenderer;
            act(() => {
                tree = create(React.createElement(DiffFilesList, {
                    items: [item],
                    onRequestContent: request,
                }));
            });
            expect(request).not.toHaveBeenCalled();
            act(() => {
                tree.unmount();
            });
        }
    });
});

describe('DiffFilesList — scroll to file', () => {
    let rafCallbacks: Array<() => void>;
    beforeEach(() => {
        listMocks.scrollToIndex.mockReset();
        rafCallbacks = [];
        vi.stubGlobal('requestAnimationFrame', (cb: () => void) => {
            rafCallbacks.push(cb);
            return rafCallbacks.length;
        });
        vi.stubGlobal('cancelAnimationFrame', (id: number) => {
            rafCallbacks[id - 1] = () => undefined;
        });
    });
    afterEach(() => {
        vi.unstubAllGlobals();
    });
    const flushFrames = () => {
        const pending = rafCallbacks.splice(0);
        act(() => {
            for (const cb of pending) cb();
        });
    };

    it('scrolls once to the target and not again when other files load content', () => {
        const target = baseItem({ path: 'src/target.ts' });
        const other = baseItem({ path: 'src/other.ts' });
        const tree = render({ items: [target, other], scrollToPath: 'src/target.ts' });
        flushFrames();
        expect(listMocks.scrollToIndex).toHaveBeenCalledTimes(1);
        expect(listMocks.scrollToIndex).toHaveBeenCalledWith({ index: 0, animated: true });

        // A lazily loaded body for an unrelated file gives items a new identity.
        act(() => {
            tree.update(React.createElement(DiffFilesList, {
                items: [target, { ...other, source: { kind: 'patch', patch: '' } }],
                scrollToPath: 'src/target.ts',
            }));
        });
        flushFrames();
        expect(listMocks.scrollToIndex).toHaveBeenCalledTimes(1);
    });

    it('waits for the target to appear, then scrolls, then follows a new target', () => {
        const other = baseItem({ path: 'src/other.ts' });
        const tree = render({ items: [other], scrollToPath: 'src/later.ts' });
        flushFrames();
        expect(listMocks.scrollToIndex).not.toHaveBeenCalled();

        const later = baseItem({ path: 'src/later.ts' });
        act(() => {
            tree.update(React.createElement(DiffFilesList, {
                items: [other, later],
                scrollToPath: 'src/later.ts',
            }));
        });
        flushFrames();
        expect(listMocks.scrollToIndex).toHaveBeenCalledExactlyOnceWith({ index: 1, animated: true });

        act(() => {
            tree.update(React.createElement(DiffFilesList, {
                items: [other, later],
                scrollToPath: 'src/other.ts',
            }));
        });
        flushFrames();
        expect(listMocks.scrollToIndex).toHaveBeenCalledTimes(2);
        expect(listMocks.scrollToIndex).toHaveBeenLastCalledWith({ index: 0, animated: true });
    });

    it('retries when a frame is cancelled before it fires', () => {
        const target = baseItem({ path: 'src/target.ts' });
        const tree = render({ items: [target], scrollToPath: 'src/target.ts' });
        // Items change before the frame runs, so the effect cleanup cancels it.
        act(() => {
            tree.update(React.createElement(DiffFilesList, {
                items: [{ ...target, source: { kind: 'patch', patch: '' } }],
                scrollToPath: 'src/target.ts',
            }));
        });
        flushFrames();
        expect(listMocks.scrollToIndex).toHaveBeenCalledTimes(1);
    });
});

describe('DiffFilesList — body messages', () => {
    it('gives an actual error precedence over informational copy', () => {
        const tree = render({
            items: [baseItem({ error: 'Actual load failure', message: 'Informational message' })],
        });
        const texts = tree.root.findAllByType('Text').map((node: any) => textOf(node.props.children));

        expect(texts).toContain('Actual load failure');
        expect(texts).not.toContain('Informational message');
    });

    it('shows no text changes when a contents source has no hunks', () => {
        const tree = render({
            items: [baseItem({
                source: { kind: 'contents', path: 'src/example.ts', oldText: 'same\n', newText: 'same\n' },
            })],
        });
        const texts = tree.root.findAllByType('Text').map((node: any) => textOf(node.props.children));

        expect(texts).toContain('diff.noChanges');
        expect(tree.root.findAllByType('DiffFileView')).toHaveLength(0);
    });

    it('shows a contents build error instead of reporting no changes', () => {
        const tree = render({
            items: [baseItem({
                source: {
                    kind: 'contents',
                    path: 'src/example.ts',
                    oldText: 'old\n',
                    newText: 'new\n',
                    diffBudget: { timeoutMs: 50, maxEditLength: 0 },
                },
            })],
        });
        const texts = tree.root.findAllByType('Text').map((node: any) => textOf(node.props.children));

        expect(texts).toContain('Diff is too large to render on this device.');
        expect(texts).not.toContain('diff.noChanges');
    });
});