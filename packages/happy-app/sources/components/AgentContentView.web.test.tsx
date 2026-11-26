import * as React from 'react';
import { act } from 'react';
import { afterEach, expect, it, vi } from 'vitest';
// @ts-expect-error react-test-renderer does not publish declarations.
import TestRenderer from 'react-test-renderer';
import { AgentContentView } from './AgentContentView.web';
import { useChatComposerOverlayInset } from './ChatComposerOverlayContext';

vi.mock('react-native', () => ({ View: 'View' }));
vi.mock('react-native-gesture-handler', () => ({ ScrollView: 'ScrollView' }));
vi.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ top: 0 }) }));
vi.mock('@/utils/responsive', () => ({ useHeaderHeight: () => 0 }));
vi.mock('react-native-unistyles', () => ({ StyleSheet: { create: (factory: () => object) => factory() } }));

function TranscriptProbe() {
    return <output data-inset={useChatComposerOverlayInset()} />;
}

afterEach(() => { delete (globalThis as any).IS_REACT_ACT_ENVIRONMENT; });

it('reserves the measured input stack only in its own conversation and clears it without an input', async () => {
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
    const render = (input: React.ReactNode) => <>
        <AgentContentView input={input} content={<TranscriptProbe />} placeholder={<span>empty</span>} />
        <TranscriptProbe />
    </>;
    let renderer: any;
    await act(async () => { renderer = TestRenderer.create(render(<textarea />)); });
    const insets = () => renderer.root.findAllByType('output').map((node: any) => node.props['data-inset']);
    act(() => renderer.root.findByProps({ testID: 'agent-composer-overlay' }).props.onLayout({
        nativeEvent: { layout: { height: 165.2 } },
    }));
    expect(insets()).toEqual([166, 0]);
    expect(renderer.root.findByProps({ testID: 'agent-placeholder-scroll' }).props.contentContainerStyle)
        .toContainEqual({ paddingBottom: 166 });
    act(() => renderer.root.findByProps({ testID: 'agent-composer-overlay' }).props.onLayout({
        nativeEvent: { layout: { height: 302 } },
    }));
    expect(insets()).toEqual([302, 0]);
    act(() => renderer.update(render(null)));
    expect(insets()).toEqual([0, 0]);
    act(() => renderer.unmount());
});
