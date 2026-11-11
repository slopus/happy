import * as React from 'react';
import { act } from 'react';
// @ts-expect-error react-test-renderer 未提供类型声明。
import TestRenderer from 'react-test-renderer';
import { expect, it, vi } from 'vitest';
import type { ArtifactReadResult } from '@slopus/happy-wire';
import type { VersionController } from './versionController';

vi.mock('react-native', () => ({ View: 'View', ScrollView: 'ScrollView', ActivityIndicator: 'ActivityIndicator' }));
vi.mock('@/components/markdown/MarkdownView', () => ({ MarkdownView: 'MarkdownView' }));
vi.mock('@/components/markdown/parseMarkdown', () => ({ parseReadOnlyMarkdown: () => [{ type: 'image', url: './photo.png' }] }));
vi.mock('./HtmlFilePreview', () => ({ HtmlFilePreview: 'HtmlFilePreview' }));
import { AnnotatableFile } from '@/components/annotations/MessageAnnotations';
import { ArtifactPreview } from './ArtifactPreview';

it('keeps Markdown readable while immutable image resources are still loading', async () => {
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
    const reader = vi.fn(() => new Promise<Uint8Array>(() => {}));
    const versions = { root: '/project', reader: () => reader } as unknown as VersionController;
    const value = {
        artifact: { kind: 'markdown' },
        entryContent: '# Ready\n![Photo](./photo.png)',
        manifest: { entryPath: 'doc.md', files: [{ path: 'photo.png', mime: 'image/png' }] },
    } as unknown as ArtifactReadResult;
    const onReady = vi.fn();
    let renderer: any;
    await act(async () => { renderer = TestRenderer.create(<ArtifactPreview sessionId="session" versions={versions} value={value} onReady={onReady} annotationFile={{ path: '/project/doc.md', hash: 'frozen-baseline' }} />); });
    try {
        expect(reader).toHaveBeenCalledWith('/project/photo.png');
        expect(renderer.root.findByType(AnnotatableFile).props.file).toEqual({ path: '/project/doc.md', hash: 'frozen-baseline' });
        expect(renderer.root.findByType('MarkdownView').props.markdown).toBe(value.entryContent);
        expect(renderer.root.findAllByType('ActivityIndicator')).toHaveLength(0);
        expect(onReady).not.toHaveBeenCalledWith(true);
    } finally {
        await act(async () => { renderer.unmount(); });
    }
});
