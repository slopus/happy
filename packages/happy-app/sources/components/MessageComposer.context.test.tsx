vi.mock('./ComposerReferenceChips', () => ({ ComposerReferenceChips: 'ComposerReferenceChips' }));
vi.mock('./ComposerContextPicker', () => ({ ComposerContextPicker: 'ComposerContextPicker' }));
vi.mock('react-native-svg', () => ({ default: 'Svg', Path: 'Path', Rect: 'Rect', Circle: 'Circle' }));
import * as React from 'react';
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// @ts-expect-error react-test-renderer has no declarations in this workspace.
import TestRenderer from 'react-test-renderer';

const mocks = vi.hoisted(() => ({
    hapticsLight: vi.fn(), liveText: '', write: vi.fn(),
}));

vi.mock('react-native', async () => {
    const ReactModule = await import('react');
    const Pressable = ReactModule.forwardRef<any, any>((props, ref) => {
        ReactModule.useImperativeHandle(ref, () => ({
            measureInWindow: (callback: (x: number, y: number, width: number, height: number) => void) => {
                callback(120, 700, 40, 32);
            },
        }));
        return ReactModule.createElement('Pressable', props, props.children);
    });
    return {
        ActivityIndicator: 'ActivityIndicator',
        Platform: {
            OS: 'ios',
            select: (values: Record<string, unknown>) => values.ios ?? values.default,
        },
        Pressable,
        Text: 'Text',
        View: 'View',
        useWindowDimensions: () => ({ width: 390, height: 844 }),
    };
});
vi.mock('@expo/vector-icons', () => ({ Ionicons: 'Ionicons', Octicons: 'Octicons' }));
vi.mock('./AgentInputAttachmentStrip', () => ({ AgentInputAttachmentStrip: 'AgentInputAttachmentStrip' }));
vi.mock('./MultiTextInput', async () => {
    const ReactModule = await import('react');
    return {
        MULTI_TEXT_INPUT_FONT_SIZE: 16,
        MULTI_TEXT_INPUT_LINE_HEIGHT: 22,
        MultiTextInput: ReactModule.forwardRef<any, any>((props, ref) => {
            ReactModule.useImperativeHandle(ref, () => ({
                getText: () => mocks.liveText,
                setTextAndSelection: mocks.write,
                focus: vi.fn(),
            }));
            return ReactModule.createElement('MultiTextInput', props);
        }),
    };
});
vi.mock('@/constants/Typography', () => ({ Typography: { default: () => ({}) } }));
vi.mock('./haptics', () => ({ hapticsLight: mocks.hapticsLight, hapticsError: vi.fn() }));
vi.mock('./Shaker', async () => {
    const ReactModule = await import('react');
    return {
        Shaker: ReactModule.forwardRef<any, any>((props, ref) => {
            ReactModule.useImperativeHandle(ref, () => ({ shake: vi.fn() }));
            return ReactModule.createElement('Shaker', props, props.children);
        }),
    };
});
vi.mock('./StatusDot', () => ({ StatusDot: 'StatusDot' }));

vi.mock('./autocomplete/useActiveSuggestions', () => ({
    useActiveSuggestions: () => [[], -1, vi.fn(), vi.fn()],
}));
vi.mock('./AgentInputAutocomplete', () => ({ AgentInputAutocomplete: 'AgentInputAutocomplete' }));
vi.mock('./GitStatusBadge', () => ({ GitStatusBadge: 'GitStatusBadge', useHasMeaningfulGitStatus: () => false }));
vi.mock('@/sync/storage', () => ({ useSetting: () => false }));
vi.mock('./layout', () => ({ layout: { maxWidth: 800 } }));
vi.mock('@/modal', () => ({ Modal: { alert: vi.fn() } }));
vi.mock('@/text', () => ({ t: (key: string) => key }));
vi.mock('@/utils/desktopNavigationLayout', () => ({ supportsDesktopComposerModeSelector: () => false }));
vi.mock('./SessionComposerModeSelector', () => ({ SessionComposerModeSelector: 'SessionComposerModeSelector' }));
vi.mock('./LegacySessionComposerModeSelector', () => ({ SessionComposerModeSelector: 'SessionComposerModeSelector' }));
vi.mock('./SessionComposerPermissionSelector', () => ({ SessionComposerPermissionSelector: 'SessionComposerPermissionSelector' }));
vi.mock('./SessionComposerDirectorySelector', () => ({ SessionComposerDirectorySelector: 'SessionComposerDirectorySelector' }));
vi.mock('./composerPrimaryAction', () => ({ resolveComposerPrimaryAction: () => 'send' }));
vi.mock('@/hooks/useComposerAbortConfirmation', () => ({
    useComposerAbortConfirmation: () => ({ confirm: vi.fn(), handleEscape: vi.fn(), isArmed: false }),
}));
vi.mock('react-native-unistyles', () => {
    const theme = {
        dark: true,
        colors: {
            button: {
                composer: { background: '#fff', disabled: '#777', tint: '#000' },
                primary: { background: '#fff', disabled: '#777', tint: '#000' },
                secondary: { tint: '#fff' },
            },
            divider: '#444',
            input: { background: '#111' },
            radio: { active: '#f90' },
            shadow: { color: '#000', opacity: 0.2 },
            success: '#0f0',
            surfaceHigh: '#222',
            surfacePressed: '#333',
            text: '#fff',
            textDestructive: '#f00',
            textSecondary: '#aaa',
            warning: '#f90',
            warningCritical: '#f00',
        },
    };
    return {
        StyleSheet: {
            hairlineWidth: 1,
            create: (factory: any) => typeof factory === 'function' ? factory(theme, {}) : factory,
        },
        useUnistyles: () => ({ theme }),
    };
});

