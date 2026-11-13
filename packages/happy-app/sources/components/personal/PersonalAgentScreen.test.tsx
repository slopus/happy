import * as React from 'react';
import { act } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
// @ts-expect-error react-test-renderer does not publish declarations.
import TestRenderer from 'react-test-renderer';
import { PersonalAgentScreen } from './PersonalAgentScreen';
import { PersonalProfileDialog } from './PersonalProfileDialog';
import { appThemes } from '@/themePacks';

const mocks = vi.hoisted(() => ({
    settings: { personalAgentName: 'Paws', personalAgentAvatar: null as string | null, personalAgentConversationId: 'personal' as string | null },
    sessions: {} as Record<string, any>, focused: true,
    applySettings: vi.fn(), spawn: vi.fn(), resume: vi.fn(), send: vi.fn(), close: vi.fn(), draft: vi.fn(),
    picker: vi.fn(), manipulate: vi.fn(),
    owner: { sessionId: 'personal', ownerEpoch: 1, phase: 'opening' },
    setCurrent: vi.fn(), leave: vi.fn(),
}));
vi.mock('react-native', async () => {
    const R = await import('react');
    return { Platform: { OS: 'web', select: (values: Record<string, unknown>) => values.web ?? values.default }, View: 'View', Text: 'Text', Image: 'Image', TextInput: 'TextInput', ScrollView: 'ScrollView',
        ActivityIndicator: 'ActivityIndicator', KeyboardAvoidingView: 'KeyboardAvoidingView',
        Pressable: ({ children, ...props }: any) => R.createElement('Pressable', props, typeof children === 'function' ? children({ pressed: false }) : children),
        FlatList: R.forwardRef(({ data, renderItem, ListFooterComponent, ListHeaderComponent, ...props }: any, ref: any) => {
            R.useImperativeHandle(ref, () => ({ scrollToOffset() {} }));
            return R.createElement('FlatList', props, ListHeaderComponent, data.map((item: any, index: number) => R.createElement(R.Fragment, { key: item.id }, renderItem({ item, index }))), ListFooterComponent);
        }),
    };
});
vi.mock('react-native-unistyles', async () => {
    const { appThemes } = await import('@/themePacks');
    return { StyleSheet: { hairlineWidth: 1, create: (fn: any) => fn(appThemes.ginghamDark) }, useUnistyles: () => ({ theme: appThemes.ginghamDark }) };
});
vi.mock('@expo/vector-icons', () => ({ Feather: 'Feather' }));
vi.mock('expo-router', () => ({ useNavigation: () => ({ dispatch: vi.fn() }) }));
vi.mock('@react-navigation/native', () => ({ useIsFocused: () => mocks.focused, DrawerActions: { openDrawer: vi.fn() } }));
vi.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ bottom: 0 }) }));
vi.mock('@/utils/responsive', () => ({ useIsTablet: () => true }));
vi.mock('@/components/StyledText', () => ({ Text: 'Text' }));
vi.mock('@/components/markdown/MarkdownView', () => ({ MarkdownView: 'MarkdownView' }));
vi.mock('@/components/MessageView', () => ({ MessageView: 'MessageView' }));
vi.mock('./PersonalAvatar', () => ({ PersonalAvatar: 'PersonalAvatar' }));
vi.mock('@/components/DesktopDialogFrame', () => ({ DesktopDialogFrame: ({ children }: any) => children }));
vi.mock('expo-image-picker', () => ({ launchImageLibraryAsync: mocks.picker }));
vi.mock('expo-image-manipulator', () => ({ manipulateAsync: mocks.manipulate, SaveFormat: { JPEG: 'jpeg' } }));
vi.mock('@/text', () => ({ t: (key: string) => key }));
vi.mock('@/hooks/useDraft', () => ({ useDraft: () => ({ clearDraft: mocks.draft, updateDraft: mocks.draft }) }));
vi.mock('@/sync/sessionTextStream', () => ({ useSessionTextPreviews: () => [] }));
vi.mock('@/sync/storage', () => ({
    useSetting: (key: keyof typeof mocks.settings) => mocks.settings[key],
    useLocalSettingMutable: (key: keyof typeof mocks.settings) => [mocks.settings[key], (value: any) => { (mocks.settings as any)[key] = value; mocks.applySettings({ [key]: value }); }],
    useIsDataReady: () => true,
    useAllMachines: () => [],
    usePersonalAgentConversations: () => Object.values(mocks.sessions).filter((s: any) => s.metadata.flavor === 'personal'),
    useSession: (id: string) => mocks.sessions[id] ?? null,
    useSessionMessages: () => ({ isLoaded: true, hasMoreOlder: false, isAtLatest: true, messages: [
        { id: 'answer', kind: 'agent-text', text: 'Hello', createdAt: 2, localId: null },
        { id: 'prompt', kind: 'user-text', text: 'Hi', createdAt: 1, localId: null },
    ] }),
    storage: { getState: () => ({ sessions: mocks.sessions, setCurrentViewingSession: mocks.setCurrent }) },
}));
vi.mock('@/sync/sync', () => ({ sync: {
    beginSessionRoute: () => mocks.owner, isSessionRouteOwner: () => mocks.focused,
    openSession: () => Promise.resolve('ready'), promoteSessionRoute: vi.fn(), leaveSessionRoute: mocks.leave,
    sessionRouteBecameInteractive: vi.fn(), sendMessage: mocks.send,
    applySettings: mocks.applySettings,
} }));
vi.mock('@/sync/ops', () => ({ machineSpawnNewSession: mocks.spawn, machineResumeSession: mocks.resume, sessionAbort: vi.fn() }));

