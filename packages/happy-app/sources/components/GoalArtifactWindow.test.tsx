// @vitest-environment jsdom
import * as React from 'react';
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import TestRenderer from 'react-test-renderer';
import { GoalArtifactWindow } from './GoalArtifactWindow';

const mocks = vi.hoisted(() => ({ width: 1440, height: 900, focus: vi.fn() }));
vi.mock('react-native', () => ({
    Platform: { OS: 'web' }, Modal: 'Modal', View: 'View', Pressable: 'Pressable',
    useWindowDimensions: () => ({ width: mocks.width, height: mocks.height }),
}));
vi.mock('react-native-unistyles', () => ({ useUnistyles: () => ({ theme: { colors: {
    surface: 'surface', divider: 'divider', modal: { backdrop: 'backdrop' }, shadow: { color: 'shadow', opacity: 0.2 },
} } }) }));
vi.mock('./GoalArtifactViewer', () => ({ GoalArtifactViewer: (props: any) => (
    <><Pressable ref={props.closeButtonRef} testID="reader-close" onPress={props.onClose} /><View testID="reader-body" {...props} /></>
) }));
vi.mock('react-native-gesture-handler', () => ({ GestureHandlerRootView: 'GestureHandlerRootView' }));
vi.mock('./SessionImageViewer', () => ({ SessionImageViewer: (props: any) => <View testID="reader-image" {...props} /> }));
import { Platform, Pressable, View } from 'react-native';
const props = { sessionId: 's1', featurePath: '/feature', task: { id: 't1' } as any,
    artifact: { id: 'a1', name: '原始报告.md' } as any, onClose: vi.fn() };
let renderer: any;
let readerRoot: HTMLElement;
let imageOpener: HTMLButtonElement;
beforeEach(() => {
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
    readerRoot = document.createElement('div'); imageOpener = document.createElement('button');
    readerRoot.append(imageOpener); document.body.append(readerRoot);
    (Platform as { OS: string }).OS = 'web';
    mocks.width = 1440; mocks.height = 900; mocks.focus.mockClear(); props.onClose.mockClear();
});
afterEach(() => { act(() => renderer?.unmount()); readerRoot.remove(); });
function mount() {
    act(() => { renderer = TestRenderer.create(<GoalArtifactWindow {...props} />, {
        createNodeMock: (node: any) => node.props.testID === 'reader-close' ? { focus: mocks.focus } : node.props.testID === 'goal-artifact-window' ? readerRoot : null,
    }); });
}
describe('GoalArtifactWindow', () => {
    it('owns modal dismissal and initial focus while keeping the original reader', () => {
        mount();
        const modal = renderer.root.findByType('Modal');
        expect(modal.props).toMatchObject({ visible: true, transparent: true, accessibilityLabel: '原始报告.md' });
        act(() => modal.props.onShow());
        expect(mocks.focus).toHaveBeenCalledOnce();
        expect(renderer.root.findByProps({ testID: 'reader-body' }).props).toMatchObject(props);
        act(() => modal.props.onRequestClose());
        expect(props.onClose).toHaveBeenCalledOnce();
    });
    it('dismisses from the backdrop or close control, with the body outside the backdrop', () => {
        mount();
        const backdrop = renderer.root.findByProps({ testID: 'goal-artifact-backdrop' });
        expect(backdrop.findAllByProps({ testID: 'reader-body' })).toHaveLength(0);
        act(() => backdrop.props.onResponderRelease());
        act(() => renderer.root.findByProps({ testID: 'reader-close' }).props.onPress());
        expect(props.onClose).toHaveBeenCalledTimes(2);
    });
    it('keeps image preview in the same Modal and consumes the complete Escape gesture', () => {
        mount();
        const reader = renderer.root.findByProps({ testID: 'reader-body' });
        imageOpener.focus();
        const image = { uri: 'test.png', attachmentRef: 'ref', sessionId: 's1' };
        act(() => reader.props.onOpenImage(image));
        expect(renderer.root.findAllByType('Modal')).toHaveLength(1);
        const preview = renderer.root.findByProps({ testID: 'reader-image' });
        expect(preview.props).toMatchObject({ sources: [image], initialIndex: 0, paginate: false });
        expect(renderer.root.findByProps({ testID: 'goal-artifact-window' }).props.style.display).toBe('none');
        // ImageViewer handles keydown. RN Web Modal receives keyup after the image has closed.
        act(() => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })));
        act(() => preview.props.onClose());
        act(() => renderer.root.findByType('Modal').props.onRequestClose());
        expect(props.onClose).not.toHaveBeenCalled();
        expect(renderer.root.findByProps({ testID: 'reader-body' })).toBe(reader);
        expect(document.activeElement).toBe(imageOpener);
        // A separate Escape gesture from the reader may now dismiss it.
        act(() => imageOpener.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
        act(() => renderer.root.findByType('Modal').props.onRequestClose());
        expect(props.onClose).toHaveBeenCalledOnce();
    });
    it('uses native Back to leave image preview before closing the document', () => {
        (Platform as { OS: string }).OS = 'ios';
        mount();
        act(() => renderer.root.findByProps({ testID: 'reader-body' }).props.onOpenImage({ uri: 'test.png' }));
        act(() => renderer.root.findByType('Modal').props.onRequestClose());
        expect(renderer.root.findAllByProps({ testID: 'reader-image' })).toHaveLength(0);
        expect(props.onClose).not.toHaveBeenCalled();
        act(() => renderer.root.findByType('Modal').props.onRequestClose());
        expect(props.onClose).toHaveBeenCalledOnce();
    });
    it('keeps a bounded window and fits a resized short viewport', () => {
        mount();
        const dialog = () => renderer.root.findByProps({ testID: 'goal-artifact-window' });
        expect(dialog().props.style).toMatchObject({ maxWidth: 1120, height: 800, width: '100%', overflow: 'hidden' });
        mocks.height = 460;
        act(() => renderer.update(<GoalArtifactWindow {...props} onClose={() => props.onClose()} />));
        expect(dialog().props.style.height).toBe(412);
    });
});
