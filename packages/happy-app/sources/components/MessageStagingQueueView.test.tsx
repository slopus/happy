import * as React from 'react';
import { act } from 'react';
import { expect, it, vi } from 'vitest';
import { MessageStagingQueueView } from './MessageStagingQueueView';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import TestRenderer from 'react-test-renderer';
vi.mock('react-native', () => ({ View: 'View', Text: 'Text', ScrollView: 'ScrollView', Pressable: 'Pressable', ActivityIndicator: 'ActivityIndicator' }));
vi.mock('@expo/vector-icons', () => ({ Ionicons: 'Ionicons' }));
vi.mock('react-native-unistyles', () => ({ StyleSheet: { create: (f: any) => f({ colors: {} }) }, useUnistyles: () => ({ theme: { colors: {} } }) }));
vi.mock('@/text', () => ({ t: (key: string) => key }));
vi.mock('./SubmittedAttachmentPreview', () => ({ SubmittedAttachmentPreview: 'SubmittedAttachmentPreview' }));

it('shows sending text together with its attachment previews while the transfer is pending', () => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    const images: any[] = [{ id: 'one', name: 'photo.png', uri: 'file:///photo.png', width: 100, height: 100, size: 10, mimeType: 'image/png' }];
    let renderer: any;
    act(() => { renderer = TestRenderer.create(<MessageStagingQueueView messages={[{ id: 'm', sessionId: 's', text: 'hello', attachments: images, modeMeta: {}, status: 'sending' }]} session={{ connected: true, state: 'idle' }} onEdit={vi.fn()} onSteer={vi.fn()} onRemove={vi.fn()} />); });
    expect(renderer.root.findByType('SubmittedAttachmentPreview').props.images).toEqual(images);
    expect(renderer.root.findAllByType('Text').some((n: any) => n.props.children === 'hello')).toBe(true);
    act(() => renderer.unmount());
});

it('marks restored expired attachments for reselection and disables sending', () => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    let renderer: any;
    act(() => { renderer = TestRenderer.create(<MessageStagingQueueView messages={[{ id: 'm', sessionId: 's', text: 'hello', attachments: [{ id: 'f', uri: 'blob:expired', name: 'a.txt', size: 1, width: 0, height: 0, mimeType: 'text/plain', kind: 'file' }], attachmentsExpired: true, modeMeta: {}, status: 'failed' }]} session={{ connected: true, state: 'idle' }} onEdit={vi.fn()} onSteer={vi.fn()} onRemove={vi.fn()} />); });
    expect(renderer.root.findAllByType('SubmittedAttachmentPreview')).toHaveLength(0);
    expect(renderer.root.findAllByType('Text').some((n: any) => JSON.stringify(n.props.children).includes('messageQueue.attachmentsExpired'))).toBe(true);
    expect(renderer.root.findAllByType('Pressable')[0].props.disabled).toBe(true);
    act(() => renderer.unmount());
});
