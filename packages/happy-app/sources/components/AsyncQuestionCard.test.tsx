import * as React from 'react';
import { act } from 'react';
import { describe, expect, it, vi } from 'vitest';
// @ts-expect-error This workspace does not include react-test-renderer declarations.
import TestRenderer from 'react-test-renderer';
import { AsyncQuestionCard } from './AsyncQuestionCard';
import { appThemes } from '@/themePacks';

vi.mock('react-native', () => ({
    ActivityIndicator: 'ActivityIndicator', Pressable: 'Pressable', Text: 'Text', TextInput: 'TextInput', View: 'View',
    Platform: { OS: 'web', select: (options: Record<string, unknown>) => options.web ?? options.default },
}));
vi.mock('@expo/vector-icons', () => ({ Ionicons: 'Ionicons' }));
vi.mock('@/text', () => ({ t: (key: string) => key }));
vi.mock('react-native-unistyles', async () => {
    const { appThemes } = await import('@/themePacks');
    return { StyleSheet: { hairlineWidth: 1, create: (factory: (theme: object) => object) => factory(appThemes.ginghamDark) },
        useUnistyles: () => ({ theme: appThemes.ginghamDark }) };
});

const questions = [{ title: 'Include screenshots?', options: ['Yes', 'No'] }, { title: 'Which pages?' }];
function render(props: Partial<React.ComponentProps<typeof AsyncQuestionCard>> = {}) {
    const onAction = vi.fn(async () => ({ status: 'answered' as const, answers: ['No', 'Project page'], updatedAt: 10 }));
    let renderer: any;
    act(() => { renderer = TestRenderer.create(<AsyncQuestionCard itemId="question" questions={questions} supported onAction={onAction} {...props} />); });
    const node = (id: string) => renderer.root.findAllByProps({ testID: id }).find((node: any) => typeof node.type === 'string');
    return { renderer, onAction, node };
}

describe('native async question editor', () => {
    it('does not auto-submit the preselected answer and requires every free-text answer', async () => {
        const h = render();
        expect(h.onAction).not.toHaveBeenCalled();
        expect(h.node('async-question-send').props.disabled).toBe(true);
        act(() => h.node('async-question-option-0-1').props.onPress());
        act(() => h.node('async-question-custom-1').props.onChangeText('Project page'));
        await act(async () => h.node('async-question-send').props.onPress());
        expect(h.onAction).toHaveBeenCalledWith({ action: 'answer', itemId: 'question', answers: ['No', 'Project page'] });
        expect(h.renderer.root.findAllByType('TextInput')).toHaveLength(0);
        act(() => h.renderer.unmount());
    });
    it('lets custom text override an option and retains it when collapsed and reopened', () => {
        const h = render();
        act(() => h.node('async-question-custom-0').props.onChangeText('Only the final screen'));
        act(() => h.node('async-question-later').props.onPress());
        expect(h.renderer.root.findAllByType('TextInput')).toHaveLength(0);
        expect(h.onAction).not.toHaveBeenCalled();
        act(() => h.node('async-question-toggle').props.onPress());
        expect(h.node('async-question-custom-0').props.value).toBe('Only the final screen');
        expect(h.node('async-question-option-0-0').props.accessibilityState.checked).toBe(false);
        act(() => h.renderer.unmount());
    });
    it('serializes double clicks and keeps the answer for retry on transport failure', async () => {
        let fail!: (reason: Error) => void;
        const onAction = vi.fn(() => new Promise<never>((_, reject) => { fail = reject; }));
        const h = render({ questions: [questions[0]], onAction });
        act(() => h.node('async-question-custom-0').props.onChangeText('Only final'));
        await act(async () => {
            h.node('async-question-send').props.onPress();
            h.node('async-question-send').props.onPress();
        });
        expect(onAction).toHaveBeenCalledTimes(1);
        await act(async () => fail(new Error('offline')));
        expect(h.node('async-question-custom-0').props.value).toBe('Only final');
        expect(h.node('async-question-send').props.disabled).toBe(false);
        act(() => h.renderer.unmount());
    });
    it('restores receipts after remount and accepts response updates from another device', () => {
        const h = render();
        const response = { status: 'dismissed' as const, updatedAt: 20 };
        act(() => h.renderer.update(<AsyncQuestionCard itemId="question" questions={questions} supported onAction={h.onAction} response={response} />));
        expect(h.renderer.root.findAllByType('TextInput')).toHaveLength(0);
        expect(h.onAction).not.toHaveBeenCalled();
        act(() => h.renderer.unmount());
        const restored = render({ response });
        expect(restored.renderer.root.findAllByType('TextInput')).toHaveLength(0);
        expect(restored.node('async-question-send')).toBeUndefined();
        act(() => restored.renderer.unmount());
    });
    it('never mutates a read-only transcript or uses an unsupported worker', () => {
        for (const props of [{ readOnly: true }, { supported: false }]) {
            const h = render({ questions: [questions[0]], ...props });
            if (props.readOnly) expect(h.renderer.root.findAllByType('TextInput')).toHaveLength(0);
            else expect(h.node('async-question-send').props.disabled).toBe(true);
            act(() => h.node('async-question-option-0-1').props.onPress());
            expect(h.onAction).not.toHaveBeenCalled();
            act(() => h.renderer.unmount());
        }
    });
    it('uses the active non-default dark theme for resting, pressed and selected surfaces', () => {
        const h = render();
        const style = h.node('async-question-option-0-0').props.style;
        const rest = Object.assign({}, ...style({ pressed: false }).flat().filter(Boolean));
        const pressed = Object.assign({}, ...style({ pressed: true }).flat().filter(Boolean));
        expect(h.node('async-question-card').props.style.backgroundColor).toBe(appThemes.ginghamDark.colors.surface);
        expect(rest.backgroundColor).toBe(appThemes.ginghamDark.colors.surfaceSelected);
        expect(pressed.backgroundColor).toBe(appThemes.ginghamDark.colors.surfacePressed);
        act(() => h.node('async-question-option-0-0').props.onHoverIn({}));
        const hovered = Object.assign({}, ...h.node('async-question-option-0-0').props.style({ pressed: false }).flat().filter(Boolean));
        expect(hovered.backgroundColor).toBe(appThemes.ginghamDark.colors.surfacePressed);
        act(() => h.renderer.unmount());
    });
    it('leaves a sibling composer and attachments untouched while the question is answered', async () => {
        const onAction = vi.fn(async () => ({ status: 'answered' as const, updatedAt: 1 }));
        function Chat() {
            const [draft, setDraft] = React.useState('My unfinished message');
            return <><input data-testid="main-composer" value={draft} onChange={event => setDraft(event.target.value)} />
                <span data-testid="attachment">photo.png</span>
                <AsyncQuestionCard itemId="question" questions={[questions[0]]} supported onAction={onAction} /></>;
        }
        let renderer: any;
        act(() => { renderer = TestRenderer.create(<Chat />); });
        await act(async () => renderer.root.findAllByProps({ testID: 'async-question-send' }).find((node: any) => node.type === 'Pressable').props.onPress());
        expect(renderer.root.findByProps({ 'data-testid': 'main-composer' }).props.value).toBe('My unfinished message');
        expect(renderer.root.findByProps({ 'data-testid': 'attachment' }).children).toEqual(['photo.png']);
        act(() => renderer.unmount());
    });
});
