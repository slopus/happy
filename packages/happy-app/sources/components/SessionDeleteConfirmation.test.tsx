import * as React from 'react';
import { act } from 'react';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import TestRenderer from 'react-test-renderer';
import { afterEach, expect, it, vi } from 'vitest';
import { SessionDeleteConfirmation } from './SessionDeleteConfirmation';

vi.mock('react-native', () => ({
    Platform: { OS: 'web' }, Modal: 'Modal', Pressable: 'Pressable', Text: 'Text', View: 'View',
    useWindowDimensions: () => ({ width: 400, height: 900 }),
}));
vi.mock('react-native-unistyles', () => ({
    StyleSheet: { create: (factory: any) => factory({ colors: { shadow: {}, status: {} } }) },
}));
vi.mock('@/constants/Typography', () => ({ Typography: { default: () => ({}) } }));
vi.mock('@/text', () => ({ t: (key: string) => key }));
let renderer: any;
afterEach(() => { if (renderer) act(() => renderer.unmount()); renderer = undefined; vi.unstubAllGlobals(); });
it('fits near a bottom-edge row, supports Escape, and removes global listeners', () => {
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
    const listeners = new Map<string, EventListener>();
    const events = { dispatchEvent: (event: Event) => listeners.get(event.type)?.(event) };
    const focus = vi.fn();
    vi.stubGlobal('document', {
        activeElement: { isConnected: true, focus },
        addEventListener: (name: string, handler: EventListener) => listeners.set(name, handler),
        removeEventListener: (name: string, handler: EventListener) => {
            if (listeners.get(name) === handler) listeners.delete(name);
        },
    });
    const cancel = vi.fn();
    act(() => { renderer = TestRenderer.create(<SessionDeleteConfirmation
        anchor={{ type: 'rect', x: 370, y: 850, width: 24, height: 24 }} onCancel={cancel} onConfirm={vi.fn()} />); });
    const card = renderer.root.findAll((node: any) => node.type === 'View' && node.props.testID === 'session-delete-confirmation')[0];
    act(() => card.props.onLayout({ nativeEvent: { layout: { height: 40 } } }));
    expect(card.props.style[1]).toMatchObject({ left: 232, top: 800, width: 156 });
    const escape = new Event('keydown', { cancelable: true });
    Object.defineProperty(escape, 'key', { value: 'Escape' });
    act(() => events.dispatchEvent(escape));
    expect(cancel).toHaveBeenCalledOnce();
    act(() => renderer.unmount()); renderer = undefined;
    expect(focus).toHaveBeenCalledOnce();
    events.dispatchEvent(escape);
    expect(cancel).toHaveBeenCalledOnce();
});
it('guards against repeated confirmation clicks', () => {
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
    const confirm = vi.fn();
    act(() => { renderer = TestRenderer.create(<SessionDeleteConfirmation anchor={{ type: 'point', x: 200, y: 200 }} onCancel={vi.fn()} onConfirm={confirm} />); });
    expect(renderer.root.findAllByType('Text').map((node: any) => node.props.children)).toEqual(['common.cancel', 'common.delete']);
    const button = renderer.root.findAll((node: any) => node.type === 'Pressable' && node.props.testID === 'session-delete-confirm')[0];
    act(() => { button.props.onPress({ stopPropagation() {} }); button.props.onPress({ stopPropagation() {} }); });
    expect(confirm).toHaveBeenCalledOnce();
});