describe('Personal independent chat', () => {
    beforeEach(() => {
        (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
        vi.clearAllMocks(); mocks.focused = true;
        mocks.settings = { personalAgentName: 'Paws', personalAgentAvatar: null, personalAgentConversationId: 'personal' };
        mocks.sessions = { personal: { id: 'personal', createdAt: 1, active: true, metadata: { flavor: 'personal', path: '/personal' } } };
    });

    it('reopens the persisted thread with opposed bubbles and never spawns a fresh session', async () => {
        let tree: any;
        await act(async () => { tree = TestRenderer.create(<PersonalAgentScreen />); });
        expect(mocks.setCurrent).toHaveBeenCalledWith('personal');
        expect(mocks.spawn).not.toHaveBeenCalled();
        expect(tree.root.findByProps({ testID: 'personal-user-bubble' }).props.style).toContainEqual(expect.objectContaining({ alignSelf: 'flex-end' }));
        expect(tree.root.findByProps({ testID: 'personal-assistant-bubble' }).props.style).toContainEqual(expect.objectContaining({ alignSelf: 'flex-start', backgroundColor: appThemes.ginghamDark.colors.surfaceHigh }));
        await act(async () => { tree.unmount(); });
        expect(mocks.leave).toHaveBeenCalledWith(mocks.owner);
    });

    it('retains the draft on send failure and prevents double submission', async () => {
        let rejectSend!: (error: Error) => void;
        mocks.send.mockReturnValue(new Promise((_resolve, reject) => { rejectSend = reject; }));
        let tree: any;
        await act(async () => { tree = TestRenderer.create(<PersonalAgentScreen />); });
        await act(async () => { tree.root.findByProps({ testID: 'personal-message-input' }).props.onChangeText('my request'); });
        const send = tree.root.findByProps({ testID: 'personal-message-send' });
        await act(async () => { send.props.onPress(); send.props.onPress(); });
        expect(mocks.send).toHaveBeenCalledTimes(1);
        expect(mocks.send).toHaveBeenCalledWith('personal', 'my request', expect.objectContaining({ isCurrent: expect.any(Function) }));
        await act(async () => { rejectSend(new Error('network')); });
        expect(tree.root.findByProps({ testID: 'personal-message-input' }).props.value).toBe('my request');
        expect(tree.root.findByProps({ accessibilityRole: 'alert' }).children).toContain('personalAgent.sendFailed');
        await act(async () => { tree.unmount(); });
    });

    it('does not render or send through an ordinary session supplied as the Personal pointer', async () => {
        mocks.sessions.personal.metadata.flavor = 'codex';
        let tree: any;
        await act(async () => { tree = TestRenderer.create(<PersonalAgentScreen />); });
        expect(tree.root.findAllByProps({ testID: 'personal-message-input' })).toHaveLength(0);
        expect(mocks.send).not.toHaveBeenCalled();
        await act(async () => { tree.unmount(); });
    });

    it('saves only the edited profile and embeds normalized avatar bytes, independent of the thread', async () => {
        mocks.picker.mockResolvedValue({ canceled: false, assets: [{ uri: 'file://photo.jpg', width: 800, height: 600 }] });
        mocks.manipulate.mockResolvedValue({ base64: 'YXZhdGFy' });
        let tree: any;
        await act(async () => { tree = TestRenderer.create(<PersonalProfileDialog visible onClose={mocks.close} />); });
        await act(async () => { tree.root.findByProps({ testID: 'personal-profile-name' }).props.onChangeText('小爪'); });
        await act(async () => { await tree.root.findByProps({ testID: 'personal-profile-change-avatar' }).props.onPress(); });
        await act(async () => { tree.root.findByProps({ testID: 'personal-profile-save' }).props.onPress(); });
        expect(mocks.manipulate).toHaveBeenCalledWith('file://photo.jpg', expect.arrayContaining([{ resize: { width: 256, height: 256 } }]), expect.objectContaining({ base64: true }));
        expect(mocks.applySettings).toHaveBeenCalledWith({ personalAgentName: '小爪', personalAgentAvatar: 'data:image/jpeg;base64,YXZhdGFy' });
        expect(mocks.settings.personalAgentConversationId).toBe('personal');
        await act(async () => { tree.unmount(); });
    });
});
