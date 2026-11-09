import * as React from 'react';
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import TestRenderer from 'react-test-renderer';
import { CapabilityHubDetailView, SkillItemRow } from './CapabilityHubDetailView';
import { useImageViewerStore } from '@/sync/imageViewer';
import type { CapabilityItem } from './sessionCapabilityHubModel';

const mocks = vi.hoisted(() => ({
    sessionMessages: {} as Record<string, any>,
    theme: {
        colors: {
            divider: '#30343a',
            surface: '#1A2330',
            surfaceHigh: '#1F2A38',
            surfacePressed: '#1F2A38',
            text: '#E6EEF5',
            textSecondary: '#8FA2B0',
        },
    },
}));

vi.mock('react-native', () => ({
    ActivityIndicator: 'ActivityIndicator',
    Platform: { OS: 'web' },
    Pressable: 'Pressable',
    ScrollView: 'ScrollView',
    Text: 'Text',
    View: 'View',
}));
vi.mock('expo-image', () => ({ Image: 'Image' }));
vi.mock('expo-router', () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock('@expo/vector-icons', () => ({ Ionicons: 'Ionicons', Octicons: 'Octicons' }));
vi.mock('react-native-unistyles', () => ({
    StyleSheet: { create: (value: any) => typeof value === 'function' ? value(mocks.theme) : value },
    useUnistyles: () => ({ theme: mocks.theme }),
}));
vi.mock('@/hooks/useAttachmentImage', () => ({ useAttachmentImage: () => ({ loading: false, uri: 'blob:current' }) }));
vi.mock('@/sync/storage', () => ({ storage: { getState: () => mocks } }));
vi.mock('@/utils/openExternalUrl', () => ({ openExternalUrl: vi.fn() }));
vi.mock('@/utils/thumbhash', () => ({ thumbhashToDataUri: vi.fn() }));
vi.mock('@/text', () => ({
    getCurrentLanguage: () => 'en',
    t: (key: string) => ({
        'rightPanelCapabilityHub.browserProgress.view': 'View progress',
        'rightPanelCapabilityHub.meta.available': 'Available in session',
    }[key] ?? key),
}));
vi.mock('./BrowserStepsPopover', () => ({ BrowserStepsPopover: 'BrowserStepsPopover' }));

describe('SkillItemRow browser progress', () => {
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

    it.each(['image', 'taskResource'] as const)('opens %s resources with the full session image history', (kind) => {
        mocks.sessionMessages.s1 = { messages: ['current', 'older'].map((ref, index) => ({
            id: ref, createdAt: 2 - index, kind: 'tool-call', children: [], tool: { name: 'file', input: { ref, name: `${ref}.png` } },
        })) };
        const item: CapabilityItem = kind === 'image'
            ? { kind, id: 'current', title: 'current.png', meta: 'session', ref: 'current', messageId: 'current', createdAt: 2 }
            : { kind, id: 'current', title: 'current.png', meta: 'session', event: {
                id: 'current', kind: 'preview_created', sessionId: 's1', messageId: 'current', messageIds: ['current'], title: 'current.png',
                createdAt: 2, firstSeenAt: 2, occurrences: 1, resourceType: 'image', uri: 'current',
            } };
        act(() => { renderer = TestRenderer.create(<CapabilityHubDetailView count={1} items={[item]} onBack={() => {}} sessionId="s1" title="Images" type="images" />); });
        const imageButton = renderer.root.findAllByType('Pressable').find((node: any) => node.props.disabled === false);
        act(() => imageButton.props.onPress());
        expect(useImageViewerStore.getState().sources.map(source => source.attachmentRef)).toEqual(['older', 'current']);
        expect(useImageViewerStore.getState().index).toBe(1);
    });

    it('keeps installed Ego skills informational; progress belongs to the transcript', () => {
        act(() => { renderer = TestRenderer.create(<SkillItemRow sessionId="s1" title="ego-browser" />); });
        expect(renderer.root.findAllByType('Pressable')).toHaveLength(0);
        expect(renderer.root.findAllByType('BrowserStepsPopover')).toHaveLength(0);
    });
});

vi.mock('@/hooks/useDesktopFileWorkspaceAvailable', () => ({ useDesktopFileWorkspaceAvailable: () => false }));
