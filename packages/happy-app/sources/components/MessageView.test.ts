import * as React from 'react';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import { act, create } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { UserTextMessage } from '@/sync/typesMessage';

vi.hoisted(() => vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true));
vi.mock('react-native', async () => {
    const ReactModule = await import('react');
    const host = (name: string) => (props: any) => ReactModule.createElement(name, props, props.children);
    return {
        View: host('View'), Text: host('Text'), Pressable: host('Pressable'),
        Platform: { OS: 'ios', select: (values: any) => values.ios ?? values.default },
    };
});
vi.mock('react-native-unistyles', () => ({
    useUnistyles: () => ({ theme: { dark: false } }),
    StyleSheet: { create: (factory: (theme: any) => unknown) => factory({ colors: { input: {} } }) },
}));
vi.mock('@expo/vector-icons', () => ({ Ionicons: 'Ionicons' }));
vi.mock('expo-clipboard', () => ({ setStringAsync: vi.fn() }));
vi.mock('@/text', () => ({ t: (key: string) => key }));
vi.mock('@/sync/sync', () => ({ sync: { sendMessage: vi.fn() } }));
vi.mock('@/sync/storage', () => ({ useSetting: () => 'default' }));
vi.mock('@/utils/userMessageBubbleColor', () => ({ resolveUserMessageBubbleColor: () => ({}) }));
vi.mock('./layout', () => ({ layout: { maxWidth: 800 } }));
vi.mock('./markdown/MarkdownView', () => ({ MarkdownView: 'MarkdownView' }));
vi.mock('./tools/ToolView', () => ({ ToolView: 'ToolView' }));
vi.mock('./LongPressCopyable', async () => {
    const ReactModule = await import('react');
    return { LongPressCopyable: (props: any) => ReactModule.createElement('LongPressCopyable', props, props.children) };
});

import { MessageView } from './MessageView';

const renderers: ReturnType<typeof create>[] = [];
const base: UserTextMessage = {
    kind: 'user-text', id: 'message', localId: 'local', createdAt: Date.now(), text: 'hello',
};

function render(message: UserTextMessage, renderer?: ReturnType<typeof create>) {
    const element = React.createElement(MessageView, { message, sessionId: 'session', metadata: null });
    if (renderer) {
        act(() => renderer.update(element));
        return renderer;
    }
    let next!: ReturnType<typeof create>;
    act(() => { next = create(element); });
    renderers.push(next);
    return next;
}

function labels(renderer: ReturnType<typeof create>) {
    return renderer.root.findAllByType('Text').map((node: any) => node.props.children);
}

afterEach(() => {
    act(() => renderers.splice(0).forEach((renderer) => renderer.unmount()));
    vi.useRealTimers();
});

describe('user message frame', () => {
    it.each([undefined, false])('does not flash status or dim an idle/new-chat send (%s)', (queuedWhileBusy) => {
        const message = { ...base, pending: true, meta: { queuedWhileBusy } };
        const renderer = render(message);
        const body = renderer.root.findByType('LongPressCopyable').parent.parent;
        expect(labels(renderer)).toEqual([]);
        expect(body.props.style).not.toContainEqual({ opacity: 0.45 });

        render({ ...message, pending: false }, renderer);
        expect(labels(renderer)).toEqual([]);
        expect(renderer.root.findByType('LongPressCopyable').parent.parent).toBe(body);
    });

    it.each([undefined, false])('shows Sending after the grace period when an idle/new-chat send is still unacknowledged (%s)', (queuedWhileBusy) => {
        vi.useFakeTimers();
        const message = { ...base, createdAt: Date.now(), pending: true, meta: { queuedWhileBusy } };
        const renderer = render(message);
        const body = renderer.root.findByType('LongPressCopyable').parent.parent;
        expect(labels(renderer)).toEqual([]);

        act(() => vi.advanceTimersByTime(999));
        expect(labels(renderer)).toEqual([]);
        act(() => vi.advanceTimersByTime(1));
        expect(labels(renderer)).toContain('message.sending');
        expect(renderer.root.findByType('LongPressCopyable').parent.parent).toBe(body);

        render({ ...message, pending: false }, renderer);
        expect(labels(renderer)).toEqual([]);
    });

    it.each([
        'hello',
        '<command-name>/review</command-name><command-message>review</command-message><command-args>changes</command-args>',
        '<command-name>/goal</command-name><command-message>goal</command-message><command-args>ship it</command-args>',
    ])('shows the busy-send status until acceptance and preserves the bubble (%s)', (text) => {
        const message = { ...base, text, pending: true, meta: { queuedWhileBusy: true } };
        const renderer = render(message);
        const bubble = renderer.root.findByType('LongPressCopyable');
        expect(labels(renderer)).toContain('message.sendsAfterThisTurn');
        expect(labels(renderer)).not.toContain('message.sending');

        render({ ...message, pending: false }, renderer);
        expect(labels(renderer)).not.toContain('message.sendsAfterThisTurn');
        expect(renderer.root.findByType('LongPressCopyable')).toBe(bubble);
    });

    it('puts the other participant’s name above their message', () => {
        const renderer = render({ ...base, author: { id: 'other', name: 'Alex', owner: false } });
        const author = renderer.root.findByType('Text');
        expect(author.props.children).toBe('Alex');
        const container = author.parent.parent;
        expect(container.children[0]).toBe(author.parent);
        expect(container.children[1].findByType('MarkdownView').props.markdown).toBe('hello');
    });

    it.each([undefined, { id: 'owner', name: 'You', owner: true }])('does not label the reader’s own messages (%j)', (author) => {
        expect(labels(render({ ...base, author }))).toEqual([]);
    });

    it('still shows send failures for an idle send', () => {
        expect(labels(render({ ...base, sendError: 'Unavailable', meta: { queuedWhileBusy: false } })))
            .toContain('message.sendFailed');
    });
});