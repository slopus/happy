import * as React from 'react';
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import TestRenderer from 'react-test-renderer';
import { BrowserStepsPanel } from './BrowserStepsPanel';
import { useImageViewerStore } from '@/sync/imageViewer';

const imageLoader = vi.hoisted(() => vi.fn(() => ({ loading: false, uri: null })));
const history = vi.hoisted(() => ({ sessionMessages: {} as Record<string, any> }));
vi.mock('@/sync/storage', () => ({ storage: { getState: () => history } }));

vi.mock('react-native', () => ({
    ActivityIndicator: 'ActivityIndicator',
    Image: 'Image',
    Pressable: 'Pressable',
    ScrollView: 'ScrollView',
    Text: 'Text',
    View: 'View',
}));
vi.mock('@expo/vector-icons', () => ({ Ionicons: 'Ionicons' }));
vi.mock('react-native-unistyles', () => ({
    StyleSheet: { create: (value: any) => typeof value === 'function' ? value() : value },
    useUnistyles: () => ({ theme: { colors: { divider: '#ddd', surface: '#fff', surfaceHigh: '#f4f4f4', surfaceSelected: '#eee', text: '#111', textSecondary: '#666' } } }),
}));
vi.mock('@/hooks/useAttachmentImage', () => ({ useAttachmentImage: imageLoader }));
vi.mock('@/text', () => ({
    t: (key: string, params?: { count?: number; current?: number; total?: number }) => ({
        'rightPanelCapabilityHub.browserProgress.timelineTitle': 'Localized timeline',
        'rightPanelCapabilityHub.browserProgress.liveCount': `Localized live ${params?.count}`,
        'rightPanelCapabilityHub.browserProgress.stepPosition': `Localized position ${params?.current}/${params?.total}`,
    }[key] ?? key),
}));

describe('BrowserStepsPanel', () => {
    let renderer: any;
    let consoleErrorSpy: ReturnType<typeof vi.spyOn>;
    const originalConsoleError = console.error;

    beforeEach(() => {
        (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
        consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation((...values: unknown[]) => {
            if (values[0] === 'react-test-renderer is deprecated. See https://react.dev/warnings/react-test-renderer') return;
            originalConsoleError(...values);
        });
    });

    afterEach(() => {
        if (renderer) act(() => renderer.unmount());
        renderer = undefined;
        consoleErrorSpy.mockRestore();
    });

    it('renders anonymous screenshots directly without private attachment loading', () => {
        imageLoader.mockClear();
        const onOpenImage = vi.fn();
        const ref = 'https://public.test/frame.png';
        act(() => { renderer = TestRenderer.create(<BrowserStepsPanel steps={[{
            id: 'public', createdAt: 1, label: 'Shared screenshot', name: 'frame.png', ref,
        }]} onOpenImage={onOpenImage} />); });
        expect(imageLoader).not.toHaveBeenCalled();
        expect(renderer.root.findAllByType('Image').map((node: any) => node.props.source.uri)).toEqual([ref, ref]);
        act(() => renderer.root.findByProps({ testID: 'browser-step-open-image' }).props.onPress());
        expect(onOpenImage).toHaveBeenCalledWith({ uri: ref, filename: 'frame.png', width: undefined, height: undefined });
    });

    it('keeps a long timeline inside its bounded scroll container', () => {
        const steps = Array.from({ length: 20 }, (_, index) => ({
            createdAt: index + 1,
            id: `step-${index + 1}`,
            label: `Step ${index + 1}`,
            name: `step-${index + 1}.png`,
            ref: `attachment://step-${index + 1}`,
        }));
        act(() => {
            renderer = TestRenderer.create(<BrowserStepsPanel sessionId="s1" steps={steps} onOpenImage={vi.fn()} />);
        });

        const scroll = renderer.root.findByProps({ testID: 'browser-steps-timeline-scroll' });
        expect(scroll.props.style).toEqual(expect.objectContaining({ flex: 1, minHeight: 0 }));
        expect(renderer.root.findAllByType('Pressable')).toHaveLength(21);
        expect(JSON.stringify(renderer.toJSON())).toContain('Localized timeline');
        expect(JSON.stringify(renderer.toJSON())).toContain('Localized live 20');
        expect(JSON.stringify(renderer.toJSON())).toContain('Localized position 20/20');
    });

    it('delegates unresolved browser images to the required run-scoped viewer, never the session gallery', () => {
        const onOpenImage = vi.fn();
        const previousGallery = useImageViewerStore.getState();
        const steps = [{ id: 'new', createdAt: 3, label: 'New run', name: 'new.png', ref: 'new' }];
        history.sessionMessages.s1 = { messages: [
            { id: 'new', createdAt: 3, kind: 'tool-call', children: [], tool: { name: 'file', input: { ref: 'new', name: 'new.png', source: 'browser_step' } } },
            { id: 'sent', createdAt: 2, kind: 'tool-call', children: [], tool: { name: 'file', input: { ref: 'sent', name: 'sent.png', source: 'generated' } } },
            { id: 'old', createdAt: 1, kind: 'tool-call', children: [], tool: { name: 'file', input: { ref: 'old', name: 'old.png', source: 'browser_step' } } },
        ] };
        act(() => { renderer = TestRenderer.create(<BrowserStepsPanel sessionId="s1" steps={steps} onOpenImage={onOpenImage} />); });
        act(() => renderer.root.findByProps({ testID: 'browser-step-open-image' }).props.onPress());
        expect(onOpenImage).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 's1', attachmentRef: 'new', uri: '' }));
        expect(useImageViewerStore.getState()).toBe(previousGallery);
    });
});
