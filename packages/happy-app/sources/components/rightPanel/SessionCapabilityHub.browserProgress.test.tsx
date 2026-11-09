import * as React from 'react';
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import TestRenderer from 'react-test-renderer';
import { SessionCapabilityHub } from './SessionCapabilityHub';

const mocks = vi.hoisted(() => ({
    platformOS: 'web',
    messages: [
        {
            kind: 'tool-call', id: 'ego-run', localId: null, createdAt: 1, children: [],
            tool: { name: 'Skill', state: 'completed', input: { skillNames: ['ego-browser'] }, createdAt: 1, startedAt: 1, completedAt: 2, description: null },
        },
        {
            kind: 'tool-call', id: 'step-1', localId: null, createdAt: 3, children: [],
            tool: {
                name: 'file', state: 'completed', createdAt: 3, startedAt: 3, completedAt: 3, description: null,
                input: { source: 'browser_step', ref: 'attachment://step-1', name: 'step.png', browserStep: { label: 'Done' } },
            },
        },
    ],
}));

vi.mock('react-native', () => ({ get Platform() { return { OS: mocks.platformOS }; }, Pressable: 'Pressable', ScrollView: 'ScrollView', Text: 'Text', View: 'View' }));
vi.mock('@expo/vector-icons', () => ({ Ionicons: 'Ionicons', Octicons: 'Octicons' }));
vi.mock('react-native-unistyles', () => ({
    StyleSheet: { create: (value: any) => typeof value === 'function' ? value() : value },
    useUnistyles: () => ({ theme: { colors: { text: '#111', textSecondary: '#666' } } }),
}));
vi.mock('@/hooks/useSessionQuickActions', () => ({ useSessionQuickActions: () => ({ actionItems: [] }) }));
vi.mock('@/modal', () => ({ Modal: { confirm: vi.fn(), show: vi.fn() } }));
vi.mock('@/sync/storage', () => ({
    useSession: () => ({ id: 's1', metadata: {} }),
    useSessionMessages: () => ({ messages: mocks.messages }),
    useSettingMutable: () => [[], vi.fn()],
}));
vi.mock('@/sync/sync', () => ({ sync: { sendMessage: vi.fn() } }));
vi.mock('@/text', () => ({ t: (key: string) => key }));
vi.mock('../haptics', () => ({ hapticsLight: vi.fn() }));
vi.mock('../RightSwipePanelHost', () => ({ useRightSwipePanel: () => null }));
vi.mock('./CapabilityBlockCard', () => ({ CapabilityBlockCard: 'CapabilityBlockCard' }));
vi.mock('./CapabilityHubDetailView', () => ({ CapabilityHubDetailView: 'CapabilityHubDetailView', SessionActionsDetailView: 'SessionActionsDetailView' }));
vi.mock('./BrowserStepsPanel', () => ({ BrowserStepsPanel: 'BrowserStepsPanel' }));
vi.mock('./QuickPromptEditorModal', () => ({ QuickPromptEditorModal: 'QuickPromptEditorModal' }));
vi.mock('./SessionFolderBrowserView', () => ({ SessionFolderBrowserView: 'SessionFolderBrowserView' }));
vi.mock('./useFolderRootCount', () => ({ useFolderRootCount: () => 0 }));
vi.mock('./useSessionCapabilityHub', () => ({
    useSessionCapabilityHub: () => ({
        blocks: ['outputs', 'sources', 'skills', 'quickPrompts', 'artifacts', 'files'].map((key) => ({ count: key === 'skills' ? 1 : 0, empty: key !== 'skills', key, preview: key === 'skills' ? 'ego-browser' : null })),
        details: { artifacts: [], files: [], images: [], outputs: [], quickPrompts: [], skills: [{ id: 'ego-browser', kind: 'skill', meta: 'available', title: 'ego-browser' }], sources: [] },
    }),
}));
vi.mock('../plugins/usePluginSurfaceViews', () => ({ usePluginSurfaceViews: () => [] }));

describe('SessionCapabilityHub browser progress routing', () => {
    let renderer: any;
    let consoleErrorSpy: ReturnType<typeof vi.spyOn>;
    const originalConsoleError = console.error;

    beforeEach(() => {
        mocks.platformOS = 'web';
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

    it('keeps the ordinary capability summary mounted while browser steps exist', () => {
        act(() => {
            renderer = TestRenderer.create(<SessionCapabilityHub sessionId="s1" />);
        });

        expect(renderer.root.findAllByProps({ testID: 'capability-block-skills' })).toHaveLength(1);
        expect(renderer.root.findAllByProps({ testID: 'open-browser-steps' })).toHaveLength(0);
        expect(renderer.root.findAllByProps({ testID: 'browser-steps-popover' })).toHaveLength(0);
    });

    it('keeps the ordinary capability panel on non-Web clients too', () => {
        mocks.platformOS = 'ios';
        act(() => {
            renderer = TestRenderer.create(<SessionCapabilityHub sessionId="s1" />);
        });

        expect(renderer.root.findAllByType('BrowserStepsPanel')).toHaveLength(0);
        expect(renderer.root.findAllByProps({ testID: 'capability-block-skills' })).toHaveLength(1);
        expect(renderer.root.findAll((node: any) => node.props.testID?.startsWith('browser-progress-trigger-'))).toHaveLength(0);
    });
});

vi.mock('@/hooks/useDesktopFileWorkspaceAvailable', () => ({ useDesktopFileWorkspaceAvailable: () => false }));