import { MessageComposer } from './MessageComposer';

describe('MessageComposer unified context entry', () => {
    let renderer: any;
    beforeEach(() => { vi.clearAllMocks(); mocks.liveText = ''; (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true; });
    afterEach(() => { if (renderer) act(() => renderer.unmount()); });
    const mount = (props: any = {}) => act(() => { renderer = TestRenderer.create(<MessageComposer mode="home" initialValue="" placeholder="Message" onSend={vi.fn()} {...props} />); });
    const input = () => renderer.root.findByType('MultiTextInput');
    const type = (text: string, cursor = text.length) => act(() => {
        mocks.liveText = text;
        input().props.onStateChange({ text, selection: { start: cursor, end: cursor } });
        input().props.onChangeText(text);
    });
    const menu = () => renderer.root.findByType('ComposerContextPicker');
    it.each(['home', 'session'])('opens @ without files or autocomplete props in %s', mode => {
        mount({ mode }); type('@'); expect(menu().props.query).toBe('');
    });
    it('opens + without changing the draft or directly picking a file', () => {
        const pick = vi.fn(); mount({ onPickImages: pick });
        act(() => renderer.root.findByProps({ testID: 'composer-context-trigger' }).props.onPress());
        expect(menu()).toBeTruthy(); expect(pick).not.toHaveBeenCalled(); expect(mocks.write).not.toHaveBeenCalled();
    });
    it('Escape closes and suppresses the same @ token, typing reopens', () => {
        mount(); type('@');
        act(() => { expect(input().props.onKeyPress({ key: 'Escape' })).toBe(true); });
        expect(renderer.root.findAllByType('ComposerContextPicker')).toHaveLength(0);
        type('@s'); expect(menu().props.query).toBe('s');
    });
    it('replaces only the active @ query and preserves following text', () => {
        mount(); type('Before @sess after', 12);
        act(() => menu().props.onSelect({ text: '@Review [session:other]' }));
        expect(mocks.write.mock.calls[0][0]).toBe('Before @Review [session:other] after');
    });
    it('upload selection removes only its @ query and preserves surrounding draft', () => {
        mount(); type('Before @up after', 10);
        act(() => menu().props.onSelect({ text: '', action: 'upload' }));
        expect(mocks.write.mock.calls[0][0]).toBe('Before  after');
    });
    it('does not intercept an email address', () => {
        mount(); type('hello@example.com'); expect(renderer.root.findAllByType('ComposerContextPicker')).toHaveLength(0);
    });
    it('renders restored context as a removable chip and keeps the textarea free of metadata', () => {
        const raw = 'Question\n<paws-context>{"version":1,"references":[{"kind":"session","id":"source","title":"Earlier discussion"}]}</paws-context>';
        const change = vi.fn();
        mount({ initialValue: raw, onChangeText: change });
        expect(input().props.defaultValue).toBe('Question');
        const chips = renderer.root.findByType('ComposerReferenceChips');
        expect(chips.props.references[0]).toMatchObject({ kind: 'session', id: 'source' });
        mocks.liveText = 'Question';
        act(() => chips.props.onRemove(chips.props.references[0]));
        expect(change).toHaveBeenLastCalledWith('Question');
    });
    it('selects a conversation chip instead of inserting its raw ID into visible text', () => {
        const change = vi.fn(); mount({ onChangeText: change });type('@design');
        act(() => menu().props.onSelect({ text: '', reference: { kind: 'session', id: 'source', title: 'Design discussion' } }));
        expect(mocks.write.mock.calls.at(-1)![0]).toBe('');
        expect(renderer.root.findByType('ComposerReferenceChips').props.references[0].title).toBe('Design discussion');
        act(() => input().props.onChangeText('Use that'));
        expect(change.mock.calls.at(-1)![0]).toContain('<paws-context>');
        expect(change.mock.calls.at(-1)![0]).toContain('source');
    });

    it('keeps the native popup after and outside the clipped input panel on an initial @ draft', () => {
        mount({ initialValue: '@', mode: 'session' });
        const panel = renderer.root.findByProps({ testID: 'composer-input-panel' });
        let ancestor = menu().parent;
        while (ancestor) { expect(ancestor.props.testID).not.toBe('composer-input-panel'); ancestor = ancestor.parent; }
        expect(panel.parent.props.style.overflow).toBe('visible');
        expect(panel.parent.children[0]).toBe(panel);
    });

});
