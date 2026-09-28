import * as React from 'react';
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import TestRenderer from 'react-test-renderer';
import type { Message, ToolCallMessage } from '@/sync/typesMessage';
import { ConversationTranscript } from './ConversationTranscript';
import { publicSessionSnapshotToMessages } from '@/sync/publicSessionSnapshotAdapter';

// Render list items rather than only inspecting FlatList.data. Grouping,
// MessageView routing, activity aggregation, context and progress actions are real.
vi.mock('react-native', () => ({
    AppState: { addEventListener: () => ({ remove: vi.fn() }) },
    ActivityIndicator: 'ActivityIndicator',
    FlatList: (props: any) => <>{props.data.map((item: any) =>
        <React.Fragment key={props.keyExtractor(item)}>{props.renderItem({ item })}</React.Fragment>)}</>,
    Platform: { OS: 'web', select: (options: any) => options.web ?? options.default },
    Pressable: 'Pressable', Text: 'Text', View: 'View', TextInput: 'TextInput', ScrollView: 'ScrollView',
    useWindowDimensions: () => ({ width: 1200, height: 800 }),
}));
vi.mock('@expo/vector-icons', () => ({ Octicons: 'Octicons', Ionicons: 'Ionicons' }));
vi.mock('react-native-reanimated', () => ({
    default: { View: 'AnimatedView' }, FadeIn: { duration: vi.fn() }, FadeOut: { duration: vi.fn() },
}));
const { theme } = vi.hoisted(() => ({ theme: { colors: {
    divider: '#444', shadow: { color: '#000', opacity: 0.2 }, surface: '#111', surfaceHigh: '#222',
    surfaceHighest: '#333', surfacePressed: '#444', text: '#fff', textSecondary: '#aaa',
    fab: { background: '#fff' }, input: { text: '#fff', placeholder: '#aaa' },
    box: { error: { background: '#422', border: '#844', text: '#faa' } },
} } }));
vi.mock('react-native-unistyles', () => ({
    StyleSheet: { create: (factory: any) => factory(theme) }, useUnistyles: () => ({ theme }),
}));
vi.mock('expo-router', () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock('expo-clipboard', () => ({ setStringAsync: vi.fn() }));
vi.mock('@/sync/sync', () => ({ sync: {} }));
vi.mock('@/modal', () => ({ Modal: {} }));
vi.mock('@/modal/components/BaseModal', () => ({ BaseModal: 'BaseModal' }));
vi.mock('@/text', () => ({ t: (key: string) => key }));
vi.mock('@/hooks/useElapsedTime', () => ({ useElapsedTime: () => 0 }));
vi.mock('@/utils/messageForkPoint', () => ({
    getAgentMessageForkTargets: () => new Map(), getUserMessageForkRewindPointId: () => undefined,
}));
vi.mock('./tools/knownTools', () => ({ knownTools: {} }));
vi.mock('./tools/ToolView', () => ({ ToolView: 'ToolView' }));
vi.mock('./tools/views/MCPToolView', () => ({ formatMCPTitle: (name: string) => name }));
vi.mock('./markdown/MarkdownView', () => ({ MarkdownView: 'MarkdownView' }));
vi.mock('./DesktopShortcutTooltip', () => ({ DesktopShortcutTooltip: 'DesktopShortcutTooltip' }));
vi.mock('./AttachmentGalleryView', () => ({ AttachmentGalleryView: 'AttachmentGalleryView' }));
vi.mock('./AnchorListSheet', () => ({ AnchorListSheet: 'AnchorListSheet' }));
vi.mock('./rightPanel/BrowserStepsPopover', () => ({ BrowserStepsPopover: 'BrowserStepsPopover' }));
vi.mock('./haptics', () => ({ hapticsLight: vi.fn() }));
vi.mock('./layout', () => ({ layout: { maxWidth: 800 } }));

function tool(id: string, createdAt: number, name: string, input: Record<string, unknown>): ToolCallMessage {
    return { kind: 'tool-call', id, createdAt, localId: null, children: [],
        tool: { name, input, state: 'completed', createdAt, startedAt: createdAt,
            completedAt: createdAt, description: null } };
}
const skill = tool('invoke', 10, 'Skill', { skill: 'ego-browser' });
const frame = tool('frame', 20, 'file', { ref: 'attachment://frame', name: 'frame.png',
    source: 'browser_step', image: { width: 100, height: 100 },
    browserStep: { label: 'Verified session switch', runId: 'run-a', skillName: 'ego-browser' } });
const final: Message = { kind: 'agent-text', id: 'final', createdAt: 30, localId: null, text: 'Done.' };

describe('inline browser evidence through the real transcript rendering chain', () => {
    let renderer: any;
    beforeEach(() => { (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true; });
    afterEach(() => { if (renderer) act(() => renderer.unmount()); delete (globalThis as any).IS_REACT_ACT_ENVIRONMENT; });
    const byId = (testID: string) => renderer.root.find((node: any) => node.type === 'Pressable' && node.props.testID === testID);
    it('collapses old public browser screenshots and opens anonymous evidence', async () => {
        const messages = publicSessionSnapshotToMessages({ version: 1, title: 'Shared', sharedAt: 100,
            messages: [{ id: 'old-frame', role: 'assistant', createdAt: 20, blocks: [{
                type: 'attachment', attachmentId: 'asset', kind: 'image', source: 'browser_step',
                name: 'screen.png', mimeType: 'image/png', size: 1,
            }] }],
        }, { attachmentUrl: () => 'https://public.test/screen.png' });
        await act(async () => { renderer = TestRenderer.create(<ConversationTranscript metadata={null}
            browserProgressScope="public:a" messages={messages} />); });
        expect(renderer.root.findAllByType('BrowserStepsPopover')).toHaveLength(0);
        expect(renderer.root.findAllByType('AttachmentGalleryView')).toHaveLength(0);
        act(() => byId('browser-progress-trigger-legacy-browser-initial').props.onPress());
        const popover = renderer.root.findByType('BrowserStepsPopover');
        expect(popover.props.sessionId).toBeUndefined();
        expect(popover.props.steps[0].ref).toBe('https://public.test/screen.png');
        await act(async () => renderer.update(<ConversationTranscript metadata={null}
            browserProgressScope="public:b" messages={messages} />));
        expect(renderer.root.findAllByType('BrowserStepsPopover')).toHaveLength(0);
    });

    it.each([false, true])('shows Codex frames without a Skill event only in Skills, grouping = %s', async (groupToolCalls) => {
        const second = tool('frame-2', 25, 'file', { ...frame.tool.input,
            ref: 'attachment://second', browserStep: { ...frame.tool.input.browserStep, label: 'Final result' } });
        await act(async () => { renderer = TestRenderer.create(<ConversationTranscript metadata={null}
            sessionId="session-a" messages={[final, second, frame]} groupToolCalls={groupToolCalls} />); });
        const triggers = renderer.root.findAll((node: any) => node.type === 'Pressable' && node.props.testID === 'browser-progress-trigger-run-a');
        expect(triggers).toHaveLength(1);
        act(() => triggers[0].props.onPress());
        const popover = renderer.root.findByType('BrowserStepsPopover');
        expect(popover.props.sessionId).toBe('session-a');
        expect(popover.props.steps.map((s: any) => s.id)).toEqual(['frame', 'frame-2']);
        expect(renderer.root.findAllByType('AttachmentGalleryView')).toHaveLength(0);
    });

    it('clears the open progress view when switching sessions, even with identical run and message IDs', async () => {
        await act(async () => { renderer = TestRenderer.create(<ConversationTranscript metadata={null}
            sessionId="session-a" messages={[final, frame, skill]} />); });
        act(() => byId('browser-progress-trigger-run-a').props.onPress());
        expect(renderer.root.findByType('BrowserStepsPopover').props.sessionId).toBe('session-a');
        const other = { ...frame, tool: { ...frame.tool, input: { ...frame.tool.input, ref: 'attachment://session-b' } } };
        await act(async () => renderer.update(<ConversationTranscript metadata={null}
            sessionId="session-b" messages={[final, other, skill]} />));
        expect(renderer.root.findAllByType('BrowserStepsPopover')).toHaveLength(0);
        act(() => byId('browser-progress-trigger-run-a').props.onPress());
        const popover = renderer.root.findByType('BrowserStepsPopover');
        expect(popover.props.sessionId).toBe('session-b');
        expect(popover.props.steps[0].ref).toBe('attachment://session-b');
    });
    const triggers = () => renderer.root.findAll((node: any) => node.type === 'Pressable'
        && node.props.testID === 'browser-progress-trigger-run-a');
    const assertEvidenceAccessible = () => {
        expect(triggers()).toHaveLength(1);
        expect(renderer.root.findAllByType('AttachmentGalleryView')).toHaveLength(0);
        act(() => triggers()[0].props.onPress());
        expect(renderer.root.findByType('BrowserStepsPopover').props.steps.map((step: any) => step.id)).toEqual(['frame']);
        act(() => renderer.root.findByType('BrowserStepsPopover').props.onClose());
    };

    it.each([false, true])('keeps linked evidence reachable with tool grouping = %s', async (groupToolCalls) => {
        await act(async () => { renderer = TestRenderer.create(<ConversationTranscript metadata={null}
            sessionId="session" messages={[final, frame, skill]} groupToolCalls={groupToolCalls} />); });
        assertEvidenceAccessible();
        if (groupToolCalls) {
            const toggle = byId('conversation-agent-work-toggle');
            expect(toggle.props.accessibilityState.expanded).toBe(false);
            act(() => toggle.props.onPress());
            expect(byId('conversation-agent-work-toggle').props.accessibilityState.expanded).toBe(true);
            // Expanded inner tool groups must not duplicate the outer Skills entry.
            assertEvidenceAccessible();
        }
    });

    it('provides the entry on a collapsed top-level tool group before the final response', async () => {
        const read = tool('read', 11, 'Read', { file_path: '/tmp/check.ts' });
        await act(async () => { renderer = TestRenderer.create(<ConversationTranscript metadata={null}
            sessionId="session" messages={[frame, read, skill]} groupToolCalls currentTurnActive />); });
        const toggle = byId('conversation-tool-group-toggle');
        expect(toggle.props.accessibilityState.expanded).toBe(false);
        assertEvidenceAccessible();
        act(() => toggle.props.onPress());
        assertEvidenceAccessible();
    });
});
